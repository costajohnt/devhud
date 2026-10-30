// Queue state across refreshes: acks and horizons have to survive the next
// buildSnapshot, not just the in-memory edit applyAction makes. Each test is
// tied to the audit finding (docs/audit-2026-10-29.md) it guards.
import { test, expect } from 'vitest';
import { buildSnapshot } from './refresh.ts';
import { applyAction } from './actions.ts';
import { emptyState, cardState } from './state.ts';
import type { Card, Config, JiraComment, Pr } from './types.ts';

const config: Config = {
  jira: { projectKey: 'P', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
  github: { username: 'me', org: 'o', token: 't', repos: ['r'] },
  port: 3010, demo: false, writeEnabled: false,
};
const card = (o: Partial<Card> = {}): Card => ({
  key: 'P-1', summary: 'S', status: 'In Progress', description: 'QA instructions: x', fixVersions: ['1'], url: 'https://j/P-1',
  createdAt: null, updatedAt: null, myAccountId: 'me', comments: [], ...o,
});
const pr = (o: Partial<Pr> = {}): Pr => ({
  repo: 'o/r', number: 4, url: 'https://gh/o/r/4', title: 'T', body: '', branch: 'P-1-fix', state: 'open',
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-05T00:00:00Z', mergedAt: null, closedAt: null,
  ciStatus: 'passing', reviewState: 'none', comments: [], enriched: true, ...o,
});
const upgraded = () => { const s = emptyState(); s.ownPrs = {}; return s; };
const build = (state: ReturnType<typeof emptyState>, cards: Card[], prs: Pr[], o: { dataAsOf?: string; errors?: { github?: string } } = {}) =>
  (state.snapshot = buildSnapshot({ cards, prs, state, config, errors: o.errors ?? {}, dataAsOf: o.dataAsOf }));
const reasons = (state: ReturnType<typeof emptyState>) => state.snapshot!.queue.map(e => e.id);

// H2: the off-board ack reset tested isTodo alone, but a To Do card with a PR
// stays on the board, so its acks were wiped on every refresh.
test('acks stick on a To Do card that has a linked PR', () => {
  const state = upgraded();
  const todo = card({ status: 'To Do', statusCategory: 'new' });
  const red = pr({ ciStatus: 'failing' });
  build(state, [todo], [red]);
  expect(reasons(state)).toContain('P-1:ci_failing');
  applyAction({ state, config, type: 'ack', key: 'P-1', reason: 'ci_failing' });
  build(state, [todo], [red]);
  build(state, [todo], [red]);
  expect(reasons(state)).not.toContain('P-1:ci_failing');
  expect(cardState(state, 'P-1').ackedReasons).toEqual(['ci_failing']);
});

// Low: a Blocked/Done card's PR kept its acks in ownPrs, and the sync merged
// them back when the card returned, so still-red CI stayed muted.
test('a card leaving the board forgets its PR acks too, so it re-flags on return', () => {
  const state = upgraded();
  const red = pr({ ciStatus: 'failing' });
  build(state, [card()], [red]);
  applyAction({ state, config, type: 'ack', key: 'P-1', reason: 'ci_failing' });
  build(state, [card()], [red]);
  expect(reasons(state)).not.toContain('P-1:ci_failing');
  build(state, [card({ status: 'Blocked' })], [red]);
  build(state, [card()], [red]);
  expect(reasons(state)).toContain('P-1:ci_failing');
});

// M1: the ack horizon was the build-completion time, so a comment created
// after the data was read but before the build finished was missing from the
// snapshot and then treated as seen forever once acked.
test('acking uses the data read time, so a comment that landed mid-refresh still flags', () => {
  const state = upgraded();
  const qa = (createdAt: string): JiraComment => ({ id: createdAt, author: 'qa', authorId: 'qa', body: 'blocked', createdAt });
  const readAt = '2026-07-10T00:00:00.000Z';
  build(state, [card({ status: 'In Test', comments: [qa('2026-07-09T23:00:00.000Z')] })], [], { dataAsOf: readAt });
  expect(state.snapshot!.dataAsOf).toBe(readAt);
  expect(Date.parse(state.snapshot!.updatedAt!)).toBeGreaterThan(Date.parse(readAt));
  applyAction({ state, config, type: 'ack', key: 'P-1', reason: 'new_jira_comments' });
  expect(cardState(state, 'P-1').lastSeenJira).toBe(readAt);

  // A comment created after the read (it was not in that snapshot) arrives
  // on the next refresh and must still be new.
  build(state, [card({ status: 'In Test', comments: [qa('2026-07-09T23:00:00.000Z'), qa('2026-07-10T00:00:05.000Z')] })], []);
  expect(reasons(state)).toContain('P-1:new_jira_comments');
});

// M25: the per-reason Jira ack was untested; deleting the line that persists
// it passed the whole suite.
test('dismissing a Jira-comment entry persists across refreshes', () => {
  const state = upgraded();
  const c = card({ comments: [{ id: '1', author: 'pm', authorId: 'pm', body: 'question', createdAt: '2026-07-02T00:00:00.000Z' }] });
  build(state, [c], [], { dataAsOf: '2026-07-10T00:00:00.000Z' });
  expect(reasons(state)).toContain('P-1:new_jira_comments');
  applyAction({ state, config, type: 'ack', key: 'P-1', reason: 'new_jira_comments' });
  build(state, [c], []);
  expect(reasons(state)).not.toContain('P-1:new_jira_comments');
});

// M7: PR-ref acks were tested for one reason; replacing the ack union with
// [reason] (acking a second reason un-acks the first) survived mutation.
test('acking two reasons on a card-less PR keeps both through a refresh', () => {
  const state = upgraded();
  const own = pr({ branch: 'chore', ciStatus: 'failing', reviewState: 'changes_requested',
    comments: [{ author: 'amy', body: 'nit', createdAt: '2026-07-03T00:00:00Z' }] });
  build(state, [], [own], { dataAsOf: '2026-07-10T00:00:00.000Z' });
  expect(reasons(state)).toEqual(['o/r#4:ci_failing', 'o/r#4:changes_requested', 'o/r#4:new_pr_comments']);
  applyAction({ state, config, type: 'ack', key: 'o/r#4', reason: 'ci_failing' });
  applyAction({ state, config, type: 'ack', key: 'o/r#4', reason: 'changes_requested' });
  applyAction({ state, config, type: 'ack', key: 'o/r#4', reason: 'new_pr_comments' });
  expect(state.snapshot!.unlinkedPrs[0]!.newComments).toEqual([]);
  build(state, [], [own]);
  expect(reasons(state)).toEqual([]);
  expect(state.ownPrs!['o/r#4']!.ackedReasons).toEqual(['ci_failing', 'changes_requested']);
});

// M6: the ownPrs <-> card sync and degraded handling had no tests.
test('a card-less PR gaining a card keeps its seen comments', () => {
  const state = upgraded();
  const own = pr({ comments: [{ author: 'amy', body: 'nit', createdAt: '2026-07-03T00:00:00Z' }] });
  build(state, [], [own], { dataAsOf: '2026-07-10T00:00:00.000Z' });
  applyAction({ state, config, type: 'ack', key: 'o/r#4', reason: 'new_pr_comments' });
  build(state, [card()], [own]);
  expect(reasons(state)).not.toContain('P-1:new_pr_comments');
});

test('a degraded repo keeps a card-less PR\'s acks instead of pruning them', () => {
  const state = upgraded();
  const red = pr({ branch: 'chore', ciStatus: 'failing' });
  build(state, [], [red]);
  applyAction({ state, config, type: 'ack', key: 'o/r#4', reason: 'ci_failing' });
  // The PR's data is stale this refresh (its repo failed) and CI reads
  // passing: the ack must not be pruned on the strength of stale data.
  build(state, [], [pr({ branch: 'chore', ciStatus: 'passing' })], { errors: { github: 'o/r: 502' } });
  expect(state.ownPrs!['o/r#4']!.ackedReasons).toEqual(['ci_failing']);
  // Healthy refresh, still passing: now the ack is pruned.
  build(state, [], [pr({ branch: 'chore', ciStatus: 'passing' })]);
  expect(state.ownPrs!['o/r#4']!.ackedReasons ?? null).toBeNull();
});
