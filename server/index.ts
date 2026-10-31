import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, extname, normalize, resolve, sep } from 'node:path';
import { CONFIG_PATH, PACKAGE_ROOT, STATE_PATH, WEB_DIST } from './paths.ts';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { loadState, saveState, emptySnapshot } from './state.ts';
import { refresh } from './refresh.ts';
import { applyAction } from './actions.ts';
import { performWrite, autoTransitionMergedCards } from './writeback.ts';
import { writePidFile, newApiToken, writeApiToken, apiTokenPath, TOKEN_HEADER } from './transport.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config, State, Snapshot } from './types.ts';

// Server-side poll cadence when config.json doesn't set refreshIntervalSeconds.
// 2 minutes keeps a busy repo list well inside GitHub's 5000 req/hr budget.
const DEFAULT_REFRESH_INTERVAL_SECONDS = 120;

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };

export class BodyTooLarge extends Error {}

export const MAX_BODY_BYTES = 1_000_000;

// Collect raw Buffers and decode once: `s += chunk` decodes each chunk on its
// own, so a multi-byte UTF-8 character split across a chunk boundary turns
// into U+FFFD, and a string-length cap counts UTF-16 units, not bytes.
export async function readBody(req: AsyncIterable<Buffer | string>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
    total += buf.length;
    // Real bodies here are tiny JSON; without a ceiling any local process
    // could balloon the heap with one giant POST.
    if (total > MAX_BODY_BYTES) throw new BodyTooLarge('body too large');
    chunks.push(buf);
  }
  const s = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(s || '{}') as Record<string, unknown>;
}

// The deliberate size limit must be distinguishable from a malformed body
// and from a server bug: 413 for the former, 400 for bad JSON, never the
// generic 500.
function bodyError(e: unknown): { status: number; error: string } {
  return e instanceof BodyTooLarge
    ? { status: 413, error: 'body too large' }
    : { status: 400, error: 'invalid JSON body' };
}

// DNS-rebinding protection for every /api/* route, reads included. Host
// header must be this exact loopback address plus the port this TCP
// connection actually landed on (req.socket.localPort, not config.port —
// those can differ, e.g. config.port: 0 in tests). Binding to 127.0.0.1
// does NOT defend against rebinding on its own: the attacker's page keeps
// the origin string "evil.com" while its DNS re-points to loopback, so the
// browser treats the fetch as same-origin (no CORS check) and the page can
// read the response body. GET /api/data was previously exempt from any
// guard at all — a read-only endpoint is exactly what rebinding targets
// (confidentiality, not mutation), so it needs this check just as much as
// the POST routes do.
// Constant-time token comparison; length differs → not equal.
const sameToken = (a: string | undefined, b: string): boolean => {
  if (!a) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const headerValue = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};
const headerToken = (req: IncomingMessage): string | undefined => headerValue(req, TOKEN_HEADER);
const SESSION_HEADER = 'x-devhud-session';
// Browser sessions held at once; the oldest is dropped past this.
const MAX_SESSIONS = 32;

function guardHost(req: IncomingMessage): { status: number; error: string } | null {
  const host = (req.headers.host ?? '').toLowerCase();
  const port = req.socket.localPort;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { status: 403, error: 'invalid Host header' };
  }
  return null;
}

// Drive-by CSRF protection for the three mutating POST /api/* endpoints.
// Content-Type must be application/json. None of the CORS-safelisted
// content types (text/plain, multipart/form-data,
// application/x-www-form-urlencoded) qualify as JSON, so any real
// cross-origin caller needs a CORS preflight first — and this server never
// sends Access-Control-Allow-Origin, so the browser never lets the actual
// request through. This is what stops a "simple request" CSRF from any
// page the user happens to have open. (The Host check that used to live
// here too is now guardHost, applied to every /api/* route, not just
// mutating ones — see that function's comment.)
function guardMutation(req: IncomingMessage): { status: number; error: string } | null {
  const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return { status: 415, error: 'Content-Type must be application/json' };
  }
  return null;
}

// Per-stream buffering bound for SSE. The client cap bounds stream count,
// not what each stream holds: res.write() never refuses data, it just
// returns false and queues in heap, so one stalled consumer (a suspended
// laptop tab with a full TCP window) would accumulate every future snapshot.
// 4 MB lets a couple of large snapshots queue through a brief hiccup; worst
// case stays ~32 streams × (cap + one snapshot).
export const SSE_MAX_BUFFERED_BYTES = 4_000_000;

