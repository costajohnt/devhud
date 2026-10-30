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
const build = (state: ReturnType<typeof emptyState>, cards: Card[], prs: Pr[], o: { dataAsOf?: string; errors?: { github?: string; jira?: string } } = {}) =>
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

// M22 review: pruneState drops ownPrs entries for PRs no longer open, so it has
// to run after classifyCards has merged them into the card that just linked
// the PR. Pruned first, the merge in the same refresh finds nothing.
test('a card-less PR that merges as it gains a card keeps its seen comments', () => {
  const state = upgraded();
  const own = pr({ comments: [{ author: 'amy', body: 'nit', createdAt: '2026-07-03T00:00:00Z' }] });
  build(state, [], [own], { dataAsOf: '2026-07-10T00:00:00.000Z' });
  applyAction({ state, config, type: 'ack', key: 'o/r#4', reason: 'new_pr_comments' });
  build(state, [card()], [{ ...own, state: 'merged', mergedAt: '2026-07-11T00:00:00Z' }]);
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

// PR #132 review: while any source kept failing, dataAsOf was held at the
// last clean read, so an ack recorded a horizon older than the comments it
// showed and they re-flagged every refresh for the whole outage.
test('a dismissal during a sustained partial outage still covers the comments it showed', () => {
  const state = upgraded();
  const held = '2026-07-10T00:00:00.000Z';
  const commented = pr({ comments: [{ author: 'amy', body: 'nit', createdAt: '2026-07-12T09:30:00Z' }] });
  const outage = { dataAsOf: held, errors: { github: 'o/other: Not Found' } };
  build(state, [card()], [commented], outage);
  expect(reasons(state)).toContain('P-1:new_pr_comments');
  applyAction({ state, config, type: 'ack', key: 'P-1', reason: 'new_pr_comments' });
  for (let i = 0; i < 3; i++) build(state, [card()], [commented], outage);
  expect(reasons(state)).not.toContain('P-1:new_pr_comments');
  // A comment that arrives later is still new.
  build(state, [card()], [pr({ comments: [...commented.comments, { author: 'amy', body: 'ping', createdAt: '2026-07-12T10:00:00Z' }] })], outage);
  expect(reasons(state)).toContain('P-1:new_pr_comments');
});

test('a held horizon never moves a card\'s seen horizon backward', () => {
  const state = upgraded();
  cardState(state, 'P-1').lastSeenPr = '2026-07-15T00:00:00.000Z';
  build(state, [card()], [pr({ ciStatus: 'failing' })], { dataAsOf: '2026-07-10T00:00:00.000Z', errors: { github: 'x' } });
  applyAction({ state, config, type: 'ack', key: 'P-1' });
  expect(cardState(state, 'P-1').lastSeenPr).toBe('2026-07-15T00:00:00.000Z');
});

// PR #132 review: with the In Test pin wipe gone, an In QA pin outranked the
// In Test Jira-comment routing, so QA's question left the card in In QA.
test('QA waiting on the developer outranks an In QA pin', () => {
  const state = upgraded();
  const inTest = card({ status: 'In Test' });
  build(state, [inTest], [], { dataAsOf: '2026-07-10T00:00:00.000Z' });
  applyAction({ state, config, type: 'move', key: 'P-1', bucket: 'in_qa' });
  build(state, [inTest], []);
  expect(state.snapshot!.buckets.in_qa.map(i => i.key)).toEqual(['P-1']);
  const asked = card({ status: 'In Test', comments: [{ id: 'q', author: 'qa', authorId: 'qa', body: 'fails on staging', createdAt: new Date(Date.now() + 60_000).toISOString() }] });
  build(state, [asked], []);
  expect(state.snapshot!.buckets.needs_attention.map(i => i.key)).toEqual(['P-1']);
  expect(cardState(state, 'P-1').override).toBe('in_qa');
});

// PR #132 review: an off-board card cleared ownPrs acks for a PR that an
// on-board card still links, depending on card order.
test('an off-board card does not clear acks of a PR an on-board card still links', () => {
  for (const order of ['done-last', 'done-first'] as const) {
    const state = upgraded();
    const red = pr({ ciStatus: 'failing' });
    const p1 = card();
    const p2 = card({ key: 'P-2', status: 'Done', statusCategory: 'done', description: `see ${red.url}` });
    const cards = order === 'done-last' ? [p1, p2] : [p2, p1];
    build(state, cards, [red]);
    applyAction({ state, config, type: 'ack', key: 'P-1', reason: 'ci_failing' });
    build(state, cards, [red]);
    build(state, cards, [red]);
    expect(state.ownPrs!['o/r#4']!.ackedReasons, order).toEqual(['ci_failing']);
  }
});

// Audit 2026-10-29 M20: state.cards never shrank.
test('card state unseen for the retention window is pruned; a failed Jira fetch prunes nothing', () => {
  const state = upgraded();
  const old = new Date(Date.now() - 91 * 86_400_000).toISOString();
  state.cards['P-9'] = { lastSeenPr: null, lastSeenJira: null, override: 'in_qa', overrideAt: null, lastSeenAt: old };
  state.cards['P-8'] = { lastSeenPr: null, lastSeenJira: null, override: null, overrideAt: null };
  state.snapshot = buildSnapshot({ cards: [card()], prs: [], state, config, errors: { jira: 'down' } });
  expect(state.cards['P-9']).toBeDefined();
  state.snapshot = buildSnapshot({ cards: [card()], prs: [], state, config, errors: {} });
  expect(state.cards['P-9']).toBeUndefined();
  // An unstamped entry (older state file) gets a first sighting, not a delete.
  expect(state.cards['P-8']!.lastSeenAt).toBeTruthy();
  expect(state.cards['P-1']!.lastSeenAt).toBeTruthy();
});

// Low (queue.ts:28): a state reason's wait time was the card's Jira
// updatedAt, which moves on every unrelated edit, so "longest waiting first"
// was approximate for CI/review entries. It now counts from first sighting.
const OLD = '2026-01-01T00:00:00.000Z';
const at = (state: ReturnType<typeof emptyState>, id: string) => state.snapshot!.queue.find(e => e.id === id)?.at;

test('a state-reason entry keeps its first-seen time while the card updatedAt moves', () => {
  const state = upgraded();
  state.queueSeen = {};
  const red = pr({ ciStatus: 'failing' });
  build(state, [card({ updatedAt: '2026-07-01T00:00:00.000Z' })], [red]);
  const first = at(state, 'P-1:ci_failing')!;
  expect(first).not.toBe('2026-07-01T00:00:00.000Z');
  expect(state.queueSeen['P-1:ci_failing']).toBe(first);
  build(state, [card({ updatedAt: '2026-07-20T00:00:00.000Z' })], [red]);
  expect(at(state, 'P-1:ci_failing')).toBe(first);
});

test('a card-less PR state-reason entry keeps its first-seen time too', () => {
  const state = upgraded();
  state.queueSeen = { 'o/r#4:ready_to_merge': OLD };
  build(state, [], [pr({ branch: 'no-card', reviewState: 'approved', updatedAt: '2026-07-20T00:00:00Z' })]);
  expect(at(state, 'o/r#4:ready_to_merge')).toBe(OLD);
});

test('the first-seen time resets once the entry has left the queue', () => {
  const state = upgraded();
  state.queueSeen = { 'P-1:ci_failing': OLD };
  build(state, [card()], [pr({ ciStatus: 'failing' })]);
  expect(at(state, 'P-1:ci_failing')).toBe(OLD);
  build(state, [card()], [pr({ ciStatus: 'passing' })]);
  expect(state.queueSeen['P-1:ci_failing']).toBeUndefined();
  build(state, [card()], [pr({ ciStatus: 'failing' })]);
  expect(at(state, 'P-1:ci_failing')).not.toBe(OLD);
});

test('a state with no queueSeen seeds first-seen from updatedAt, not now', () => {
  const state = upgraded();
  build(state, [card({ updatedAt: '2026-07-01T00:00:00.000Z' })], [pr({ ciStatus: 'failing' })]);
  expect(at(state, 'P-1:ci_failing')).toBe('2026-07-01T00:00:00.000Z');
  expect(state.queueSeen!['P-1:ci_failing']).toBe('2026-07-01T00:00:00.000Z');
});

test('a failed fetch keeps first-seen times for entries it could not see', () => {
  const state = upgraded();
  state.queueSeen = { 'P-1:ci_failing': OLD };
  build(state, [card()], [], { errors: { github: 'down' } });
  expect(state.queueSeen['P-1:ci_failing']).toBe(OLD);
  build(state, [card()], [], { errors: { jira: 'down' } });
  expect(state.queueSeen['P-1:ci_failing']).toBe(OLD);
});

test('a partly degraded GitHub fetch keeps first-seen only where the PR repo is degraded', () => {
  const state = upgraded();
  state.queueSeen = { 'P-1:ci_failing': OLD, 'o/healthy#9:ci_failing': OLD };
  state.snapshot = buildSnapshot({ cards: [card()], prs: [], state, config, errors: { github: 'o/r failed' }, degradedPrRepos: new Set(['o/r']) });
  expect(state.queueSeen['P-1:ci_failing']).toBe(OLD);
  expect(state.queueSeen['o/healthy#9:ci_failing']).toBeUndefined();
});

// #150 review: under a permanent partial outage, Jira-only reasons and cards
// Jira no longer returns kept their first-seen times forever.
test('a partial GitHub outage still prunes Jira-only reasons and vanished cards', () => {
  const state = upgraded();
  state.queueSeen = {
    'P-1:ci_failing': OLD, 'P-1:missing_fix_version': OLD, 'P-1:missing_qa_instructions': OLD,
    'P-9:ci_failing': OLD, 'P-2:ci_failing': OLD,
  };
  // P-2's PR is in a healthy repo with green CI: its stamp has no excuse.
  const p2 = card({ key: 'P-2', url: 'https://j/P-2' });
  const healthy = pr({ repo: 'o/s', number: 5, url: 'https://gh/o/s/5', branch: 'P-2-fix' });
  state.snapshot = buildSnapshot({ cards: [card(), p2], prs: [healthy], state, config, errors: { github: 'o/r failed' }, degradedPrRepos: new Set(['o/r']) });
  expect(state.queueSeen['P-1:ci_failing']).toBe(OLD);
  expect(state.queueSeen['P-1:missing_fix_version']).toBeUndefined();
  expect(state.queueSeen['P-1:missing_qa_instructions']).toBeUndefined();
  expect(state.queueSeen['P-9:ci_failing']).toBeUndefined();
  expect(state.queueSeen['P-2:ci_failing']).toBeUndefined();
});

test('a card-less PR that gains a card keeps its wait', () => {
  const state = upgraded();
  state.queueSeen = { 'o/r#4:ready_to_merge': OLD };
  build(state, [card()], [pr({ reviewState: 'approved' })]);
  expect(at(state, 'P-1:ready_to_merge')).toBe(OLD);
});

test('an action keeps first-seen times on the rebuilt queue', () => {
  const state = upgraded();
  state.queueSeen = { 'P-1:ci_failing': OLD, 'P-2:ci_failing': OLD };
  const red = (n: number, key: string) => pr({ number: n, branch: `${key}-fix`, url: `https://gh/o/r/${n}`, ciStatus: 'failing' });
  build(state, [card(), card({ key: 'P-2', url: 'https://j/P-2' })], [red(4, 'P-1'), red(5, 'P-2')]);
  applyAction({ state, config, type: 'ack', key: 'P-2', reason: 'ci_failing' });
  expect(at(state, 'P-1:ci_failing')).toBe(OLD);
});
