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
    todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 0, newlyMerged: [], recentActivity: [] };
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