// The subset of ServerResponse the SSE fan-out uses, so tests can drive the
// backpressure policy with a fake whose buffer never empties.
export interface SseClient {
  write(chunk: string): boolean;
  destroy(): unknown;
  readonly destroyed: boolean;
  readonly writableLength: number;
}

// Backpressure policy: before each write, a client already buffering more
// than SSE_MAX_BUFFERED_BYTES is destroyed and dropped instead of queued
// another snapshot. Deliberately not "drop if write() returned false last
// time": a snapshot over the 16 KB highWaterMark makes write() return false
// even for a healthy tab, and back-to-back broadcasts (ack then move, an
// action right after a refresh) land within milliseconds. Nothing is lost
// by dropping: EventSource / useData()'s backoff reconnects, and
// /api/events sends the current snapshot on connect.
export function createSseFanout<C extends SseClient>() {
  const clients = new Set<C>();
  const drop = (client: C) => {
    clients.delete(client);
    try { client.destroy(); } catch { /* already torn down */ }
  };
  const writeTo = (client: C, msg: string) => {
    if (client.writableLength > SSE_MAX_BUFFERED_BYTES) return drop(client);
    client.write(msg);
  };
  return {
    clients,
    // Connect replay counts toward the cap like any other event.
    add(client: C, msg: string) {
      clients.add(client);
      writeTo(client, msg);
    },
    remove(client: C) {
      clients.delete(client);
    },
    broadcast(msg: string) {
      for (const client of clients) {
        // Per-client isolation: one torn-down socket (destroyed between its
        // teardown and its 'close' event) must not abort the fan-out for the
        // rest, nor turn an already-saved refresh into a 500.
        try {
          if (!client.destroyed) writeTo(client, msg);
        } catch {
          clients.delete(client);
        }
      }
    },
    closeAll() {
      for (const client of clients) client.destroy();
      clients.clear();
    },
  };
}

