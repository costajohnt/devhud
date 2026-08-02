import http from 'node:http';
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join, extname, normalize, resolve, sep } from 'node:path';
import { loadConfig } from './config.js';
import { loadState, saveState, cardState } from './state.js';
import { refresh } from './refresh.js';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };

const BUCKETS = ['in_progress', 'waiting_review', 'in_qa'];

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
        return send(200, state.snapshot ?? { updatedAt: null, errors: { jira: null, github: null },
          buckets: { needs_attention: [], in_progress: [], waiting_review: [], in_qa: [] },
          todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 0, newlyMerged: [], recentActivity: [] });
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
        const cs = cardState(state, key);
        const snap = state.snapshot;
        const findItem = () => {
          for (const b of Object.keys(snap?.buckets ?? {})) {
            const i = snap.buckets[b].findIndex(x => x.key === key);
            if (i >= 0) return { from: b, i, item: snap.buckets[b][i] };
          }
          return null;
        };
        // "Seen" horizon is the data horizon (last snapshot's updatedAt), not
        // wall-clock time — a comment that arrived between the last refresh
        // and this ack must still be treated as new on the next refresh.
        const horizon = state.snapshot?.updatedAt ?? new Date().toISOString();
        if (type === 'ack') {
          cs.lastSeenPr = cs.lastSeenJira = horizon;
          // override is intentionally kept: acking only clears the attention
          // flags, it doesn't undo a prior manual move.
          const loc = findItem();
          if (loc) {
            loc.item.attention = [];
            loc.item.newComments = [];
            if (loc.from === 'needs_attention') {
              snap.buckets.needs_attention.splice(loc.i, 1);
              const dest = cs.override ?? (loc.item.jiraStatus === config.jira?.statuses?.inTest ? 'in_qa' : 'in_progress');
              loc.item.bucket = dest;
              snap.buckets[dest].push(loc.item);
            }
          }
        } else if (type === 'move') {
          if (!BUCKETS.includes(bucket)) return send(400, { error: `bucket must be one of ${BUCKETS.join(', ')}` });
          cs.override = bucket;
          cs.overrideAt = new Date().toISOString();
          // Also bump the seen horizon so old comments already accounted
          // for by the classifier don't bounce the card straight back to
          // needs_attention on the next refresh.
          cs.lastSeenPr = cs.lastSeenJira = horizon;
          const loc = findItem();
          if (loc) {
            snap.buckets[loc.from].splice(loc.i, 1);
            loc.item.bucket = bucket;
            snap.buckets[bucket].push(loc.item);
          }
        } else return send(400, { error: 'unknown action type' });
        saveState(statePath, state);
        return send(200, { ok: true });
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
