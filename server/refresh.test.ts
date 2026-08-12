import { test, expect, vi } from 'vitest';
import { buildSnapshot, refresh } from './refresh.ts';
import { emptyState } from './state.ts';
import type { Config, Card, Pr } from './types.ts';

vi.mock('./jira.ts', () => ({ fetchJiraCards: vi.fn(() => Promise.reject(new Error('jira down'))) }));
vi.mock('./github.ts', () => ({
  fetchPrs: vi.fn(() => Promise.resolve({ prs: [], errors: [] })),
  enrichPr: vi.fn((p: Pr) => Promise.resolve(p)),
}));

const config: Config = {
  jira: { projectKey: 'PROJ', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done', canceled: 'Canceled' } },
  github: { username: 'john', org: 'o', token: '', repos: [] },
  port: 3010, demo: false, writeEnabled: false, ignoreAuthors: ['John', 'Rovo'],
};
const card = (o: Partial<Card> = {}): Card => ({ key: 'PROJ-1', summary: 'S', status: 'In Progress', description: '',
  url: 'https://x/browse/PROJ-1', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  myAccountId: 'me', comments: [], ...o });
const pr = (o: Partial<Pr> = {}): Pr => ({ repo: 'o/r', number: 1, url: 'https://gh/o/r/pull/1', title: '', body: '',
  branch: 'PROJ-1-x', state: 'open', ciStatus: 'passing', reviewState: 'none', comments: [],
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z', mergedAt: null, closedAt: null, ...o });

test('buckets a linked open card', () => {
  const p = buildSnapshot({ cards: [card()], prs: [pr()], state: emptyState(), config, errors: {} });
  expect(p.buckets.self_review[0]).toMatchObject({ key: 'PROJ-1', pr: { number: 1 } });
  expect(p.todo).toEqual([]);
});

test('todo cards split out; a Done card with a merged PR lands in doneCards + celebration once, and still logs the PR', () => {
  const state = emptyState();
  const cards = [card({ status: 'To Do', key: 'PROJ-2' }), card({ key: 'PROJ-3', status: 'Done' })];
  const prs = [pr({ branch: 'PROJ-3-x', state: 'merged', mergedAt: '2026-07-03T00:00:00Z' })];
  const p1 = buildSnapshot({ cards, prs, state, config, errors: {} });
  expect(p1.todo[0]!.key).toBe('PROJ-2');
  expect(p1.doneCards[0]!.key).toBe('PROJ-3');
  expect(p1.newlyDone).toEqual(['PROJ-3']);
  expect(p1.doneTotal).toBe(1);
  // The merged PR is still logged (charts) even though it isn't a payload page.
  expect(p1.prLog).toEqual([{ id: 'o/r#1', repo: 'o/r', openedAt: '2026-07-01T00:00:00Z', mergedAt: '2026-07-03T00:00:00Z', closedAt: null }]);
  const p2 = buildSnapshot({ cards, prs, state, config, errors: {} });
  expect(p2.newlyDone).toEqual([]);   // celebrated already
  expect(p2.doneTotal).toBe(1);
  expect(p2.prLog).toEqual([{ id: 'o/r#1', repo: 'o/r', openedAt: '2026-07-01T00:00:00Z', mergedAt: '2026-07-03T00:00:00Z', closedAt: null }]); // no duplicate on re-run
});

test('canceled cards are excluded from every bucket, the todo list, and doneCards', () => {
  const cards = [card({ key: 'PROJ-C', status: 'Canceled', statusCategory: 'done' })];
  const p = buildSnapshot({ cards, prs: [], state: emptyState(), config, errors: {} });
  expect(Object.values(p.buckets).flat()).toHaveLength(0);
  expect(p.todo).toHaveLength(0);
  expect(p.doneCards).toHaveLength(0);
});

test('an assigned card in the To Do category routes to Todo, not Needs Attention', () => {
  // Even with an unseen comment that would otherwise trip needs_attention.
  const cards = [card({ key: 'PROJ-A', status: 'Assigned', statusCategory: 'new',
    comments: [{ authorId: 'other', author: 'Someone', body: 'ping', createdAt: '2026-07-09T00:00:00Z' }] })];
  const p = buildSnapshot({ cards, prs: [], state: emptyState(), config, errors: {} });
  expect(p.todo.map(t => t.key)).toEqual(['PROJ-A']);
  expect(p.buckets.needs_attention).toHaveLength(0);
});

test('a Jira-done card lands in doneCards with a matching doneTotal, celebrated once, and off the board', () => {
  const state = emptyState();
  const cards = [card({ key: 'PROJ-D', status: 'Closed', statusCategory: 'done', updatedAt: '2026-07-08T00:00:00Z' })];
  const p1 = buildSnapshot({ cards, prs: [], state, config, errors: {} });
  expect(p1.doneCards.map(d => d.key)).toEqual(['PROJ-D']);
  expect(p1.doneCards[0]!.doneAt).toBe('2026-07-08T00:00:00Z');
  expect(p1.doneTotal).toBe(1);
  expect(p1.newlyDone).toEqual(['PROJ-D']);
  expect(Object.values(p1.buckets).flat()).toHaveLength(0);
  const p2 = buildSnapshot({ cards, prs: [], state, config, errors: {} });
  expect(p2.newlyDone).toEqual([]);     // celebrated already
  expect(p2.doneTotal).toBe(1);
});

test('doneTotal tracks the Done list, not the lifetime ledger', () => {
  const state = emptyState();
  const done = card({ key: 'PROJ-OLD', status: 'Closed', statusCategory: 'done' });
  expect(buildSnapshot({ cards: [done], prs: [], state, config, errors: {} }).doneTotal).toBe(1);
  // PROJ-OLD ages out of the JQL window (updated >= -14d). It stays in
  // state.doneCelebrated for celebrate-once dedup, but the counter labels the
  // rows below it, so it drops with them rather than reading 32 above 4 rows.
  const p = buildSnapshot({ cards: [], prs: [], state, config, errors: {} });
  expect(p.doneCards).toHaveLength(0);
  expect(p.doneTotal).toBe(0);
  expect(state.doneCelebrated.map(e => e.id)).toEqual(['PROJ-OLD']);
});

test('a Done card assigned to someone else never enters the celebration ledger', () => {
  const state = emptyState();
  const foreign = card({ key: 'PROJ-THEIRS', status: 'Closed', statusCategory: 'done', assigneeId: 'someone-else' });
  const p = buildSnapshot({ cards: [foreign], prs: [], state, config, errors: {} });
  expect(state.doneCelebrated).toEqual([]);
  expect(p.newlyDone).toEqual([]);
  // still listed for this refresh -- the guard protects permanent state only
  expect(p.doneCards.map(d => d.key)).toEqual(['PROJ-THEIRS']);
});

test('board items carry the card fix versions', () => {
  const cards = [card({ key: 'PROJ-F', fixVersions: ['2026.9'] })];
  const p = buildSnapshot({ cards, prs: [], state: emptyState(), config, errors: {} });
  expect(p.buckets.in_progress[0]!.fixVersions).toEqual(['2026.9']);
});

test('a merged-but-not-Done card stays on the board with its PR shown as merged, and is not counted as done', () => {
  const state = emptyState();
  // In this workflow a merge moves the card to In Test / In QA, not Done.
  const cards = [card({ key: 'PROJ-5', status: 'In Test' })];
  const prs = [pr({ branch: 'PROJ-5-x', state: 'merged', mergedAt: '2026-07-03T00:00:00Z' })];
  const p = buildSnapshot({ cards, prs, state, config, errors: {} });
  // Not complete: absent from doneCards and doneTotal.
  expect(p.doneCards).toHaveLength(0);
  expect(p.doneTotal).toBe(0);
  // Stays on the board (QA can still reject it) with the merged PR as context.
  const item = Object.values(p.buckets).flat().find(i => i.key === 'PROJ-5');
  expect(item).toBeDefined();
  expect(item!.pr?.state).toBe('merged');
});

test('upserts every fetched PR into prLog on refresh, keyed by org/repo#num', () => {
  const state = emptyState();
  const p = buildSnapshot({ cards: [card()], prs: [pr({ repo: 'o/r', number: 1 })], state, config, errors: {} });
  expect(p.prLog).toEqual([{ id: 'o/r#1', repo: 'o/r', openedAt: '2026-07-01T00:00:00Z', mergedAt: null, closedAt: null }]);
  expect(state.prLog['o/r#1']).toBeDefined();
});

test('prLog upsert updates an existing entry rather than duplicating it', () => {
  const state = emptyState();
  buildSnapshot({ cards: [card()], prs: [pr({ repo: 'o/r', number: 1, reviewState: 'none' })], state, config, errors: {} });
  const p2 = buildSnapshot({ cards: [card()], prs: [pr({ repo: 'o/r', number: 1, state: 'merged', mergedAt: '2026-07-04T00:00:00Z' })], state, config, errors: {} });
  expect(p2.prLog).toHaveLength(1);
  expect(p2.prLog[0]!.mergedAt).toBe('2026-07-04T00:00:00Z');
});

test('closed-unmerged PRs classify with closedAt set and mergedAt null', () => {
  const state = emptyState();
  const p = buildSnapshot({
    cards: [card()],
    prs: [pr({ repo: 'o/r', number: 2, state: 'closed', mergedAt: null, updatedAt: '2026-07-05T00:00:00Z' })],
    state, config, errors: {},
  });
  expect(p.prLog[0]).toEqual({ id: 'o/r#2', repo: 'o/r', openedAt: '2026-07-01T00:00:00Z', mergedAt: null, closedAt: '2026-07-05T00:00:00Z' });
});

test('merged PRs never get closedAt set, even though state is not "closed"', () => {
  const state = emptyState();
  const p = buildSnapshot({
    cards: [card()],
    prs: [pr({ repo: 'o/r', number: 3, state: 'merged', mergedAt: '2026-07-05T00:00:00Z' })],
    state, config, errors: {},
  });
  expect(p.prLog[0]!.mergedAt).toBe('2026-07-05T00:00:00Z');
  expect(p.prLog[0]!.closedAt).toBeNull();
});

test('unlinked PRs surface; errors pass through', () => {
  const p = buildSnapshot({ cards: [], prs: [pr({ branch: 'other' })], state: emptyState(), config, errors: { jira: 'boom' } });
  expect(p.unlinkedPrs[0]!.number).toBe(1);
  expect(p.errors.jira).toBe('boom');
});

// The file-level vi.mock('./jira.ts') above always rejects fetchJiraCards
// for every other test in this file, so the SUCCESS branch of refresh()
// (`cards = await fetchJiraCards(...)`, `state.lastCards = cards`,
// refresh.ts:150) was never exercised anywhere — breaking that assignment
// wouldn't have failed the suite. This overrides the mock for one call.
test('refresh() success path: a resolved fetchJiraCards sets state.lastCards and the payload reflects the fresh cards', async () => {
  const { fetchJiraCards } = await import('./jira.ts');
  const freshCards = [card({ key: 'PROJ-9', summary: 'Fresh from Jira' })];
  vi.mocked(fetchJiraCards).mockResolvedValueOnce(freshCards);
  const state = emptyState();
  state.lastCards = [card({ key: 'PROJ-OLD', summary: 'Stale' })]; // must be replaced, not merged with

  const payload = await refresh({ config, state });

  expect(state.lastCards).toBe(freshCards);
  expect(payload.errors.jira).toBeNull();
  expect(payload.buckets.in_progress.some(i => i.key === 'PROJ-9')).toBe(true);
  expect(payload.buckets.in_progress.some(i => i.key === 'PROJ-OLD')).toBe(false);
});

test('never blanks the board: jira error reuses lastCards, errors.jira is set', async () => {
  const state = emptyState();
  state.lastCards = [card()];
  const payload = await refresh({ config, state });
  expect(payload.errors.jira).toBe('jira down');
  expect(payload.buckets.in_progress).toHaveLength(1);
  expect(payload.buckets.in_progress[0]!.key).toBe('PROJ-1');
});

test('recentActivity lists merges within 7 days of now', () => {
  const now = new Date().toISOString();
  const prs = [pr({ branch: 'PROJ-4-x', state: 'merged', mergedAt: now })];
  const p = buildSnapshot({ cards: [card({ key: 'PROJ-4', status: 'Done' })], prs, state: emptyState(), config, errors: {} });
  expect(p.recentActivity.some(e => e.type === 'merged')).toBe(true);
});

test('recentActivity lists closed-unmerged PRs within 7 days of now', () => {
  const now = new Date().toISOString();
  const prs = [pr({ repo: 'o/r', number: 9, branch: 'other', state: 'closed', mergedAt: null, updatedAt: now })];
  const p = buildSnapshot({ cards: [], prs, state: emptyState(), config, errors: {} });
  const entry = p.recentActivity.find(e => e.type === 'closed');
  expect(entry).toBeDefined();
  expect(entry!.url).toBe(prs[0]!.url);
  expect(entry!.date).toBe(now);
});

test('recentActivity lists new comments from board items within 7 days, with source-appropriate url', () => {
  const now = new Date().toISOString();
  const c = card({
    comments: [{ author: 'jira-a', authorId: 'a', body: 'ping', createdAt: now }],
  });
  const p1 = pr({ comments: [{ author: 'gh-a', body: 'gh ping', createdAt: now }] });
  const snap = buildSnapshot({ cards: [c], prs: [p1], state: emptyState(), config, errors: {} });
  const comments = snap.recentActivity.filter(e => e.type === 'comment');
  expect(comments).toHaveLength(2);
  const githubEntry = comments.find(e => e.label.includes('gh-a'));
  const jiraEntry = comments.find(e => e.label.includes('jira-a'));
  expect(githubEntry!.label).toBe('PROJ-1: comment from gh-a');
  expect(githubEntry!.url).toBe(p1.url);
  expect(jiraEntry!.url).toBe(c.url);
});

test('item comments merge both sources, newest first, capped at 10', () => {
  const c = card({
    comments: [
      { author: 'jira-a', authorId: 'a', body: 'old jira', createdAt: '2026-07-01T00:00:00Z' },
      { author: 'jira-b', authorId: 'b', body: 'new jira', createdAt: '2026-07-05T00:00:00Z' },
    ],
  });
  const p1 = pr({
    comments: [
      { author: 'gh-a', body: 'gh comment', createdAt: '2026-07-03T00:00:00Z' },
    ],
  });
  const snap = buildSnapshot({ cards: [c], prs: [p1], state: emptyState(), config, errors: {} });
  // Unread comments are a badge, not a route: the card sits in its status
  // bucket (self_review here) and carries the comments.
  const item = Object.values(snap.buckets).flat()[0]!;
  expect(item.comments.map(x => x.source)).toEqual(['jira', 'github', 'jira']);
  expect(item.comments[0]!.body).toBe('new jira');
  expect(item.comments).toHaveLength(3);
});

test('per-repo GitHub failure keeps that repo\'s PRs from state.lastPrs instead of vanishing them', async () => {
  const { fetchPrs } = await import('./github.ts');
  vi.mocked(fetchPrs).mockResolvedValueOnce({ prs: [], errors: ['o/r: 500 boom'] });
  const state = emptyState();
  state.lastCards = [card()];
  state.lastPrs = [pr()];
  const payload = await refresh({ config, state });
  expect(payload.errors.github).toContain('o/r: 500 boom');
  expect(payload.buckets.self_review[0]?.pr?.number).toBe(1);
});

test('a PR whose enrichment rejects falls back to its state.lastPrs counterpart', async () => {
  const { fetchPrs, enrichPr } = await import('./github.ts');
  const staleGoodPr = pr({ ciStatus: 'passing', reviewState: 'approved' });
  const freshPr = pr({ ciStatus: 'unknown', reviewState: 'none' });
  vi.mocked(fetchPrs).mockResolvedValueOnce({ prs: [freshPr], errors: [] });
  vi.mocked(enrichPr).mockRejectedValueOnce(new Error('enrich failed'));
  const state = emptyState();
  state.lastCards = [card()];
  state.lastPrs = [staleGoodPr];
  const payload = await refresh({ config, state });
  expect(payload.errors.github).toContain('enrich failed');
  // staleGoodPr has reviewState 'approved', which buckets it into mergeable.
  expect(payload.buckets.mergeable[0]?.pr?.ciStatus).toBe('passing');
  expect(payload.buckets.mergeable[0]?.pr?.reviewState).toBe('approved');
});

test('demo mode builds populated snapshot without network', async () => {
  const { refresh: realRefresh } = await import('./refresh.ts');
  const state = emptyState();
  const demoConfig: Config = {
    demo: true,
    jira: { projectKey: 'DEMO', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
    github: { username: 'costajohnt', org: 'acme', token: '', repos: [] },
    port: 3010, writeEnabled: false,
  };
  const p = await realRefresh({ config: demoConfig, state });
  const boardCount = Object.values(p.buckets).flat().length;
  expect(boardCount).toBeGreaterThan(0);
  expect(p.todo.length).toBeGreaterThan(0);
  expect(p.buckets.needs_attention.length).toBeGreaterThan(0);
  expect(p.buckets.qa_ready.length).toBeGreaterThan(0);
  expect(p.doneCards.length).toBeGreaterThan(0);   // Jira-done cards drive the Done page
  expect(p.newlyDone.length).toBeGreaterThan(0);
  expect(p.unlinkedPrs.length).toBeGreaterThan(0);
  expect(p.errors).toEqual({ jira: null, github: null });
  expect(p.prLog.length).toBeGreaterThan(0);
  expect(p.prLog[0]).toEqual(expect.objectContaining({ id: expect.any(String), repo: expect.any(String) }));
  expect(p.prLog.some(e => e.closedAt !== null)).toBe(true); // demo includes closed-unmerged PRs (charts)
  // Merged/closed PRs surface only as Recent Activity context, not their own fields.
  expect(p.recentActivity.some(e => e.type === 'merged')).toBe(true);
});

// M7: concurrent /api/refresh calls (two browser tabs, CLI + the web timer)
// have no ordering guarantee — the slower call can be the one with fresher
// upstream data. "Last buildSnapshot to finish wins" would let a refresh
// that started earlier (and fetched newer data) get clobbered by one that
// started later but finished first with staler data. The sequence guard
// must make the opposite true: whichever refresh *completes* with the
// highest sequence number keeps the write; a later-arriving completion
// from an earlier-started, lower-sequence call must not overwrite it.
test('a later-sequenced refresh that completes first is not overwritten by an earlier-sequenced one that finishes after it', async () => {
  const { fetchPrs } = await import('./github.ts');
  const state = emptyState();
  state.lastCards = [card()];

  let resolveFirstCallPrs!: (v: { prs: Pr[]; errors: string[] }) => void;
  const firstCallPrsPromise = new Promise<{ prs: Pr[]; errors: string[] }>((resolve) => { resolveFirstCallPrs = resolve; });

  // Call A starts first (gets the lower sequence number) but its PR fetch
  // hangs until we resolve it manually below — it will finish LAST.
  vi.mocked(fetchPrs).mockImplementationOnce(() => firstCallPrsPromise);
  const callA = refresh({ config, state });

  // Call B starts second (higher sequence number) and resolves immediately
  // with the default mock — it finishes FIRST.
  const callB = refresh({ config, state });
  const payloadB = await callB;
  expect(state.snapshot).toBe(payloadB); // B, the only completed call so far, has written

  const lastPrsAfterB = state.lastPrs;

  // Now let A's PR fetch resolve — with a distinctive PR, so an unguarded
  // cache write would be detectable — after B already completed.
  resolveFirstCallPrs({ prs: [pr({ repo: 'o/stale', number: 99 })], errors: [] });
  const payloadA = await callA;

  // A lost the sequence race, so it returns the AUTHORITATIVE snapshot (B's)
  // rather than its own stale build — callers (the HTTP response, the SSE
  // broadcast) must never receive data that state itself already rejected.
  expect(payloadA).toBe(payloadB);
  expect(state.snapshot).toBe(payloadB);
  // The outage-fallback caches sit inside the same seq gate: A's stale PR
  // list must not overwrite the fresher cache B installed.
  expect(state.lastPrs).toBe(lastPrsAfterB);
  expect(state.lastPrs!.some(p => p.repo === 'o/stale')).toBe(false);
});

test('item comment history is capped per source so a chatty PR cannot evict Jira history', () => {
  // Interleaved timestamps (Jira on the minute, GitHub 30s later) so the
  // final cross-source merge sort is actually exercised, not just the caps.
  const jiraComments = Array.from({ length: 12 }, (_, i) => ({
    author: 'other', authorId: 'other', body: `j${i}`, createdAt: `2026-07-01T00:${String(i).padStart(2, '0')}:00Z`,
  }));
  const prComments = Array.from({ length: 12 }, (_, i) => ({
    author: 'reviewer', body: `g${i}`, createdAt: `2026-07-01T00:${String(i).padStart(2, '0')}:30Z`,
  }));
  const p = buildSnapshot({
    cards: [card({ comments: jiraComments })],
    prs: [pr({ comments: prComments })],
    state: emptyState(), config, errors: {},
  });
  const comments = Object.values(p.buckets).flat()[0]!.comments;
  expect(comments.filter(c => c.source === 'jira')).toHaveLength(10);
  expect(comments.filter(c => c.source === 'github')).toHaveLength(10);
  // merged list is fully newest-first across sources
  const ts = comments.map(c => c.createdAt!);
  expect(ts).toEqual([...ts].sort().reverse());
});

test('routing off-board (Done) forgets acked reasons so a reopened card re-triggers', () => {
  const state = emptyState();
  const prs = [pr({ branch: 'PROJ-1-x', state: 'merged', mergedAt: '2026-07-03T00:00:00Z' })];
  // ack while active
  state.cards['PROJ-1'] = { lastSeenPr: null, lastSeenJira: null, override: null, overrideAt: null, ackedReasons: ['merged_not_in_test'] };
  buildSnapshot({ cards: [card({ status: 'Done' })], prs, state, config, errors: {} });
  expect(state.cards['PROJ-1']!.ackedReasons).toBeNull();
  // reopened: merged_not_in_test is a fresh event again
  const p = buildSnapshot({ cards: [card()], prs, state, config, errors: {} });
  expect(p.buckets.needs_attention[0]!.attention).toContain('merged_not_in_test');
});

test('a GitHub error marks PR data degraded so acks are not pruned', () => {
  const state = emptyState();
  state.cards['PROJ-1'] = { lastSeenPr: null, lastSeenJira: null, override: null, overrideAt: null, ackedReasons: ['ci_failing'] };
  buildSnapshot({ cards: [card()], prs: [], state, config, errors: { github: 'boom' } });
  expect(state.cards['PROJ-1']!.ackedReasons).toEqual(['ci_failing']);
});

test('an unrelated repo failure does not stop ack-pruning for cards whose PR data is healthy', async () => {
  const { fetchPrs } = await import('./github.ts');
  const state = emptyState();
  state.lastCards = [card()]; // fetchJiraCards is mocked to reject in this suite
  state.cards['PROJ-1'] = { lastSeenPr: null, lastSeenJira: null, override: null, overrideAt: null, ackedReasons: ['ci_failing'] };
  // o/r fetched fine (CI now green — the acked reason has cleared); o/dead is
  // permanently broken. The stale-repo failure must degrade only o/dead.
  vi.mocked(fetchPrs).mockResolvedValueOnce({ prs: [pr({ ciStatus: 'passing' })], errors: ['o/dead: Not Found'] });
  await refresh({ config, state });
  expect(state.cards['PROJ-1']!.ackedReasons).toBeNull();
});

test('a whole-fetch GitHub failure degrades everything and preserves acks', async () => {
  const { fetchPrs } = await import('./github.ts');
  const state = emptyState();
  state.lastCards = [card()]; // fetchJiraCards is mocked to reject in this suite
  state.lastPrs = [pr({ ciStatus: 'failing' })];
  state.cards['PROJ-1'] = { lastSeenPr: null, lastSeenJira: null, override: null, overrideAt: null, ackedReasons: ['ci_failing'] };
  vi.mocked(fetchPrs).mockRejectedValueOnce(new Error('github down'));
  await refresh({ config, state });
  expect(state.cards['PROJ-1']!.ackedReasons).toEqual(['ci_failing']);
});
