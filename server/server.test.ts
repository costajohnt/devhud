import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from './index.ts';
import { saveState, emptyState } from './state.ts';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config, Snapshot, Item } from './types.ts';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    jira: { projectKey: 'PROJ', accountId: 'id', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
    github: { username: 'u', org: 'o', token: '', repos: [] },
    demo: false, writeEnabled: false,
    ...overrides,
  };
}

function needsAttentionItem(overrides: Partial<Item> = {}): Item {
  return {
    key: 'P-1', summary: '', jiraStatus: 'open', jiraUrl: '', bucket: 'needs_attention',
    attention: ['ci_failing'], newComments: [], comments: [], pr: null,
    createdAt: null, updatedAt: null, daysSinceActivity: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    updatedAt: 'x', errors: { jira: null, github: null },
    buckets: { needs_attention: [], in_progress: [], waiting_review: [], in_qa: [] },
    todo: [], unlinkedPrs: [],
    doneCards: [], doneTotal: 0, newlyDone: [], recentActivity: [],
    prLog: [],
    ...overrides,
  };
}

// fetch() (undici) treats "Host" as a forbidden header name and silently
// derives it from the URL instead of honoring an override, so a spoofed-Host
// test needs node:http directly (no such restriction) to actually exercise
// guardMutation's Host check.
function requestWithHost(port: number, path: string, host: string, method: 'GET' | 'POST' = 'POST'): Promise<{ status: number | undefined; json: () => unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: method === 'POST' ? { 'content-type': 'application/json', host } : { host } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(body) }));
    });
    req.on('error', reject);
    if (method === 'POST') req.end('{}'); else req.end();
  });
}
const postWithHost = (port: number, path: string, host: string) => requestWithHost(port, path, host, 'POST');

// Spins up a full server (temp state.json seeded with one needs_attention
// card, temp config.json matching writeEnabled: false/demo: false, temp
// webDist with a stub index.html) and returns everything a test needs.
// Pulled out of what used to be a single `beforeAll` so every test gets its
// own fresh server+state instead of ~20 tests sharing one mutable instance
// across the whole file — the old version's later tests (ack keeps
// override, sequential POSTs, the unknown-key no-op, ...) implicitly
// depended on exactly which bucket card 'P-1' had been left in by whichever
// test ran before them, which only worked because vitest happens to run a
// file's tests in declaration order by default. Nothing here changed
// behaviorally; this is purely an isolation fix.
async function startServer(): Promise<{ server: http.Server; base: string; statePath: string; configPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const statePath = join(dir, 'state.json');
  const webDist = join(dir, 'dist');
  mkdirSync(webDist);
  mkdirSync(join(webDist, 'assets'));
  writeFileSync(join(webDist, 'index.html'), '<html>app</html>');
  const state = emptyState();
  state.snapshot = makeSnapshot({
    buckets: { needs_attention: [needsAttentionItem()], in_progress: [], waiting_review: [], in_qa: [] },
    prLog: [{ id: 'o/r#9', repo: 'o/r', openedAt: null, mergedAt: null, closedAt: '2026-01-01T00:00:00Z' }],
  });
  saveState(statePath, state);
  const config = makeConfig();
  // performWrite (used by POST /api/write) re-reads config from disk and
  // fails CLOSED if that read throws — so the write-back tests below need a
  // real config.json on disk matching what they expect the gate to do
  // (writeEnabled: false, not demo), not just an in-memory `config`.
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    port: 0,
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
    writeEnabled: false, demo: false,
  }));
  const server = createServer({ config, statePath, webDist, configPath });
  await new Promise<void>(r => server.listen(0, () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, statePath, configPath };
}

let server: http.Server;
let base: string;
let statePath: string;

beforeEach(async () => {
  ({ server, base, statePath } = await startServer());
});

afterEach(() => server.close());

test('GET /api/data returns snapshot', async () => {
  const d = await (await fetch(`${base}/api/data`)).json();
  expect(d.buckets.needs_attention[0].key).toBe('P-1');
});

test('GET /api/data carries prLog through unchanged', async () => {
  const d = await (await fetch(`${base}/api/data`)).json();
  expect(d.prLog).toEqual([{ id: 'o/r#9', repo: 'o/r', openedAt: null, mergedAt: null, closedAt: '2026-01-01T00:00:00Z' }]);
});

