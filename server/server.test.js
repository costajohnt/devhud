import { test, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from './index.js';
import { saveState, emptyState } from './state.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let server, base, statePath;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  statePath = join(dir, 'state.json');
  const webDist = join(dir, 'dist');
  mkdirSync(webDist);
  mkdirSync(join(webDist, 'assets'));
  writeFileSync(join(webDist, 'index.html'), '<html>app</html>');
  const state = emptyState();
  state.snapshot = { updatedAt: 'x', errors: { jira: null, github: null },
    buckets: { needs_attention: [{ key: 'P-1', attention: ['ci_failing'], newComments: [], jiraStatus: 'open', bucket: 'needs_attention' }], in_progress: [], waiting_review: [], in_qa: [] },
    todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 0, newlyMerged: [], recentActivity: [],
    closedPrs: [{ repo: 'o/r', number: 9, url: 'https://gh/o/r/pull/9', title: 'stale', closedAt: '2026-01-01T00:00:00Z' }],
    prLog: [{ id: 'o/r#9', repo: 'o/r', openedAt: null, mergedAt: null, closedAt: '2026-01-01T00:00:00Z' }] };
  saveState(statePath, state);
  const config = { port: 0, jira: {}, github: {} };
  server = createServer({ config, statePath, webDist });
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server.close());

test('GET /api/data returns snapshot', async () => {
  const d = await (await fetch(`${base}/api/data`)).json();
  expect(d.buckets.needs_attention[0].key).toBe('P-1');
});

test('GET /api/data carries closedPrs and prLog through unchanged', async () => {
  const d = await (await fetch(`${base}/api/data`)).json();
  expect(d.closedPrs).toEqual([{ repo: 'o/r', number: 9, url: 'https://gh/o/r/pull/9', title: 'stale', closedAt: '2026-01-01T00:00:00Z' }]);
  expect(d.prLog).toEqual([{ id: 'o/r#9', repo: 'o/r', openedAt: null, mergedAt: null, closedAt: '2026-01-01T00:00:00Z' }]);
});

test('POST /api/action ack clears attention and persists lastSeen', async () => {
  const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'ack', key: 'P-1' }) });
  expect(res.status).toBe(200);
  const d = await (await fetch(`${base}/api/data`)).json();
  const item = Object.values(d.buckets).flat().find(i => i.key === 'P-1');
  expect(item.attention).toEqual([]);
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
  const { loadState: loadStateFn } = await import('./state.js');
  expect(loadStateFn(statePath).cards['P-1'].override).toBe('in_qa');
  const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'ack', key: 'P-1' }) });
  expect(res.status).toBe(200);
  // Acking clears attention flags but does not undo a prior manual move.
  expect(loadStateFn(statePath).cards['P-1'].override).toBe('in_qa');
});

test('sequential POSTs both persist (no lost update)', async () => {
  const ack = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'ack', key: 'P-1' }) });
  expect(ack.status).toBe(200);
  const move = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'move', key: 'P-1', bucket: 'in_qa' }) });
  expect(move.status).toBe(200);
  const { loadState: loadStateFn } = await import('./state.js');
  const state = loadStateFn(statePath);
  expect(state.cards['P-1'].lastSeenJira).not.toBeNull();
  expect(state.cards['P-1'].override).toBe('in_qa');
});

// A card that's no longer on the board (merged away, or never fetched) is a
// valid target: cardState is created lazily and the horizon fields persist,
// but there's no matching snapshot item to move, so this is a no-op on the
// visible board rather than a 400.
test('POST /api/action on an unknown key is a no-op that still succeeds', async () => {
  const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'ack', key: 'DOES-NOT-EXIST' }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  const { loadState: loadStateFn } = await import('./state.js');
  expect(loadStateFn(statePath).cards['DOES-NOT-EXIST'].lastSeenJira).not.toBeNull();
});

test('POST /api/action with an unrecognized type returns 400', async () => {
  const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'delete', key: 'P-1' }) });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('unknown action type');
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
  const demoServer = createServer({ config: { port: 0, demo: true, jira: {}, github: {} }, statePath: demoStatePath, webDist });
  await new Promise(r => demoServer.listen(0, r));
  try {
    const demoBase = `http://127.0.0.1:${demoServer.address().port}`;
    const res = await fetch(`${demoBase}/api/write`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'transition', key: 'P-1', status: 'Done' }) });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d).toEqual({ ok: true, demo: true, message: 'demo mode: write-back is a no-op (nothing real to write to)' });
  } finally {
    demoServer.close();
  }
});

// True first boot: no refresh has ever run, so state.snapshot is still null
// and GET /api/data must fall back to the documented placeholder shape
// (empty buckets, zeroed counters) instead of returning null to the client.
test('GET /api/data returns the documented placeholder before any refresh has run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-'));
  const freshStatePath = join(dir, 'state.json');
  const webDist = join(dir, 'dist');
  mkdirSync(webDist);
  writeFileSync(join(webDist, 'index.html'), '<html>app</html>');
  const freshServer = createServer({ config: { port: 0, jira: {}, github: {} }, statePath: freshStatePath, webDist });
  await new Promise(r => freshServer.listen(0, r));
  try {
    const freshBase = `http://127.0.0.1:${freshServer.address().port}`;
    const d = await (await fetch(`${freshBase}/api/data`)).json();
    expect(d.updatedAt).toBeNull();
    expect(d.buckets).toEqual({ needs_attention: [], in_progress: [], waiting_review: [], in_qa: [] });
    expect(d.mergedTotal).toBe(0);
  } finally {
    freshServer.close();
  }
});