// `refreshFn` defaults to the real refresh() and exists so tests can drive
// the scheduled loop (short interval + stub) without network or module
// mocking — same convention as performWrite's refreshFn.
// `autoTransitionFn` is injectable for the same reason (M5 ordering tests).
export function createServer({ config, statePath, webDist, configPath, refreshFn = refresh, autoTransitionFn = autoTransitionMergedCards, apiToken }: {
  config: Config; statePath: string; webDist: string; configPath?: string; refreshFn?: typeof refresh;
  autoTransitionFn?: typeof autoTransitionMergedCards;
  // When set, every /api/* request must carry it (x-devhud-token header or
  // the devhud_token cookie) and the dashboard page needs the cookie. The
  // real server always sets it (main below); omitted only by tests that
  // exercise everything else.
  apiToken?: string;
}): http.Server {
  // Browser sessions are separate random values, never the API token, and
  // are sent as a header (not a cookie: cookies go to every port on
  // localhost, so any local service the browser visits would receive one).
  // The page keeps its session in localStorage, which is per origin and so
  // per port. A browser gets one by trading a one-time login code that
  // `devhud open` mints with the token; the token itself never goes into a
  // URL, argv or a log. EventSource can't set headers, so /api/events also
  // takes the session as a query parameter (the request log omits queries).
  const sessions = new Set<string>();
  const loginCodes = new Map<string, number>(); // code -> expiry (ms)
  // Codes already traded, with the session each produced, for
  // SPENT_CODE_WINDOW_MS after the trade. The code passes through the `open`
  // command's argv, which other local users can read; if one races the
  // browser and claims it first, the browser's own claim lands here and
  // revokes that session. The window is a trade-off: too short and a slow
  // browser claim misses a theft; for a session's whole life and anyone who
  // once saw the code could revoke the user's session at will later.
  const spentCodes = new Map<string, { session: string; until: number }>();
  const SPENT_CODE_WINDOW_MS = 5 * 60_000;
  const LOGIN_CODE_TTL_MS = 60_000;
  const isSession = (s: string | null | undefined): boolean => !!s && [...sessions].some(v => sameToken(s, v));
  const authorized = (req: IncomingMessage, url: URL): boolean =>
    !apiToken || sameToken(headerToken(req), apiToken) || isSession(headerValue(req, SESSION_HEADER))
    || (url.pathname === '/api/events' && isSession(url.searchParams.get('session')));
  // The in-memory `state` object is the single source of truth for the
  // life of the process; disk (statePath) is write-through only. Loading
  // once here (instead of per-request) avoids a lost-update race between
  // concurrent /api/refresh and /api/action calls: every handler below
  // mutates this one shared object, and each handler's mutate+save section
  // runs synchronously (no `await` in between), so interleaving can only
  // happen at an `await` boundary, at which point no partial mutation is
  // ever visible to the next handler.
  const state: State = loadState(statePath);
  // Live-update push channel: every open GET /api/events response. Written
  // to after each refresh (server loop or manual) and each mutation, so all
  // tabs stay in sync without polling.
  // Slow consumers are dropped, not buffered without bound (createSseFanout).
  const sse = createSseFanout<ServerResponse>();
  // Only broadcast when content actually changed: updatedAt bumps on every
  // refresh even when nothing else did, so comparing the snapshot minus
  // updatedAt suppresses the every-tick full-board re-render in idle tabs.
  // Mutation call sites (action/write) always pass force — their change is
  // in-place and must reach other tabs even if serialization raced.
  let lastBroadcastBody = '';
  const broadcast = (snapshot: Snapshot, { force = false } = {}) => {
    const body = JSON.stringify({ ...snapshot, updatedAt: null });
    // Suppressed tick still sends a named "tick" event carrying just the
    // fresh updatedAt: the header's "Updated Xm ago" renders exactly that
    // field, and with no event at all an idle board's label froze at the
    // last content change instead of the last successful check.
    const suppressed = !force && body === lastBroadcastBody;
    const msg = suppressed
      ? `event: tick\ndata: ${JSON.stringify({ updatedAt: snapshot.updatedAt })}\n\n`
      : `data: ${JSON.stringify(snapshot)}\n\n`;
    if (!suppressed) lastBroadcastBody = body;
    sse.broadcast(msg);
  };
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${(req.url ?? '').split('?')[0]} ${res.statusCode} ${Date.now() - start}ms`);
    });
    const send = (code: number, obj: unknown) => { if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.startsWith('/api/')) {
        const hostErr = guardHost(req);
        if (hostErr) return send(hostErr.status, { error: hostErr.error });
      }
      // The one /api route that needs no credential: the one-time code is the
      // credential. Single use, 60 s, minted only with the token (below).
      if (apiToken && url.pathname === '/api/session' && req.method === 'POST') {
        const guardErr = guardMutation(req);
        if (guardErr) return send(guardErr.status, { error: guardErr.error });
        let body: Record<string, unknown>;
        try { body = await readBody(req); } catch (e) { const be = bodyError(e); return send(be.status, { error: be.error }); }
        const code = typeof body.code === 'string' ? body.code : '';
        const now = Date.now();
        const exp = loginCodes.get(code);
        loginCodes.delete(code);
        if (!exp || exp < now) {
          const spent = spentCodes.get(code);
          if (spent && spent.until >= now) {
            spentCodes.delete(code);
            sessions.delete(spent.session);
            console.error('devhud: a login code was claimed twice; the first session is revoked (another local process may have read it)');
            return send(409, { error: 'this login link was already used by another client, and that session has been revoked; run `devhud open` again' });
          }
          return send(401, { error: 'login code invalid or expired; run `devhud open` again' });
        }
        const session = randomBytes(32).toString('base64url');
        sessions.add(session);
        for (const [c, s] of spentCodes) if (s.until < now) spentCodes.delete(c);
        spentCodes.set(code, { session, until: now + SPENT_CODE_WINDOW_MS });
        if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.values().next().value!);
        return send(200, { session });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req, url)) return send(401, { error: 'missing or invalid devhud token; run `devhud open` for the dashboard (the CLI and MCP read it automatically)' });
      }
      // `devhud open` (holding the token) asks for a one-time login code.
      if (apiToken && url.pathname === '/api/login-code' && req.method === 'POST') {
        if (!sameToken(headerToken(req), apiToken)) return send(401, { error: 'login codes need the API token header' });
        const now = Date.now();
        for (const [c, exp] of loginCodes) if (exp < now) loginCodes.delete(c);
        const code = randomBytes(24).toString('base64url');
        loginCodes.set(code, now + LOGIN_CODE_TTL_MS);
        return send(200, { code });
      }
      if (url.pathname === '/api/data' && req.method === 'GET') {
        return send(200, state.snapshot ?? emptySnapshot());
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        // Cap held-open streams: per-stream buffering is bounded by
        // createSseFanout, but an unbounded stream count is still a local
        // memory-DoS vector. 32 covers any realistic number of own tabs.
        if (sse.clients.size >= 32) return send(503, { error: 'too many event streams' });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        // Current snapshot immediately on connect: the client renders from
        // this event alone, no separate /api/data fetch needed, and an
        // EventSource auto-reconnect (laptop wake, server restart) re-syncs
        // the same way.
        sse.add(res, `data: ${JSON.stringify(state.snapshot ?? emptySnapshot())}\n\n`);
        res.on('close', () => sse.remove(res));
        // Async write failures on a held-open response otherwise surface as
        // unhandled 'error' emissions and crash the process.
        res.on('error', () => sse.remove(res));
        return; // held open; broadcast() writes future events
      }
      if (url.pathname === '/api/refresh' && req.method === 'POST') {
        const guardErr = guardMutation(req);
        if (guardErr) return send(guardErr.status, { error: guardErr.error });
        const payload = await refreshFn({ config, state });
        saveState(statePath, state);
        broadcast(payload);
        return send(200, payload);
      }
      if (url.pathname === '/api/action' && req.method === 'POST') {
        const guardErr = guardMutation(req);
        if (guardErr) return send(guardErr.status, { error: guardErr.error });
        let body: Record<string, unknown>;
        try {
          body = await readBody(req);
        } catch (e) {
          const be = bodyError(e);
          return send(be.status, { error: be.error });
        }
        const { type, key, bucket, reason } = body as { type?: string; key?: unknown; bucket?: string; reason?: unknown };
        const result = applyAction({ state, config, type: type ?? '', key, bucket, reason });
        if ('error' in result) return send(result.status ?? 400, { error: result.error });
        try {
          saveState(statePath, state);
        } catch (e) {
          // applyAction already mutated the in-memory board, so memory and
          // disk now diverge: the served snapshot shows the action applied,
          // but a restart silently reverts it (ack/move bounce back). Name
          // that explicitly instead of dying in the generic handler catch.
          console.error(`devhud: action ${type} on ${String(key)} applied in memory but saveState failed — memory and disk have diverged:`, e);
          return send(500, { error: 'action applied but could not be saved; it will revert on restart' });
        }
        // Actions (drag overrides, dismissals) mutate the snapshot in place;
        // push so every other tab reflects the change immediately. After the
        // save: other tabs shouldn't see a change that will revert on restart.
        if (state.snapshot) broadcast(state.snapshot, { force: true });
        return send(200, result);
      }
      if (url.pathname === '/api/write' && req.method === 'POST') {
        const guardErr = guardMutation(req);
        if (guardErr) return send(guardErr.status, { error: guardErr.error });
        let body: Record<string, unknown>;
        try {
          body = await readBody(req);
        } catch (e) {
          const be = bodyError(e);
          return send(be.status, { error: be.error });
        }
        // Explicit destructure, not `...body`: a spread would let a client
        // smuggle arbitrary keys (e.g. "config"/"state") into performWrite's
        // named parameters, potentially overriding config/state entirely.
        const { type, key, repo, number, body: text, status, source } = body as {
          type?: string; key?: string; repo?: string; number?: number; body?: string; status?: string; source?: unknown;
        };
        const result = await performWrite({ state, type: type ?? '', key, repo, number, body: text, status, configPath, source: source === 'mcp' ? 'mcp' : undefined });
        if ('error' in result) return send(result.status ?? 400, { error: result.error });
        // The write already happened in Jira/GitHub: a failed local save must
        // not turn into a 500 that invites a retry (and a double post). Same
        // treatment as direct mode in ops.ts.
        let saveBlockedError: string | undefined;
        if (!('demo' in result && result.demo)) {
          try { saveState(statePath, state); } catch (e) {
            saveBlockedError = (e as Error).message;
            console.error('devhud: write succeeded but saveState failed:', e);
          }
        }
        if (state.snapshot) broadcast(state.snapshot, { force: true });
        return send(200, saveBlockedError ? { ...result, saveBlockedError } : result);
      }
      if (url.pathname.startsWith('/api/')) {
        return send(404, { error: 'not found' });
      }
      // static
      const root = resolve(webDist);
      const file = normalize(url.pathname).replace(/^([/\\])+/, '');
      let p = resolve(root, file);
      if (p !== root && !p.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
      try {
        const stat = statSync(p);
        if (!stat.isFile() || file === '') throw new Error();
      } catch {
        p = resolve(root, 'index.html');
      }
      const buf = readFileSync(p);
      // Response-side hardening. 'unsafe-inline' is required by the
      // pre-paint theme <script> in index.html and inline style attributes,
      // so this CSP doesn't stop injected inline code — what it does buy is
      // exfil resistance (no external script/style/img/connect targets) and
      // no framing. Primary XSS defense remains Preact's text escaping.
      res.writeHead(200, {
        'content-type': MIME[extname(p)] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      });
      res.end(buf);
    } catch (e) {
      // One handler covers both API and static branches, so it can't tell
      // an authored error message (safe to show) from a runtime one (a
      // filesystem error can carry an absolute path, e.g. ENOENT on a
      // symlink target). Log the real error server-side; the client only
      // ever sees a generic message.
      console.error(`${req.method} ${req.url}: ${(e as Error).stack ?? (e as Error).message}`);
      send(500, { error: 'internal error' });
    }
  });
  // Server-owned poll loop: freshness no longer depends on a browser tab
  // being open and focused (background tabs throttle timers), and N tabs
  // cost one Jira/GitHub sweep instead of N. unref() keeps this timer from
  // holding the process (or a test run) alive on its own.
  const intervalMs = (config.refreshIntervalSeconds ?? DEFAULT_REFRESH_INTERVAL_SECONDS) * 1000;
  // Self-rescheduling timeout, not setInterval: a sweep slower than the
  // interval (many repos, cold ETag cache) must not overlap itself — refresh()
  // serializes concurrent calls per state, which protects snapshot ordering
  // but would still double the API spend. The next tick arms only after the current one completes.
  let timer: NodeJS.Timeout;
  let closed = false;
  const tick = async () => {
    try {
      let snapshot = await refreshFn({ config, state });
      // Auto-transition merged cards if configured, BEFORE the save and the
      // broadcast (M5): broadcasting first showed a just-moved card in Needs
      // Attention (and notified hidden tabs about it) for a whole interval.
      // Direct transitionCard() calls (not performWrite) avoid one refresh
      // per card; instead, if anything moved, one more refresh picks up the
      // new statuses so the save and broadcast below reflect them. Per-card
      // errors are caught inside the function; this try-catch guards against
      // unexpected throws so the tick still saves and broadcasts.
      try {
        const auto = await autoTransitionFn({ state, configPath });
        if (auto.succeeded > 0) snapshot = await refreshFn({ config, state });
      } catch (e) {
        console.error('auto-transition batch failed unexpectedly:', e);
      }
      // Save failure isolated from the broadcast: refresh() already updated
      // the in-memory snapshot (which /api/data serves), so skipping the
      // broadcast would leave every tab permanently stale over a disk-full/
      // permissions problem that repeats each tick. Unlike /api/action's
      // save-then-broadcast rule this is not a user mutation that could
      // silently revert — it re-fetches identically on the next tick.
      // The save also persists the auto-transition ledger.
      try {
        saveState(statePath, state);
      } catch (e) {
        console.error('scheduled refresh saved nothing (memory is fresh, disk is stale):', e);
      }
      // state.snapshot, not the local: a /api/refresh or action that landed
      // while auto-transition awaited Jira already replaced it, and
      // broadcasting the older local regressed every tab.
      broadcast(state.snapshot ?? snapshot);
    } catch (e) {
      // Keep the loop alive: a transient Jira/GitHub outage shouldn't kill
      // live updates for the rest of the process lifetime. Full error object
      // (not just message): what lands here is saveState-class faults and
      // code bugs, and a recurring bare message every tick is undiagnosable.
      console.error('scheduled refresh failed:', e);
    }
    if (!closed) { timer = setTimeout(tick, intervalMs); timer.unref(); }
  };
  timer = setTimeout(tick, intervalMs);
  timer.unref();
  // Cleanup must run when close() is CALLED, not on the 'close' event: that
  // event only fires after every connection ends, and a held-open SSE
  // response would keep the server (and any test's afterEach) waiting
  // forever — the cleanup that would unblock it would never run.
  const origClose = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    closed = true;
    clearTimeout(timer);
    sse.closeAll();
    return origClose(cb);
  }) as typeof server.close;
  return server;
}

/**
 * `npm start` serves whatever is sitting in web/dist; it never builds. web/dist
 * is gitignored and no service keeps it fresh, so the bundle silently drifts
 * from source across every pull and branch switch. A 9-day-old bundle served
 * against a newer API shape is what took the whole dashboard down with an
 * unexplained "Cannot read properties of undefined" (#54).
 *
 * Returns null when the bundle is usable and current, otherwise the message to
 * print. `fatal` marks the case where there is nothing to serve at all.
 */
export function bundleStatus(webSrc: string, webDist: string, extraFiles: string[] = []): { fatal: boolean; message: string } | null {
  let builtAt: number;
  try {
    builtAt = statSync(join(webDist, 'index.html')).mtimeMs;
  } catch {
    return { fatal: true, message: `no built bundle at ${webDist} — run \`npm run build\` first` };
  }

  let newestSrc = 0;
  let newestName = '';
  try {
    for (const entry of readdirSync(webSrc, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const full = join(entry.parentPath ?? webSrc, entry.name);
      const { mtimeMs } = statSync(full);
      if (mtimeMs > newestSrc) { newestSrc = mtimeMs; newestName = full; }
    }
  } catch {
    // No readable source tree (an installed copy, say). Nothing to compare
    // against, so the bundle is all we have and we serve it without comment.
    return null;
  }
  // Vite inputs that live outside web/src — bin/start.sh's equivalent check
  // already covers web/index.html, and missing it here meant an index.html-only
  // edit rebuilt under start.sh but never warned under `npm start` (#60).
  for (const file of extraFiles) {
    try {
      const { mtimeMs } = statSync(file);
      if (mtimeMs > newestSrc) { newestSrc = mtimeMs; newestName = file; }
    } catch {
      // absent extra file (say vite.config renamed) is fine — skip it
    }
  }

  if (newestSrc <= builtAt) return null;
  const age = Math.round((newestSrc - builtAt) / 60000);
  return {
    fatal: false,
    message: `web/dist is STALE — ${newestName} is ${age} minute(s) newer than the bundle. `
      + 'The dashboard you are about to load is not built from this source; run `npm run build`.',
  };
}

