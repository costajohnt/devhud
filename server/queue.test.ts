import { test, expect } from 'vitest';
import { buildQueue, routesToAttention } from './queue.ts';
import { applyAction } from './actions.ts';
import { classifyCard } from './classify.ts';
import { emptyState, emptySnapshot, cardState } from './state.ts';
import type { Bucket, Card, Config, Item, JiraStatuses, Pr, PrRef } from './types.ts';

const statuses: JiraStatuses = { todo: 'To Do', inTest: 'In Test', done: 'Done' };
const config: Config = {
  jira: { projectKey: 'P', accountId: 'me', statuses },
  github: { username: 'u', org: 'o', token: '', repos: [] },
  port: 3010, demo: false, writeEnabled: false,
};
const prRef = (o: Partial<PrRef> = {}): PrRef => ({ repo: 'o/r', number: 7, url: 'https://gh/pr/7', branch: 'b', state: 'open', ciStatus: 'passing', reviewState: 'none', ...o });
const item = (o: Partial<Item> = {}): Item => ({
  key: 'P-1', summary: 'S', jiraStatus: 'In Progress', jiraUrl: 'https://jira/P-1', bucket: 'in_progress',
  attention: [], newComments: [], comments: [], pr: prRef(), createdAt: null, updatedAt: '2026-07-05T00:00:00Z',
  daysSinceActivity: 0, pinned: false, pinnedAt: null, ...o,
});
const buckets = (...items: Item[]) => {
  const b = emptySnapshot().buckets;
  for (const i of items) b[i.bucket].push(i);
  return b;
};

test('one entry per reason, ranked by priority then longest waiting', () => {
  const q = buildQueue(buckets(
    item({ key: 'P-1', attention: ['ready_to_merge'], updatedAt: '2026-07-01T00:00:00Z' }),
    item({ key: 'P-2', attention: ['new_pr_comments'], newComments: [
      { source: 'github', author: 'bob', body: 'newest', createdAt: '2026-07-04T00:00:00Z' },
      { source: 'github', author: 'amy', body: 'oldest', createdAt: '2026-07-02T00:00:00Z' },
    ] }),
    item({ key: 'P-3', bucket: 'needs_attention', attention: ['ci_failing'], pr: prRef({ ciStatus: 'failing', ciNewFailures: ['lint'] }) }),
    item({ key: 'P-4', attention: ['merged_not_in_test'], updatedAt: '2026-07-03T00:00:00Z' }),
  ), statuses);
  expect(q.map(e => e.id)).toEqual(['P-3:ci_failing', 'P-2:new_pr_comments', 'P-4:merged_not_in_test', 'P-1:ready_to_merge']);
  const comments = q[1]!;
  expect(comments.title).toBe('2 new PR comments from bob, amy');
  expect(comments.detail).toBe('newest');
  expect(comments.at).toBe('2026-07-02T00:00:00Z');
  expect(comments.url).toBe('https://gh/pr/7');
  expect(q[0]!.detail).toBe('lint');
  expect(q[2]!.title).toBe('PR merged, move P-4 to In Test');
});

test('a Jira comment on an In Test card is P1 (QA waiting); elsewhere P2', () => {
  const c = { source: 'jira' as const, author: 'qa', body: 'fails on staging', createdAt: '2026-07-02T00:00:00Z' };
  const [qa] = buildQueue(buckets(item({ jiraStatus: 'In Test', bucket: 'needs_attention', attention: ['new_jira_comments'], newComments: [c] })), statuses);
  expect(qa).toMatchObject({ priority: 1, url: 'https://jira/P-1', title: '1 new Jira comment from qa (QA waiting)' });
  const [dev] = buildQueue(buckets(item({ attention: ['new_jira_comments'], newComments: [c] })), statuses);
  expect(dev!.priority).toBe(2);
});

test('classify adds changes_requested and ready_to_merge, but not ready_to_merge on red CI or a draft', () => {
  const card: Card = { key: 'P-1', status: 'In Progress', myAccountId: 'me', comments: [], summary: '', description: '', url: '', createdAt: null, updatedAt: null };
  const pr = (o: Partial<Pr>): Pr => ({ state: 'open', ciStatus: 'passing', reviewState: 'none', comments: [], repo: 'o/r', number: 1, url: '', title: '', body: '', branch: '', createdAt: '', updatedAt: '', mergedAt: null, closedAt: null, ...o });
  const run = (p: Pr) => classifyCard({ card, pr: p, cs: { lastSeenPr: null, lastSeenJira: null, override: null, overrideAt: null }, statuses, username: 'u' });
  expect(run(pr({ reviewState: 'changes_requested' })).attention).toContain('changes_requested');
  const approved = run(pr({ reviewState: 'approved' }));
  expect(approved.attention).toContain('ready_to_merge');
  expect(approved.bucket).toBe('mergeable');
  expect(run(pr({ reviewState: 'approved', ciStatus: 'failing' })).attention).not.toContain('ready_to_merge');
  expect(run(pr({ reviewState: 'approved', isDraft: true })).attention).not.toContain('ready_to_merge');
  expect(run(pr({ reviewState: 'approved', state: 'merged' })).attention).not.toContain('ready_to_merge');
});

