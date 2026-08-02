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
  jira: { projectKey: 'PROJ', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
  github: { username: 'john', org: 'o', token: '', repos: [] },
  port: 3010, demo: false, writeEnabled: false,
};
const card = (o: Partial<Card> = {}): Card => ({ key: 'PROJ-1', summary: 'S', status: 'In Progress', description: '',
  url: 'https://x/browse/PROJ-1', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  myAccountId: 'me', comments: [], ...o });
const pr = (o: Partial<Pr> = {}): Pr => ({ repo: 'o/r', number: 1, url: 'https://gh/o/r/pull/1', title: '', body: '',
  branch: 'PROJ-1-x', state: 'open', ciStatus: 'passing', reviewState: 'none', comments: [],
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z', mergedAt: null, ...o });

test('buckets a linked open card', () => {
  const p = buildSnapshot({ cards: [card()], prs: [pr()], state: emptyState(), config, errors: {} });
  expect(p.buckets.in_progress[0]).toMatchObject({ key: 'PROJ-1', pr: { number: 1 } });
  expect(p.todo).toEqual([]);
});

test('todo cards split out, done cards with merged PR land in mergedCards + celebration once', () => {
  const state = emptyState();
  const cards = [card({ status: 'To Do', key: 'PROJ-2' }), card({ key: 'PROJ-3', status: 'Done' })];
  const prs = [pr({ branch: 'PROJ-3-x', state: 'merged', mergedAt: '2026-07-03T00:00:00Z' })];
  const p1 = buildSnapshot({ cards, prs, state, config, errors: {} });
  expect(p1.todo[0]!.key).toBe('PROJ-2');
  expect(p1.mergedCards[0]!.key).toBe('PROJ-3');
  expect(p1.newlyMerged).toEqual(['PROJ-3']);
  expect(p1.mergedTotal).toBe(1);
  expect(p1.prLog).toEqual([{ id: 'o/r#1', repo: 'o/r', openedAt: '2026-07-01T00:00:00Z', mergedAt: '2026-07-03T00:00:00Z', closedAt: null }]);
  const p2 = buildSnapshot({ cards, prs, state, config, errors: {} });
  expect(p2.newlyMerged).toEqual([]);   // celebrated already
  expect(p2.mergedTotal).toBe(1);
  expect(p2.prLog).toEqual([{ id: 'o/r#1', repo: 'o/r', openedAt: '2026-07-01T00:00:00Z', mergedAt: '2026-07-03T00:00:00Z', closedAt: null }]); // no duplicate on re-run
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

test('closedPrs: closed-unmerged PRs from the current fetch, newest first', () => {
  const prs = [
    pr({ repo: 'o/r', number: 5, branch: 'other', state: 'closed', mergedAt: null, updatedAt: '2026-07-01T00:00:00Z', title: 'older' }),
    pr({ repo: 'o/r', number: 6, branch: 'other', state: 'closed', mergedAt: null, updatedAt: '2026-07-10T00:00:00Z', title: 'newer' }),
    pr({ repo: 'o/r', number: 7, branch: 'other', state: 'open' }), // excluded: not closed
    pr({ repo: 'o/r', number: 8, branch: 'other', state: 'merged', mergedAt: '2026-07-05T00:00:00Z' }), // excluded: merged
  ];
  const p = buildSnapshot({ cards: [], prs, state: emptyState(), config, errors: {} });
  expect(p.closedPrs).toEqual([
    { repo: 'o/r', number: 6, url: prs[1]!.url, title: 'newer', closedAt: '2026-07-10T00:00:00Z' },
    { repo: 'o/r', number: 5, url: prs[0]!.url, title: 'older', closedAt: '2026-07-01T00:00:00Z' },
  ]);
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
  // Unseen comments push this card into needs_attention.
  const item = snap.buckets.needs_attention[0]!;
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
  expect(payload.buckets.in_progress[0]?.pr?.number).toBe(1);
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
  // staleGoodPr has reviewState 'approved', which buckets it into waiting_review.
  expect(payload.buckets.waiting_review[0]?.pr?.ciStatus).toBe('passing');
  expect(payload.buckets.waiting_review[0]?.pr?.reviewState).toBe('approved');
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
  expect(p.buckets.in_qa.length).toBeGreaterThan(0);
  expect(p.mergedCards.length).toBeGreaterThan(0);
  expect(p.newlyMerged.length).toBeGreaterThan(0);
  expect(p.unlinkedPrs.length).toBeGreaterThan(0);
  expect(p.errors).toEqual({ jira: null, github: null });
  expect(p.prLog.length).toBeGreaterThan(0);
  expect(p.prLog[0]).toEqual(expect.objectContaining({ id: expect.any(String), repo: expect.any(String) }));
  expect(p.prLog.some(e => e.closedAt !== null)).toBe(true); // demo now includes closed-unmerged PRs
  expect(p.closedPrs.length).toBeGreaterThan(0);
  expect(p.closedPrs[0]).toEqual(expect.objectContaining({ repo: expect.any(String), number: expect.any(Number), closedAt: expect.any(String) }));
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

  // Now let A's PR fetch resolve, so it finishes after B already completed.
  resolveFirstCallPrs({ prs: [], errors: [] });
  const payloadA = await callA;

  // A still gets its own payload back (its caller's own request/response is
  // unaffected), but the shared board state must still reflect B — the
  // later-sequenced, earlier-completing call — not regress to A's.
  expect(payloadA).not.toBe(payloadB);
  expect(state.snapshot).toBe(payloadB);
  expect(state.snapshot).not.toBe(payloadA);
});