// main
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configPath = CONFIG_PATH;
  const config = loadConfig(configPath);
  const root = PACKAGE_ROOT;
  const pidPath = join(dirname(STATE_PATH), 'server.pid');
  // ponytail: a stale bundle only warns rather than refusing to start —
  // serving an old UI knowingly is a legitimate thing to want, and a hard
  // block would be worse than the noise. Escalate to an exit if the warning
  // proves easy to scroll past.
  const bundle = bundleStatus(join(root, 'web', 'src'), join(root, 'web', 'dist'),
    [join(root, 'web', 'index.html'), join(root, 'web', 'vite.config.ts')]);
  if (bundle?.fatal) {
    console.error(bundle.message);
    process.exit(1);
  }
  if (bundle) console.warn(`\n!! ${bundle.message}\n`);
  // Rotated on every start, so a captured token doesn't outlive the process.
  const apiToken = newApiToken();
  const server = createServer({ config, statePath: STATE_PATH, webDist: WEB_DIST, configPath, apiToken });
  // Single-instance guard: let the OS decide via the listen() call itself
  // rather than probing a possibly-stale pid file (which can false-negative
  // after a crash, or false-positive if the pid was reused).
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`already running on port ${config.port}`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(config.port, '127.0.0.1', () => {
    writeApiToken(STATE_PATH, apiToken);
    writePidFile(pidPath, config.port);
    console.log(`devhud on http://localhost:${config.port} (open the dashboard with \`devhud open\`)`);
  });
  const shutdown = () => {
    try { unlinkSync(pidPath); } catch {}
    // The token must not outlive the server: a leftover is what a CLI/MCP
    // would otherwise hand to whatever next binds the port (audit L4).
    try { unlinkSync(apiTokenPath(STATE_PATH)); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
