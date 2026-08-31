import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { loadState, saveState, emptySnapshot } from './state.ts';
import { refresh } from './refresh.ts';
import { applyAction } from './actions.ts';
import { performWrite } from './writeback.ts';
import { listRuns, readRun } from './simon.ts';
import { writePidFile } from './transport.ts';
import type { Config, State, Snapshot } from './types.ts';

// Server-side poll cadence when config.json doesn't set refreshIntervalSeconds.
// 2 minutes keeps a busy repo list well inside GitHub's 5000 req/hr budget.
const DEFAULT_REFRESH_INTERVAL_SECONDS = 120;

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };

export class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const c of req) {
    s += c;
    // Real bodies here are tiny JSON; without a ceiling any local process
    // could balloon the heap with one giant POST.
    if (s.length > 1_000_000) throw new BodyTooLarge('body too large');
  }
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

// `refreshFn` defaults to the real refresh() and exists so tests can drive
// the scheduled loop (short interval + stub) without network or module
// mocking — same convention as performWrite's refreshFn.
export function createServer({ config, statePath, webDist, configPath, refreshFn = refresh }: {
  config: Config; statePath: string; webDist: string; configPath?: string; refreshFn?: typeof refresh;
}): http.Server {
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
  const sseClients = new Set<ServerResponse>();
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
    for (const client of sseClients) {
      // Per-client isolation: one torn-down socket (destroyed between its
      // teardown and its 'close' event) must not abort the fan-out for the
      // rest, nor turn an already-saved refresh into a 500.
      try {
        if (!client.destroyed) client.write(msg);
      } catch {
        sseClients.delete(client);
      }
    }
  };
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
    });
    const send = (code: number, obj: unknown) => { if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.startsWith('/api/')) {
        const hostErr = guardHost(req);
        if (hostErr) return send(hostErr.status, { error: hostErr.error });
      }
      if (url.pathname === '/api/data' && req.method === 'GET') {
        return send(200, state.snapshot ?? emptySnapshot());
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        // Cap held-open streams: each one buffers every future broadcast if
        // its consumer stalls, so an unbounded set is a local memory-DoS
        // vector. 32 covers any realistic number of own tabs.
        if (sseClients.size >= 32) return send(503, { error: 'too many event streams' });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        // Current snapshot immediately on connect: the client renders from
        // this event alone, no separate /api/data fetch needed, and an
        // EventSource auto-reconnect (laptop wake, server restart) re-syncs
        // the same way.
        res.write(`data: ${JSON.stringify(state.snapshot ?? emptySnapshot())}\n\n`);
        sseClients.add(res);
        res.on('close', () => sseClients.delete(res));
        // Async write failures on a held-open response otherwise surface as
        // unhandled 'error' emissions and crash the process.
        res.on('error', () => sseClients.delete(res));
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
        const { type, key, bucket } = body as { type?: string; key?: unknown; bucket?: string };
        const result = applyAction({ state, config, type: type ?? '', key, bucket });
        if ('error' in result) return send(result.status ?? 400, { error: result.error });
        try {
          saveState(statePath, state);
        } catch (e) {
          // applyAction already mutated the in-memory board, so memory and
          // disk now diverge: the served snapshot shows the action applied,
          // but a restart silently reverts it (ack/move bounce back). Name
          // that explicitly instead of dying in the generic handler catch.
          console.error(`simon-dash: action ${type} on ${String(key)} applied in memory but saveState failed — memory and disk have diverged:`, e);
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
        const { type, key, repo, number, body: text, status } = body as {
          type?: string; key?: string; repo?: string; number?: number; body?: string; status?: string;
        };
        const result = await performWrite({ config, state, type: type ?? '', key, repo, number, body: text, status, configPath });
        if ('error' in result) return send(result.status ?? 400, { error: result.error });
        if (!('demo' in result && result.demo)) saveState(statePath, state);
        if (state.snapshot) broadcast(state.snapshot, { force: true });
        return send(200, result);
      }
      // Simon executor runs: read-only local file scans, deliberately outside
      // the DashboardData snapshot/SSE cycle (cheap enough to serve on demand,
      // and run telemetry shouldn't bloat every broadcast).
      if (url.pathname === '/api/simon/runs' && req.method === 'GET') {
        return send(200, await listRuns(config));
      }
      const runMatch = url.pathname.match(/^\/api\/simon\/runs\/([^/]+)$/);
      if (runMatch && req.method === 'GET') {
        // Malformed percent-encoding (e.g. %zz) makes decodeURIComponent throw
        // URIError — that's client garbage, so it gets the same 404 as any
        // other invalid id, not the generic 500.
        let id: string;
        try { id = decodeURIComponent(runMatch[1]!); } catch { return send(404, { error: 'run not found' }); }
        const run = await readRun(config, id);
        return run ? send(200, run) : send(404, { error: 'run not found' });
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
  // interval (many repos, cold ETag cache) must not overlap itself — the
  // seq gate in refresh() protects snapshot ordering but not the doubled
  // API spend. The next tick arms only after the current one completes.
  let timer: NodeJS.Timeout;
  let closed = false;
  const tick = async () => {
    try {
      const snapshot = await refreshFn({ config, state });
      // Save failure isolated from the broadcast: refresh() already updated
      // the in-memory snapshot (which /api/data serves), so skipping the
      // broadcast would leave every tab permanently stale over a disk-full/
      // permissions problem that repeats each tick. Unlike /api/action's
      // save-then-broadcast rule this is not a user mutation that could
      // silently revert — it re-fetches identically on the next tick.
      try {
        saveState(statePath, state);
      } catch (e) {
        console.error('scheduled refresh saved nothing (memory is fresh, disk is stale):', e);
      }
      broadcast(snapshot);
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
    for (const client of sseClients) client.destroy();
    sseClients.clear();
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
  const configPath = fileURLToPath(new URL('../config.json', import.meta.url));
  const config = loadConfig(configPath);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pidPath = join(root, 'data', 'server.pid');
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
  const server = createServer({ config, statePath: join(root, 'data', 'state.json'), webDist: join(root, 'web', 'dist'), configPath });
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
    writePidFile(pidPath, config.port);
    console.log(`simon-dash on http://localhost:${config.port}`);
  });
  const shutdown = () => {
    try { unlinkSync(pidPath); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
