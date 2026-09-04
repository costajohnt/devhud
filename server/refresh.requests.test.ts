import { test, expect, vi, afterEach } from 'vitest';
import { refresh } from './refresh.ts';
import { githubStats } from './github.ts';
import { emptyState } from './state.ts';
import type { Config, Card } from './types.ts';

// #72: GitHub request budget per refresh, measured at the fetch boundary with
// the real github.ts underneath. Before this change a refresh over three
// repos with 50 PRs each cost 1 search + 50 detail requests per repo, plus
// 4 requests per linked PR, every tick — whether or not anything changed.

vi.mock('./jira.ts', () => ({
  fetchJiraCards: vi.fn(() => Promise.resolve([])),
  doneWatermark: vi.fn(() => undefined),
}));

afterEach(() => vi.unstubAllGlobals());

const REPOS = ['alpha', 'beta', 'gamma'];
const PRS_PER_REPO = 50;
const LINKED_PER_REPO = 2;

const config: Config = {
  jira: { projectKey: 'PROJ', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done', canceled: 'Canceled' } },
  github: { username: 'me', org: 'example-org', token: 't', repos: REPOS },
  port: 3010, demo: false, writeEnabled: false,
};

// Card PROJ-<r><n> links to PR n of repo r via the branch name.
const cardKey = (repoIdx: number, n: number) => `PROJ-${repoIdx + 1}${n}`;
const cards: Card[] = REPOS.flatMap((_, r) => Array.from({ length: LINKED_PER_REPO }, (_, i) => ({
  key: cardKey(r, i + 1), summary: 'S', status: 'In Progress', description: '',
  url: `https://jira.example/browse/${cardKey(r, i + 1)}`, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  myAccountId: 'me', comments: [],
})));

// A fake GitHub whose PR updatedAt values can be bumped between refreshes.
function fakeGithub() {
  const updatedAt = new Map<string, string>();
  const key = (repo: string, n: number) => `${repo}#${n}`;
  const node = (repoIdx: number, n: number) => ({
    number: n, url: `https://github.example/${REPOS[repoIdx]}/pull/${n}`, title: 'T', body: '',
    headRefName: n <= LINKED_PER_REPO ? `${cardKey(repoIdx, n)}-feature` : `unrelated-${n}`,
    state: n % 5 === 0 ? 'MERGED' : 'OPEN', isDraft: false,
    createdAt: '2026-06-01T00:00:00Z', updatedAt: updatedAt.get(key(REPOS[repoIdx]!, n)) ?? '2026-07-01T00:00:00Z',
    mergedAt: n % 5 === 0 ? '2026-07-01T00:00:00Z' : null, closedAt: null,
    labels: { nodes: [] }, reviewRequests: { totalCount: 0 },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  });
  const calls: string[] = [];
  const fetchMock = vi.fn((url: string | URL, init?: { body?: string }) => {
    const u = String(url);
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(body) });
    if (u.endsWith('/graphql')) {
      const q = String((JSON.parse(init?.body ?? '{}') as { variables?: { q?: string } }).variables?.q ?? '');
      const repo = q.match(/repo:example-org\/(\S+)/)?.[1] ?? '';
      calls.push(`graphql ${repo}`);
      const repoIdx = REPOS.indexOf(repo);
      const nodes = repoIdx < 0 ? [] : Array.from({ length: PRS_PER_REPO }, (_, i) => node(repoIdx, i + 1));
      return ok({ data: { search: { nodes } } });
    }
    calls.push(u.replace('https://api.github.com', ''));
    if (u.includes('/reviews')) return ok([{ state: 'APPROVED', user: { login: 'rev' }, submitted_at: '2026-07-01T00:00:00Z', body: 'ok' }]);
    return ok([]);
  });
  return {
    fetchMock, calls,
    touch: (repo: string, n: number, at: string) => updatedAt.set(key(repo, n), at),
  };
}

const LINKED = REPOS.length * LINKED_PER_REPO;

