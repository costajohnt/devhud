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
  writeFileSync(join(webDist, 'index.html'), '<html>app</html>');
  const state = emptyState();
  state.snapshot = { updatedAt: 'x', errors: { jira: null, github: null },
    buckets: { needs_attention: [{ key: 'P-1', attention: ['ci_failing'], newComments: [] }], in_progress: [], waiting_review: [], in_qa: [] },
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

test('serves index.html for SPA routes', async () => {
  const res = await fetch(`${base}/merged`);
  expect(await res.text()).toContain('app');
});