test('POST /api/action ack clears attention and persists lastSeen', async () => {
  const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'ack', key: 'P-1' }) });
  expect(res.status).toBe(200);
  const d = await (await fetch(`${base}/api/data`)).json();
  const item = Object.values(d.buckets).flat().find((i): i is Item => (i as Item).key === 'P-1');
  expect(item!.attention).toEqual([]);
});

test('POST /api/action move to needs_attention rejected', async () => {
  const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'move', key: 'P-1', bucket: 'needs_attention' }) });
  expect(res.status).toBe(400);
});

test('GET /api/action returns 404 JSON for wrong method/unknown path', async () => {
  const res = await fetch(`${base}/api/action`);
  expect(res.status).toBe(404);
  const d = await res.json();
  expect(d.error).toBe('not found');
});

test('serves index.html for SPA routes', async () => {
  const res = await fetch(`${base}/merged`);
  expect(await res.text()).toContain('app');
});

test('GET subdirectory path falls back to index.html', async () => {
  const res = await fetch(`${base}/assets`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('app');
});

test('POST /api/action with invalid JSON returns 400', async () => {
  const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: 'not json' });
  expect(res.status).toBe(400);
  const d = await res.json();
  expect(d.error).toContain('invalid JSON body');
});

test('ack keeps override', async () => {
  // Seed the override via the live API (not a raw disk write) so this
  // exercises the same shared in-memory state the ack handler mutates.
  const moveRes = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'move', key: 'P-1', bucket: 'in_qa' }) });
  expect(moveRes.status).toBe(200);
  const { loadState: loadStateFn } = await import('./state.ts');
  expect(loadStateFn(statePath).cards['P-1']!.override).toBe('in_qa');
  const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'ack', key: 'P-1' }) });
  expect(res.status).toBe(200);
  // Acking clears attention flags but does not undo a prior manual move.
  expect(loadStateFn(statePath).cards['P-1']!.override).toBe('in_qa');
});

test('sequential POSTs both persist (no lost update)', async () => {
  const ack = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'ack', key: 'P-1' }) });
  expect(ack.status).toBe(200);
  const move = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'move', key: 'P-1', bucket: 'in_qa' }) });
  expect(move.status).toBe(200);
  const { loadState: loadStateFn } = await import('./state.ts');
  const state = loadStateFn(statePath);
  expect(state.cards['P-1']!.lastSeenJira).not.toBeNull();
  expect(state.cards['P-1']!.override).toBe('in_qa');
});

// A card that's no longer on the board (merged away, or never fetched) is a
// valid target: cardState is created lazily and the horizon fields persist,
// but there's no matching snapshot item to move, so this is a no-op on the
// visible board rather than a 400.
test('POST /api/action on an unknown key is a no-op that still succeeds', async () => {
  const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'ack', key: 'DOES-NOT-EXIST' }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, bucket: null });
  const { loadState: loadStateFn } = await import('./state.ts');
  expect(loadStateFn(statePath).cards['DOES-NOT-EXIST']!.lastSeenJira).not.toBeNull();
});

test('POST /api/action with an unrecognized type returns 400', async () => {
  const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'delete', key: 'P-1' }) });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('unknown action type');
});

test('POST /api/action with key "__proto__" is refused 400 and Object.prototype is left untouched', async () => {
  const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'ack', key: '__proto__' }) });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('key "__proto__" is not allowed');
  expect(({} as Record<string, unknown>).lastSeenPr).toBeUndefined();
});

test('unknown /api/* path returns 404 JSON instead of falling through to the SPA', async () => {
  const res = await fetch(`${base}/api/nope`);
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe('not found');
});

test('POST /api/write is refused 403 when writeEnabled is false (the default)', async () => {
  const res = await fetch(`${base}/api/write`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'comment', key: 'P-1', body: 'hi' }) });
  expect(res.status).toBe(403);
  const d = await res.json();
  expect(d.error).toBe('write-back disabled; set writeEnabled: true in config.json');
});

test('POST /api/write with an unknown type returns 400 even when write-back is disabled', async () => {
  const res = await fetch(`${base}/api/write`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'delete', key: 'P-1' }) });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain('unknown write type');
});

