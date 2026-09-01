import { test, expect } from 'vitest';
import { applyAction, BUCKETS, classifierDest } from './actions.ts';
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
        pinned: false, pinnedAt: null,
      }],
      in_progress: [], self_review: [], waiting_review: [], mergeable: [], qa_ready: [], in_qa: [],
    },
    todo: [], unlinkedPrs: [],
    doneCards: [], doneTotal: 0, newlyDone: [], recentActivity: [],
    prLog: [],
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

test('ack routes to qa_ready when jiraStatus is the configured "In Test" status', () => {
  const state = stateWithItem();
  state.snapshot!.buckets.needs_attention[0]!.jiraStatus = 'In Test';
  const result = applyAction({ state, config, type: 'ack', key: 'P-1' }) as LooseResult;
  expect(result.bucket).toBe('qa_ready');
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

test('ack records state-based reasons so the next refresh keeps them muted', () => {
  const state = stateWithItem();
  applyAction({ state, config, type: 'ack', key: 'P-1' });
  expect(cardState(state, 'P-1').ackedReasons).toEqual(['ci_failing']);
});

test('ack unions with prior acked reasons instead of overwriting them', () => {
  const state = stateWithItem();
  cardState(state, 'P-1').ackedReasons = ['merged_not_in_test'];
  applyAction({ state, config, type: 'ack', key: 'P-1' });
  expect(cardState(state, 'P-1').ackedReasons!.sort()).toEqual(['ci_failing', 'merged_not_in_test']);
});

test('ack with only comment-based attention leaves ackedReasons null', () => {
  const state = stateWithItem();
  state.snapshot!.buckets.needs_attention[0]!.attention = ['new_pr_comments'];
  applyAction({ state, config, type: 'ack', key: 'P-1' });
  expect(cardState(state, 'P-1').ackedReasons).toBeNull();
});

test('ack routes to waiting_review when the PR is open with review activity', () => {
  const state = stateWithItem();
  state.snapshot!.buckets.needs_attention[0]!.pr = {
    repo: 'o/r', number: 1, url: '', branch: '', state: 'open', ciStatus: 'failing', reviewState: 'review_required',
  };
  const result = applyAction({ state, config, type: 'ack', key: 'P-1' }) as LooseResult;
  expect(result.bucket).toBe('waiting_review');
});

test('move records state-based reasons the same way ack does', () => {
  const state = stateWithItem();
  applyAction({ state, config, type: 'move', key: 'P-1', bucket: 'in_qa' });
  expect(cardState(state, 'P-1').ackedReasons).toEqual(['ci_failing']);
});

test('move clears attention and newComments like ack does', () => {
  const state = stateWithItem();
  applyAction({ state, config, type: 'move', key: 'P-1', bucket: 'in_qa' });
  const item = state.snapshot!.buckets.in_qa[0]!;
  expect(item.attention).toEqual([]);
  expect(item.newComments).toEqual([]);
});

// --- unpin ---

test('unpin clears the override and re-derives the bucket from the card', () => {
  const state = stateWithItem();
  // Pin it somewhere the classifier would not choose on its own.
  expect(applyAction({ state, config, type: 'move', key: 'P-1', bucket: 'in_qa' })).toMatchObject({ ok: true, bucket: 'in_qa' });
  expect(state.cards['P-1']?.override).toBe('in_qa');
  expect(state.cards['P-1']?.overrideAt).toEqual(expect.any(String));

  const result = applyAction({ state, config, type: 'unpin', key: 'P-1' });
  // No PR, status 'In Progress', attention cleared by the move → in_progress.
  expect(result).toMatchObject({ ok: true, bucket: 'in_progress', wasPinned: true });
  expect(state.cards['P-1']?.override).toBeNull();
  expect(state.cards['P-1']?.overrideAt).toBeNull();
  const snap = state.snapshot!;
  expect(snap.buckets.in_qa).toHaveLength(0);
  expect(snap.buckets.in_progress.map(i => i.key)).toEqual(['P-1']);
  expect(snap.buckets.in_progress[0]!.pinned).toBe(false);
  expect(snap.buckets.in_progress[0]!.pinnedAt).toBeNull();
});

test('move marks the snapshot item pinned so the broadcast carries it', () => {
  const state = stateWithItem();
  applyAction({ state, config, type: 'move', key: 'P-1', bucket: 'mergeable' });
  const item = state.snapshot!.buckets.mergeable[0]!;
  expect(item.pinned).toBe(true);
  expect(item.pinnedAt).toEqual(expect.any(String));
});

test('unpin on a card that was never pinned reports wasPinned: false and leaves it put', () => {
  const state = stateWithItem();
  const result = applyAction({ state, config, type: 'unpin', key: 'P-1' });
  expect(result).toMatchObject({ ok: true, wasPinned: false });
  // Still in needs_attention: its attention flags are untouched, and
  // classifierDest honors them.
  expect(state.snapshot!.buckets.needs_attention.map(i => i.key)).toEqual(['P-1']);
});

test('unpin does not advance the seen horizons the way ack does', () => {
  const state = stateWithItem();
  applyAction({ state, config, type: 'move', key: 'P-1', bucket: 'in_qa' });
  // The move already bumped the horizon; reset so this asserts unpin alone.
  state.cards['P-1']!.lastSeenPr = null;
  state.cards['P-1']!.lastSeenJira = null;

  applyAction({ state, config, type: 'unpin', key: 'P-1' });
  expect(state.cards['P-1']?.lastSeenPr).toBeNull();
  expect(state.cards['P-1']?.lastSeenJira).toBeNull();
});

test('unpin on a card not on the board still clears the stored override', () => {
  const state = stateWithItem();
  applyAction({ state, config, type: 'move', key: 'GONE-9', bucket: 'in_qa' });
  expect(state.cards['GONE-9']?.override).toBe('in_qa');

  const result = applyAction({ state, config, type: 'unpin', key: 'GONE-9' });
  expect(result).toMatchObject({ ok: true, bucket: null, wasPinned: true });
  expect(state.cards['GONE-9']?.override).toBeNull();
});

test('a pinned card keeping live attention flags unpins back into needs_attention', () => {
  const state = stateWithItem();
  state.cards['P-1'] = { lastSeenPr: null, lastSeenJira: null, override: 'in_qa', overrideAt: '2026-07-01T00:00:00Z' };
  const item = state.snapshot!.buckets.needs_attention[0]!;
  item.pinned = true;
  item.pinnedAt = '2026-07-01T00:00:00Z';

  const result = applyAction({ state, config, type: 'unpin', key: 'P-1' });
  // classifyCard checks attention before override, so a pinned card can sit
  // in needs_attention; unpinning must not pull it out of triage.
  expect(result).toMatchObject({ ok: true, bucket: 'needs_attention', wasPinned: true });
});

test('acking a card on an approved draft PR lands where the classifier would put it', () => {
  const state = stateWithItem();
  const item = state.snapshot!.buckets.needs_attention[0]!;
  item.pr = { repo: 'o/r', number: 1, url: 'u', branch: 'b', state: 'open', ciStatus: 'passing', reviewState: 'approved', isDraft: true };

  // Draft outranks approval in classifyCard, so 'mergeable' would be a
  // destination the very next refresh undoes.
  expect(applyAction({ state, config, type: 'ack', key: 'P-1' })).toMatchObject({ ok: true, bucket: 'self_review' });
});

// classifierDest exists to track the classifier exactly (see its comment), and
// it carried the same #64 bug: the Code Review check was nested inside the
// open-PR branch, so an ack or unpin on a Code Review card with no PR sent it
// to in_progress while the next refresh put it in waiting_review — the exact
// bucket-fighting this function was written to prevent.
test('classifierDest sends a Code Review card with no PR to waiting_review (#64)', () => {
  const state = stateWithItem();
  const item = { ...state.snapshot!.buckets.needs_attention[0]!, jiraStatus: 'Code Review', attention: [], pr: null };
  expect(classifierDest(item, config)).toBe('waiting_review');
});

test('classifierDest and the classifier agree on an unpinned Code Review card', () => {
  const state = stateWithItem();
  const item = state.snapshot!.buckets.needs_attention[0]!;
  item.jiraStatus = 'Code Review';
  item.attention = [];
  item.pinned = true;
  state.cards['P-1'] = { lastSeenPr: null, lastSeenJira: null, override: 'in_qa', overrideAt: '2026-07-01T00:00:00Z' };

  const result = applyAction({ state, config, type: 'unpin', key: 'P-1' });

  expect(result).toMatchObject({ ok: true, bucket: 'waiting_review' });
  expect(state.snapshot!.buckets.waiting_review.map(i => i.key)).toEqual(['P-1']);
});

// #67: classifierDest's In Test check was the one comparison in this file that
// stayed exact after #64 normalized the review one, so an ack on a card whose
// project spells the column "in test" landed in in_progress while the next
// refresh moved it to qa_ready — the same bucket-fighting as above.
test('classifierDest matches In Test case-insensitively (#67)', () => {
  const state = stateWithItem();
  const base = { ...state.snapshot!.buckets.needs_attention[0]!, attention: [], pr: null };
  for (const jiraStatus of ['in test', 'IN TEST', '  In Test  ']) {
    expect(classifierDest({ ...base, jiraStatus }, config)).toBe('qa_ready');
  }
});

// classifierDest mirrors classifyCard, so it has to mirror the #53 exception
// too: a draft PR whose card is in a review status is out for peer review.
// Without this the ack landed the card in self_review and the next refresh
// moved it to waiting_review — the bucket-fighting this function exists to stop.
test('classifierDest sends a draft PR in a review status to waiting_review (#53)', () => {
  const state = stateWithItem();
  const item = { ...state.snapshot!.buckets.needs_attention[0]!, attention: [], jiraStatus: 'Code Review',
    pr: { repo: 'o/r', number: 1, url: 'u', branch: 'b', state: 'open' as const, ciStatus: 'passing' as const, reviewState: 'approved' as const, isDraft: true } };
  expect(classifierDest(item, config)).toBe('waiting_review');
  expect(classifierDest({ ...item, jiraStatus: 'In Progress' }, config)).toBe('self_review');
});
