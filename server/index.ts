import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { loadState, saveState, emptySnapshot } from './state.ts';
import { refresh } from './refresh.ts';
import { applyAction } from './actions.ts';
import { performWrite } from './writeback.ts';
import type { Config, State, Snapshot } from './types.ts';

// Server-side poll cadence when config.json doesn't set refreshIntervalSeconds.
// 2 minutes keeps a busy repo list well inside GitHub's 5000 req/hr budget.
const DEFAULT_REFRESH_INTERVAL_SECONDS = 120;

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = ''; for await (const c of req) s += c;
  return JSON.parse(s || '{}') as Record<string, unknown>;
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

export function createServer({ config, statePath, webDist, configPath }: {
  config: Config; statePath: string; webDist: string; configPath?: string;
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
  const broadcast = (snapshot: Snapshot) => {
    const msg = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of sseClients) client.write(msg);
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
        return; // held open; broadcast() writes future events
      }
      if (url.pathname === '/api/refresh' && req.method === 'POST') {
        const guardErr = guardMutation(req);
        if (guardErr) return send(guardErr.status, { error: guardErr.error });
        const payload = await refresh({ config, state });
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
        } catch {
          return send(400, { error: 'invalid JSON body' });
        }
        const { type, key, bucket } = body as { type?: string; key?: unknown; bucket?: string };
        const result = applyAction({ state, config, type: type ?? '', key, bucket });
        if ('error' in result) return send(result.status ?? 400, { error: result.error });
        saveState(statePath, state);
        // Actions (drag overrides, dismissals) mutate the snapshot in place;
        // push so every other tab reflects the change immediately.
        if (state.snapshot) broadcast(state.snapshot);
        return send(200, result);
      }
      if (url.pathname === '/api/write' && req.method === 'POST') {
        const guardErr = guardMutation(req);
        if (guardErr) return send(guardErr.status, { error: guardErr.error });
        let body: Record<string, unknown>;
        try {
          body = await readBody(req);
        } catch {
          return send(400, { error: 'invalid JSON body' });
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
        if (state.snapshot) broadcast(state.snapshot);
        return send(200, result);
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
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
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
  const timer = setInterval(async () => {
    try {
      const snapshot = await refresh({ config, state });
      saveState(statePath, state);
      broadcast(snapshot);
    } catch (e) {
      // Keep the loop alive: a transient Jira/GitHub outage shouldn't kill
      // live updates for the rest of the process lifetime.
      console.error(`scheduled refresh failed: ${(e as Error).message}`);
    }
  }, intervalMs);
  timer.unref();
  // Cleanup must run when close() is CALLED, not on the 'close' event: that
  // event only fires after every connection ends, and a held-open SSE
  // response would keep the server (and any test's afterEach) waiting
  // forever — the cleanup that would unblock it would never run.
  const origClose = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    clearInterval(timer);
    for (const client of sseClients) client.destroy();
    sseClients.clear();
    return origClose(cb);
  }) as typeof server.close;
  return server;
}

// main
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configPath = fileURLToPath(new URL('../config.json', import.meta.url));
  const config = loadConfig(configPath);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pidPath = join(root, 'data', 'server.pid');
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
    writeFileSync(pidPath, JSON.stringify({ pid: process.pid, port: config.port, startedAt: new Date().toISOString() }));
    console.log(`simon-dash on http://localhost:${config.port}`);
  });
  const shutdown = () => {
    try { unlinkSync(pidPath); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