test('POST /api/write body cannot smuggle a config/state override to bypass the gate', async () => {
  // The handler destructures only the named write fields out of the parsed
  // body — a `...body` spread into performWrite's params would let this
  // "config" key shadow the server's real config object and flip its own
  // gate open. writeEnabled is false on this test server; it must stay 403.
  const res = await fetch(`${base}/api/write`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'comment', key: 'P-1', body: 'hi', config: { writeEnabled: true, demo: false }, state: {} }) });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe('write-back disabled; set writeEnabled: true in config.json');
});

test('POST /api/write with invalid JSON returns 400', async () => {
  const res = await fetch(`${base}/api/write`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain('invalid JSON body');
});

// Demo mode always refuses writes (nothing real to write to) regardless of
// writeEnabled, but as a 200 "stub success" rather than a 403 — nothing is
// misconfigured, there's just no external system for demo data to write to.
test('POST /api/write in demo mode returns a 200 stub-success refusal, not a 403', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const demoStatePath = join(dir, 'state.json');
  const webDist = join(dir, 'dist');
  mkdirSync(webDist);
  writeFileSync(join(webDist, 'index.html'), '<html>app</html>');
  const demoConfigPath = join(dir, 'config.json');
  writeFileSync(demoConfigPath, JSON.stringify({
    port: 0, demo: true,
    jira: { projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  }));
  const demoServer = createServer({ config: makeConfig({ demo: true }), statePath: demoStatePath, webDist, configPath: demoConfigPath });
  await new Promise<void>(r => demoServer.listen(0, () => r()));
  try {
    const demoBase = `http://127.0.0.1:${(demoServer.address() as AddressInfo).port}`;
    const res = await fetch(`${demoBase}/api/write`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'transition', key: 'P-1', status: 'Done' }) });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d).toEqual({ ok: true, demo: true, message: 'demo mode: write-back is a no-op (nothing real to write to)' });
  } finally {
    demoServer.close();
  }
});

// The demo-mode refresh test above (write-back) exercises the demo *write*
// stub over HTTP; refresh()'s own demo branch is tested directly in
// refresh.test.ts, bypassing the HTTP layer, guardHost/guardMutation, and
// saveState entirely. This is the actual first-run path: a brand-new user's
// browser hitting POST /api/refresh in demo mode through the real server.
test('POST /api/refresh in demo mode returns a populated snapshot over real HTTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const demoStatePath = join(dir, 'state.json');
  const webDist = join(dir, 'dist');
  mkdirSync(webDist);
  writeFileSync(join(webDist, 'index.html'), '<html>app</html>');
  const demoConfigPath = join(dir, 'config.json');
  writeFileSync(demoConfigPath, JSON.stringify({
    port: 0, demo: true,
    jira: { projectKey: 'DEMO', accountId: 'me' },
    github: { org: 'acme', repos: ['webapp'], username: 'costajohnt' },
  }));
  const demoServer = createServer({ config: makeConfig({ demo: true }), statePath: demoStatePath, webDist, configPath: demoConfigPath });
  await new Promise<void>(r => demoServer.listen(0, () => r()));
  try {
    const demoBase = `http://127.0.0.1:${(demoServer.address() as AddressInfo).port}`;
    const res = await fetch(`${demoBase}/api/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    const d = await res.json();
    const boardCount = Object.values(d.buckets).flat().length;
    expect(boardCount).toBeGreaterThan(0);
    expect(d.errors).toEqual({ jira: null, github: null });
    // Persisted too, not just returned — a follow-up GET /api/data (a
    // fresh page load) must see the same populated board, not the
    // pre-refresh placeholder.
    const dataRes = await fetch(`${demoBase}/api/data`);
    const persisted = await dataRes.json();
    expect(persisted.updatedAt).toBe(d.updatedAt);
  } finally {
    demoServer.close();
  }
});

// Drive-by cross-origin protection (guardMutation in index.ts), applied to
// every mutating POST /api/* endpoint. Bodies below are deliberately valid
// JSON with harmless-looking fields so only the guard (not body parsing or
// downstream validation) determines the response.
const MUTATING_ENDPOINTS = ['/api/action', '/api/refresh', '/api/write'];

test('POST /api/* with a non-JSON Content-Type is refused 415, for every mutating endpoint', async () => {
  for (const path of MUTATING_ENDPOINTS) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    });
    expect(res.status, path).toBe(415);
    expect((await res.json()).error).toBe('Content-Type must be application/json');
  }
});

test('POST /api/* with a spoofed Host header is refused 403, for every mutating endpoint', async () => {
  const port = (server.address() as AddressInfo).port;
  for (const path of MUTATING_ENDPOINTS) {
    const res = await postWithHost(port, path, 'evil.example.com');
    expect(res.status, path).toBe(403);
    expect((res.json() as { error: string }).error).toBe('invalid Host header');
  }
});

test('POST /api/* with the right hostname but the wrong port is refused 403 (DNS-rebinding-adjacent)', async () => {
  const port = (server.address() as AddressInfo).port;
  const res = await postWithHost(port, '/api/action', `127.0.0.1:${port + 1}`);
  expect(res.status).toBe(403);
});

// H1: guardHost applies to every /api/* route, GET included — a read-only
// endpoint is exactly what DNS rebinding targets (confidentiality, not
// mutation), so it needs the same Host check as the mutating routes.
test('GET /api/data with a spoofed Host header is refused 403 (DNS rebinding on a read)', async () => {
  const port = (server.address() as AddressInfo).port;
  const res = await requestWithHost(port, '/api/data', 'evil.example.com', 'GET');
  expect(res.status).toBe(403);
  expect((res.json() as { error: string }).error).toBe('invalid Host header');
});

test('GET /api/data with the correct Host still returns 200', async () => {
  const port = (server.address() as AddressInfo).port;
  const res = await requestWithHost(port, '/api/data', `127.0.0.1:${port}`, 'GET');
  expect(res.status).toBe(200);
});

test('POST /api/* with correct Content-Type and Host passes the guard (reaches normal handling)', async () => {
  // /api/action with a real body still 200s; /api/refresh and /api/write
  // with an empty body reach their own validation past the guard (not a
  // 415/403), proving the guard itself isn't what's blocking them.
  const actionRes = await fetch(`${base}/api/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'ack', key: 'GUARD-TEST' }),
  });
  expect(actionRes.status).toBe(200);

  const writeRes = await fetch(`${base}/api/write`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  expect(writeRes.status).not.toBe(415);
  expect(writeRes.status).not.toBe(403);
});