function stateWith(...items: Item[]) {
  const state = emptyState();
  state.snapshot = { ...emptySnapshot(), updatedAt: '2026-07-10T00:00:00Z', buckets: buckets(...items) };
  return state;
}

test('per-reason ack dismisses one entry, keeps the others, and rebuilds the queue', () => {
  const state = stateWith(item({
    bucket: 'needs_attention', attention: ['ci_failing', 'new_pr_comments', 'new_jira_comments'],
    newComments: [
      { source: 'github', author: 'a', body: 'x', createdAt: '2026-07-02T00:00:00Z' },
      { source: 'jira', author: 'b', body: 'y', createdAt: '2026-07-02T00:00:00Z' },
    ],
  }));
  expect(applyAction({ state, config, type: 'ack', key: 'P-1', reason: 'new_pr_comments' })).toEqual({ ok: true, bucket: 'needs_attention' });
  const it = state.snapshot!.buckets.needs_attention[0]!;
  expect(it.attention).toEqual(['ci_failing', 'new_jira_comments']);
  expect(it.newComments.map(c => c.source)).toEqual(['jira']);
  const cs = cardState(state, 'P-1');
  expect(cs.lastSeenPr).toBe('2026-07-10T00:00:00Z');
  expect(cs.lastSeenJira).toBeNull();
  expect(state.snapshot!.queue.map(e => e.reason)).toEqual(['ci_failing', 'new_jira_comments']);

  // Acking the last routing reason leaves needs_attention for the bucket the
  // card's state earns.
  expect(applyAction({ state, config, type: 'ack', key: 'P-1', reason: 'ci_failing' })).toEqual({ ok: true, bucket: 'waiting_review' });
  expect(cs.ackedReasons).toEqual(['ci_failing']);
  expect(state.snapshot!.queue.map(e => e.reason)).toEqual(['new_jira_comments']);
});

test('per-reason ack rejects unknown reasons and reasons on non-ack actions', () => {
  const state = stateWith(item({ attention: ['ready_to_merge'] }));
  expect(applyAction({ state, config, type: 'ack', key: 'P-1', reason: 'bogus' })).toMatchObject({ status: 400 });
  expect(applyAction({ state, config, type: 'move', key: 'P-1', bucket: 'in_qa', reason: 'ready_to_merge' })).toMatchObject({ status: 400 });
});

test('a full ack and an unpin also rebuild the queue', () => {
  const state = stateWith(item({ attention: ['ready_to_merge'], bucket: 'mergeable', pr: prRef({ reviewState: 'approved' }) }));
  state.snapshot!.queue = buildQueue(state.snapshot!.buckets, statuses);
  expect(state.snapshot!.queue).toHaveLength(1);
  applyAction({ state, config, type: 'ack', key: 'P-1' });
  expect(state.snapshot!.queue).toEqual([]);
});

// classifierDest used to send any card with a non-empty attention list to
// needs_attention, so unpinning a card that only had badges (comments,
// ready_to_merge) misrouted it until the next refresh.
test('badge-only attention does not route to needs_attention', () => {
  expect(routesToAttention(item({ attention: ['ready_to_merge', 'new_pr_comments'] }), statuses)).toBe(false);
  expect(routesToAttention(item({ attention: ['ci_failing'] }), statuses)).toBe(true);
  expect(routesToAttention(item({ jiraStatus: 'In Test', attention: ['new_jira_comments'] }), statuses)).toBe(true);
  const state = stateWith(item({ bucket: 'in_qa' as Bucket, attention: ['ready_to_merge'], pr: prRef({ reviewState: 'approved' }) }));
  cardState(state, 'P-1').override = 'in_qa';
  expect(applyAction({ state, config, type: 'unpin', key: 'P-1' })).toMatchObject({ ok: true, bucket: 'mergeable' });
});

test('same priority and age: reason order breaks the tie (CI before review)', () => {
  const q = buildQueue(buckets(item({ attention: ['changes_requested', 'ci_failing'], pr: prRef({ ciStatus: 'failing', reviewState: 'changes_requested' }) })), statuses);
  expect(q.map(e => e.reason)).toEqual(['ci_failing', 'changes_requested']);
});
