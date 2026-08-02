import http from 'node:http';
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join, extname, normalize, resolve, sep } from 'node:path';
import { loadConfig } from './config.js';
import { loadState, saveState, emptySnapshot } from './state.js';
import { refresh } from './refresh.js';
import { applyAction } from './actions.js';
import { performWrite } from './writeback.js';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };

async function readBody(req) {
  let s = ''; for await (const c of req) s += c;
  return JSON.parse(s || '{}');
}

export function createServer({ config, statePath, webDist }) {
  // The in-memory `state` object is the single source of truth for the
  // life of the process; disk (statePath) is write-through only. Loading
  // once here (instead of per-request) avoids a lost-update race between
  // concurrent /api/refresh and /api/action calls: every handler below
  // mutates this one shared object, and each handler's mutate+save section
  // runs synchronously (no `await` in between), so interleaving can only
  // happen at an `await` boundary, at which point no partial mutation is
  // ever visible to the next handler.
  const state = loadState(statePath);
  return http.createServer(async (req, res) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
    });
    const send = (code, obj) => { if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/data' && req.method === 'GET') {
        return send(200, state.snapshot ?? emptySnapshot());
      }
      if (url.pathname === '/api/refresh' && req.method === 'POST') {
        const payload = await refresh({ config, state });
        saveState(statePath, state);
        return send(200, payload);
      }
      if (url.pathname === '/api/action' && req.method === 'POST') {
        let body;
        try {
          body = await readBody(req);
        } catch {
          return send(400, { error: 'invalid JSON body' });
        }
        const { type, key, bucket } = body;
        const result = applyAction({ state, config, type, key, bucket });
        if (result.error) return send(result.status ?? 400, { error: result.error });
        saveState(statePath, state);
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/write' && req.method === 'POST') {
        let body;
        try {
          body = await readBody(req);
        } catch {
          return send(400, { error: 'invalid JSON body' });
        }
        const result = await performWrite({ config, state, ...body });
        if (result.error) return send(result.status ?? 400, { error: result.error });
        if (!result.demo) saveState(statePath, state);
        return send(200, result);
      }
      if (url.pathname.startsWith('/api/')) {
        return send(404, { error: 'not found' });
      }
      // static
      const root = resolve(webDist);
      let file = normalize(url.pathname).replace(/^([/\\])+/, '');
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
      send(500, { error: e.message });
    }
  });
}

// main
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const config = loadConfig();
  const root = new URL('..', import.meta.url).pathname;
  const pidPath = join(root, 'data', 'server.pid');
  const server = createServer({ config, statePath: join(root, 'data', 'state.json'), webDist: join(root, 'web', 'dist') });
  // Single-instance guard: let the OS decide via the listen() call itself
  // rather than probing a possibly-stale pid file (which can false-negative
  // after a crash, or false-positive if the pid was reused).
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`already running on port ${config.port}`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(config.port, '127.0.0.1', () => {
    writeFileSync(pidPath, JSON.stringify({ pid: process.pid, port: config.port, startedAt: new Date().toISOString() }));
    console.log(`jira-dash on http://localhost:${config.port}`);
  });
  const shutdown = () => {
    try { unlinkSync(pidPath); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
