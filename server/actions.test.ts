import { test, expect } from 'vitest';
import { applyAction, BUCKETS } from './actions.ts';
import { emptyState, cardState } from './state.ts';
import type { Config, Snapshot } from './types.ts';

const config: Config = {
  jira: { projectKey: 'PROJ', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
  github: { username: 'u', org: 'o', token: '', repos: [] },
  port: 3010, demo: false, writeEnabled: false,
};

// applyAction's result is a discriminated union ({ok:true,bucket} | {error,status});
// tests below probe both branches, so assertions cast to this loose shape
// rather than narrowing with `'error' in result` at every call site.
type LooseResult = { ok?: true; bucket?: string | null; error?: string; status?: number };

function stateWithItem(overrides: Partial<Snapshot> = {}) {
  const state = emptyState();
  state.snapshot = {
    updatedAt: '2026-07-01T00:00:00Z',
    errors: { jira: null, github: null },
    buckets: {
      needs_attention: [{
        key: 'P-1', summary: 'S', jiraStatus: 'In Progress', jiraUrl: 'https://x/browse/P-1', bucket: 'needs_attention',
        attention: ['ci_failing'], newComments: [{ source: 'github', author: 'a', body: 'b', createdAt: null }],
        comments: [], pr: null, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z', daysSinceActivity: 0,
      }],
      in_progress: [], waiting_review: [], in_qa: [],
    },
    todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 0, newlyMerged: [], recentActivity: [],
    closedPrs: [], prLog: [],
    ...overrides,
  };
  return state;
}

test('ack clears attention/newComments and moves needs_attention -> in_progress by default', () => {
  const state = stateWithItem();
  const result = applyAction({ state, config, type: 'ack', key: 'P-1' });
  expect(result).toEqual({ ok: true, bucket: 'in_progress' });
  expect(state.snapshot!.buckets.needs_attention).toHaveLength(0);
  const item = state.snapshot!.buckets.in_progress[0]!;
  expect(item.attention).toEqual([]);
  expect(item.newComments).toEqual([]);
  expect(cardState(state, 'P-1').lastSeenPr).toBe('2026-07-01T00:00:00Z');
});

test('ack routes to in_qa when jiraStatus is the configured "In Test" status', () => {
  const state = stateWithItem();
  state.snapshot!.buckets.needs_attention[0]!.jiraStatus = 'In Test';
  const result = applyAction({ state, config, type: 'ack', key: 'P-1' }) as LooseResult;
  expect(result.bucket).toBe('in_qa');
});

test('ack honors an existing override instead of the default routing', () => {
  const state = stateWithItem();
  cardState(state, 'P-1').override = 'waiting_review';
  const result = applyAction({ state, config, type: 'ack', key: 'P-1' }) as LooseResult;
  expect(result.bucket).toBe('waiting_review');
});

test('move pins the card, splices it into the target bucket, and persists the override', () => {
  const state = stateWithItem();
  const result = applyAction({ state, config, type: 'move', key: 'P-1', bucket: 'in_qa' });
  expect(result).toEqual({ ok: true, bucket: 'in_qa' });
  expect(state.snapshot!.buckets.needs_attention).toHaveLength(0);
  expect(state.snapshot!.buckets.in_qa[0]!.key).toBe('P-1');
  expect(cardState(state, 'P-1').override).toBe('in_qa');
});

test('move rejects a target bucket outside the allowed set (e.g. needs_attention)', () => {
  const state = stateWithItem();
  const result = applyAction({ state, config, type: 'move', key: 'P-1', bucket: 'needs_attention' }) as LooseResult;
  expect(result.error).toBe(`bucket must be one of ${BUCKETS.join(', ')}`);
  expect(result.status).toBe(400);
});

test('unknown action type errors', () => {
  const state = stateWithItem();
  const result = applyAction({ state, config, type: 'delete', key: 'P-1' }) as LooseResult;
  expect(result.error).toBe('unknown action type');
  expect(result.status).toBe(400);
});

test('ack/move on a key not present in the current snapshot is a no-op that still succeeds', () => {
  const state = stateWithItem();
  const ack = applyAction({ state, config, type: 'ack', key: 'GHOST' });
  expect(ack).toEqual({ ok: true, bucket: null });
  const move = applyAction({ state, config, type: 'move', key: 'GHOST', bucket: 'in_qa' });
  expect(move).toEqual({ ok: true, bucket: null });
  // Horizon/override still recorded even though there's nothing to move.
  expect(cardState(state, 'GHOST').lastSeenPr).not.toBeNull();
});

test('applyAction works with no snapshot yet (state.snapshot is null)', () => {
  const state = emptyState();
  const result = applyAction({ state, config, type: 'ack', key: 'P-1' });
  expect(result).toEqual({ ok: true, bucket: null });
});

test('applyAction rejects prototype-pollution key names before ever reaching cardState', () => {
  const state = stateWithItem();
  for (const badKey of ['__proto__', 'constructor', 'prototype']) {
    const result = applyAction({ state, config, type: 'ack', key: badKey });
    expect(result).toEqual({ error: `key "${badKey}" is not allowed`, status: 400 });
  }
  // The sharpest check: Object.prototype itself must be untouched. Before
  // the guard, `state.cards['__proto__'] ??= {...}` read back the live
  // Object.prototype (never nullish, so `??=` never assigned) and
  // subsequent `cs.lastSeenPr = horizon` landed as a real own-property on
  // Object.prototype, inherited by every plain object in the process.
  expect(({} as Record<string, unknown>).lastSeenPr).toBeUndefined();
  expect(Object.keys(state.cards)).toEqual([]);
});

test('applyAction rejects a falsy or non-string key before touching state (covers all transports)', () => {
  const state = stateWithItem();
  for (const badKey of [undefined, null, '', 0, {}, ['P-1']]) {
    const result = applyAction({ state, config, type: 'ack', key: badKey });
    expect(result).toEqual({ error: 'key is required and must be a non-empty string', status: 400 });
  }
  // Nothing got written into state.cards for any of these.
  expect(Object.keys(state.cards)).toEqual([]);
});
