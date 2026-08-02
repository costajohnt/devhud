import { test, expect } from 'vitest';
import { boardStatus, doRefresh, ackCard, moveCard, cardComments, transitionCard, commentCard, commentPr } from './handlers.js';
import { loadState, saveState, emptyState } from '../server/state.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// Same port convention as server/cli.test.js: nothing listens here, so every
// handler in this file exercises the direct-mode (no running server) path.
const config = {
  port: 39218,
  jira: { projectKey: 'DEMO', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
  github: { username: 'costajohnt', org: 'acme' },
  demo: true,
};

function tempStatePath() {
  return join(mkdtempSync(join(tmpdir(), 'jd-mcp-')), 'state.json');
}

function seedSnapshot(statePath) {
  const state = emptyState();
  state.snapshot = {
    updatedAt: '2026-07-01T00:00:00Z', errors: { jira: null, github: null },
    buckets: {
      needs_attention: [{
        key: 'P-1', summary: 'Fix it', jiraStatus: 'In Progress', bucket: 'needs_attention',
        attention: ['ci_failing'], newComments: [{ source: 'github', author: 'sarah', body: 'ping', createdAt: '2026-07-01T00:00:00Z' }],
        comments: [{ source: 'github', author: 'sarah', body: 'ping', createdAt: '2026-07-01T00:00:00Z' }],
      }],
      in_progress: [], waiting_review: [], in_qa: [],
    },
    todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 3, newlyMerged: [], recentActivity: [],
  };
  saveState(statePath, state);
  return state;
}

test('boardStatus returns the empty-board placeholder against a fresh state file', async () => {
  const statePath = tempStatePath();
  const snap = await boardStatus({ config, statePath });
  expect(snap.updatedAt).toBeNull();
  expect(snap.buckets.needs_attention).toEqual([]);
});

test('boardStatus returns the persisted snapshot as-is', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const snap = await boardStatus({ config, statePath });
  expect(snap.mergedTotal).toBe(3);
  expect(snap.buckets.needs_attention[0].key).toBe('P-1');
});

test('ackCard clears attention and moves the card out of needs_attention (direct mode)', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const result = await ackCard({ config, statePath, key: 'P-1' });
  expect(result).toEqual({ ok: true, bucket: 'in_progress' });
  const persisted = loadState(statePath);
  expect(persisted.snapshot.buckets.needs_attention).toEqual([]);
  expect(persisted.snapshot.buckets.in_progress[0].key).toBe('P-1');
});

test('moveCard pins the card to the requested bucket and persists the override', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const result = await moveCard({ config, statePath, key: 'P-1', bucket: 'in_qa' });
  expect(result).toEqual({ ok: true, bucket: 'in_qa' });
  const persisted = loadState(statePath);
  expect(persisted.cards['P-1'].override).toBe('in_qa');
  expect(persisted.snapshot.buckets.in_qa[0].key).toBe('P-1');
});

test('moveCard rejects an invalid bucket the same way the HTTP API does', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const result = await moveCard({ config, statePath, key: 'P-1', bucket: 'needs_attention' });
  expect(result.error).toContain('bucket must be one of');
});

test('cardComments returns the item\'s full comment history and newComments', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const result = await cardComments({ config, statePath, key: 'P-1' });
  expect(result.key).toBe('P-1');
  expect(result.comments).toHaveLength(1);
  expect(result.newComments).toHaveLength(1);
  expect(result.comments[0].author).toBe('sarah');
});

test('cardComments on an unknown key returns an error shape, not a throw', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const result = await cardComments({ config, statePath, key: 'NOPE-1' });
  expect(result.error).toContain('NOPE-1');
});

test('doRefresh in demo mode returns bucket counts, errors, and newlyMerged without touching the network', async () => {
  const statePath = tempStatePath();
  const summary = await doRefresh({ config, statePath });
  expect(summary.errors).toEqual({ jira: null, github: null });
  expect(Object.values(summary.counts).some(n => n > 0)).toBe(true);
  expect(Array.isArray(summary.newlyMerged)).toBe(true);
});

// Split-brain guard: a live server.pid blocks direct-mode writes (ack/move/
// refresh) so an unreachable-but-alive server's in-memory state can't be
// silently clobbered by this process writing state.json underneath it.
test('ackCard refuses a direct-mode write when a server.pid exists for a live process', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: process.pid, port: config.port, startedAt: 'x' }));
  const result = await ackCard({ config, statePath, key: 'P-1' });
  expect(result.error).toContain('appears to be running');
});

test('transitionCard against demo config returns the stub-success refusal, not an error', async () => {
  const statePath = tempStatePath();
  const result = await transitionCard({ config, statePath, key: 'P-1', status: 'Done' });
  expect(result).toEqual({ ok: true, demo: true, message: 'demo mode: write-back is a no-op (nothing real to write to)' });
});

test('commentCard against demo config returns the stub-success refusal', async () => {
  const statePath = tempStatePath();
  const result = await commentCard({ config, statePath, key: 'P-1', body: 'looks good' });
  expect(result.demo).toBe(true);
});

test('commentPr against demo config returns the stub-success refusal', async () => {
  const statePath = tempStatePath();
  const result = await commentPr({ config, statePath, repo: 'acme/webapp', number: 482, body: 'nice work' });
  expect(result.demo).toBe(true);
});

test('transitionCard against a non-demo config with writeEnabled false refuses with a real error', async () => {
  const statePath = tempStatePath();
  const nonDemoConfig = { ...config, demo: false, writeEnabled: false };
  const result = await transitionCard({ config: nonDemoConfig, statePath, key: 'P-1', status: 'Done' });
  expect(result.error).toBe('write-back disabled; set writeEnabled: true in config.json');
});

test('boardStatus (read-only) still works direct-mode even with a server.pid present', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: process.pid, port: config.port, startedAt: 'x' }));
  const snap = await boardStatus({ config, statePath });
  expect(snap.mergedTotal).toBe(3);
});