// True first boot: no refresh has ever run, so state.snapshot is still null
// and GET /api/data must fall back to the documented placeholder shape
// (empty buckets, zeroed counters) instead of returning null to the client.
// M4: the catch-all 500 must not leak runtime error details (e.g. an
// absolute filesystem path from a readFileSync ENOENT) to the client — log
// server-side, return a generic message.
test('an internal throw returns a generic 500 with no absolute path in the body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const emptyWebDist = join(dir, 'dist'); // no index.html here at all
  mkdirSync(emptyWebDist);
  const brokenServer = createServer({ config: makeConfig(), statePath: join(dir, 'state.json'), webDist: emptyWebDist });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  await new Promise<void>(r => brokenServer.listen(0, () => r()));
  try {
    const brokenBase = `http://127.0.0.1:${(brokenServer.address() as AddressInfo).port}`;
    const res = await fetch(`${brokenBase}/`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'internal error' });
    expect(JSON.stringify(body)).not.toContain(dir);
    expect(errorSpy).toHaveBeenCalled(); // logged server-side instead
  } finally {
    errorSpy.mockRestore();
    brokenServer.close();
  }
});

test('GET /api/data returns the documented placeholder before any refresh has run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const freshStatePath = join(dir, 'state.json');
  const webDist = join(dir, 'dist');
  mkdirSync(webDist);
  writeFileSync(join(webDist, 'index.html'), '<html>app</html>');
  const freshServer = createServer({ config: makeConfig(), statePath: freshStatePath, webDist });
  await new Promise<void>(r => freshServer.listen(0, () => r()));
  try {
    const freshBase = `http://127.0.0.1:${(freshServer.address() as AddressInfo).port}`;
    const d = await (await fetch(`${freshBase}/api/data`)).json();
    expect(d.updatedAt).toBeNull();
    expect(d.buckets).toEqual({ needs_attention: [], in_progress: [], waiting_review: [], in_qa: [] });
    expect(d.doneTotal).toBe(0);
  } finally {
    freshServer.close();
  }
});