test('cold, warm, and one-changed-PR refreshes stay inside their request bounds', async () => {
  const gh = fakeGithub();
  vi.stubGlobal('fetch', gh.fetchMock);
  const { fetchJiraCards } = await import('./jira.ts');
  vi.mocked(fetchJiraCards).mockResolvedValue(cards);
  const state = emptyState();

  // Cold: one GraphQL search per repo, then comments + review comments +
  // reviews for each linked PR. No per-PR detail request for the 150 search
  // hits, and no check-runs request (CI rides on the search).
  await refresh({ config, state, quiet: true });
  const cold = githubStats();
  expect(cold.requests).toBe(REPOS.length + 3 * LINKED);
  expect(cold.byFamily).toEqual({ graphql: REPOS.length, issue_comments: LINKED, review_comments: LINKED, reviews: LINKED });
  expect(gh.calls.filter(c => c.includes('/pulls/') && !c.includes('/comments') && !c.includes('/reviews'))).toEqual([]);
  expect(gh.calls.some(c => c.includes('check-runs'))).toBe(false);
  const board = Object.values(state.snapshot!.buckets).flat();
  expect(board).toHaveLength(LINKED);
  expect(board.every(i => i.pr?.ciStatus === 'passing' && i.pr.reviewState === 'approved')).toBe(true);
  expect(board.every(i => i.comments.length === 1)).toBe(true);

  // Warm, nothing changed: one request per repo, independent of the 150 PRs
  // and of the 6 linked ones. Enrichment is reused from state.lastPrs.
  gh.calls.length = 0;
  await refresh({ config, state, quiet: true });
  const warm = githubStats();
  expect(warm.requests).toBe(REPOS.length);
  expect(warm.byFamily).toEqual({ graphql: REPOS.length });
  const warmBoard = Object.values(state.snapshot!.buckets).flat();
  expect(warmBoard.every(i => i.pr?.reviewState === 'approved' && i.comments.length === 1)).toBe(true);

  // One linked PR changed (a new comment bumps updated_at): that PR alone is
  // re-enriched, so the refresh costs one request per repo plus three.
  gh.touch('beta', 1, '2026-07-02T00:00:00Z');
  gh.calls.length = 0;
  await refresh({ config, state, quiet: true });
  const changed = githubStats();
  expect(changed.requests).toBe(REPOS.length + 3);
  expect(gh.calls.filter(c => c.startsWith('/repos/'))).toEqual([
    '/repos/example-org/beta/issues/1/comments?per_page=100&sort=created&direction=desc',
    '/repos/example-org/beta/pulls/1/comments?per_page=100&sort=created&direction=desc',
    '/repos/example-org/beta/pulls/1/reviews?per_page=100',
  ]);

  // An unlinked PR changing costs nothing beyond discovery.
  gh.touch('gamma', 40, '2026-07-02T00:00:00Z');
  await refresh({ config, state, quiet: true });
  expect(githubStats().requests).toBe(REPOS.length);
});

test('a PR that becomes linked after being seen unlinked is enriched, not served an empty comment list', async () => {
  const gh = fakeGithub();
  vi.stubGlobal('fetch', gh.fetchMock);
  const { fetchJiraCards } = await import('./jira.ts');
  // First refresh: no cards, so every PR is discovered but none is linked.
  vi.mocked(fetchJiraCards).mockResolvedValueOnce([]);
  const state = emptyState();
  await refresh({ config, state, quiet: true });
  expect(githubStats().requests).toBe(REPOS.length);
  // Second refresh: the cards arrive; the PRs are unchanged but were never
  // enriched, so the linked ones must be fetched now.
  vi.mocked(fetchJiraCards).mockResolvedValueOnce(cards);
  await refresh({ config, state, quiet: true });
  expect(githubStats().requests).toBe(REPOS.length + 3 * LINKED);
  expect(Object.values(state.snapshot!.buckets).flat().every(i => i.comments.length === 1)).toBe(true);
});

test('a refresh logs its GitHub request count and endpoint breakdown', async () => {
  const gh = fakeGithub();
  vi.stubGlobal('fetch', gh.fetchMock);
  const { fetchJiraCards } = await import('./jira.ts');
  vi.mocked(fetchJiraCards).mockResolvedValueOnce(cards);
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
  try {
    await refresh({ config, state: emptyState() });
  } finally {
    log.mockRestore();
  }
  const line = lines.find(l => l.includes('github ') && l.includes('requests'));
  expect(line).toContain(`${REPOS.length + 3 * LINKED} requests`);
  expect(line).toContain(`graphql ${REPOS.length}`);
  expect(line).toContain(`reviews ${LINKED}`);
  expect(line).toContain('0 linked PRs reused unchanged');
});
