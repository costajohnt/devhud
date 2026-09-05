import { test, expect, vi, afterEach } from 'vitest';
import { mapPr, ciFromRollup, reviewStateFrom, fetchPrs, enrichPr, throttleWaitMs, isThrottleMessage, githubStats, resetGithubStats } from './github.ts';
import type { Pr, GithubConfig } from './types.ts';

afterEach(() => vi.unstubAllGlobals());

// A GraphQL search node in the shape PR_SEARCH asks for (#72).
const gqlPr = (o: Partial<Parameters<typeof mapPr>[0]> = {}) => ({
  number: 7, url: 'u', title: 'T', body: 'B', headRefName: 'PROJ-1-x', state: 'OPEN', isDraft: false,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z', mergedAt: null, closedAt: null,
  labels: { nodes: [] }, reviewRequests: { totalCount: 0 },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...o,
});

// A fake GitHub: POST /graphql answers a search with `nodes` per repo (keyed
// by the repo: term in the query), and any REST path answers `rest(url)`.
type FetchInit = { method?: string; body?: string; headers: Record<string, string> };
const fakeGithub = (nodes: Record<string, unknown[]> | ((q: string) => unknown), rest: (url: string) => unknown = () => []) =>
  vi.fn((url: string | URL, init?: FetchInit) => {
    const u = String(url);
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(body) });
    if (u.endsWith('/graphql')) {
      const q = String((JSON.parse(init?.body ?? '{}') as { variables?: { q?: string } }).variables?.q ?? '');
      if (typeof nodes === 'function') return ok(nodes(q));
      const repo = q.match(/repo:(\S+)/)?.[1] ?? '';
      return ok({ data: { search: { nodes: nodes[repo] ?? [] } } });
    }
    return ok(rest(u));
  });

test('mapPr basic fields, merged state, CI from the head commit rollup, pending review request', () => {
  const p = mapPr(gqlPr({ state: 'MERGED', mergedAt: '2026-07-01T00:00:00Z' }), 'org/r');
  expect(p).toMatchObject({ repo: 'org/r', number: 7, branch: 'PROJ-1-x', state: 'merged', ciStatus: 'unknown', reviewState: 'none', isDraft: false });
  const open = mapPr(gqlPr({ reviewRequests: { totalCount: 2 }, labels: { nodes: [{ name: 'Draft' }] } }), 'org/r');
  expect(open).toMatchObject({ state: 'open', ciStatus: 'passing', reviewState: 'review_required', isDraft: true });
  expect(mapPr(gqlPr({ state: 'CLOSED', closedAt: '2026-07-02T00:00:00Z' }), 'org/r')).toMatchObject({ state: 'closed', closedAt: '2026-07-02T00:00:00Z' });
});

test('ciFromRollup maps GitHub\'s combined status onto the four board states', () => {
  expect(ciFromRollup('SUCCESS')).toBe('passing');
  expect(ciFromRollup('FAILURE')).toBe('failing');
  expect(ciFromRollup('ERROR')).toBe('failing');
  expect(ciFromRollup('PENDING')).toBe('pending');
  expect(ciFromRollup('EXPECTED')).toBe('pending');
  // No checks configured, or no rollup on the commit.
  expect(ciFromRollup(null)).toBe('unknown');
  expect(ciFromRollup(undefined)).toBe('unknown');
});

test('reviewStateFrom', () => {
  expect(reviewStateFrom(true, [])).toBe('review_required');
  expect(reviewStateFrom(false, [{ state: 'CHANGES_REQUESTED', user: { login: 'a' }, submitted_at: '1' }])).toBe('changes_requested');
  expect(reviewStateFrom(false, [
    { state: 'CHANGES_REQUESTED', user: { login: 'a' }, submitted_at: '2026-01-01' },
    { state: 'APPROVED', user: { login: 'a' }, submitted_at: '2026-01-02' }])).toBe('approved');
  expect(reviewStateFrom(false, [])).toBe('none');
});

// enrichPr and fetchPrs are the network-orchestration functions in this
// file — jira.ts's fetchJiraCards equivalent orchestration IS covered with
// a mocked fetch (jira.test.ts); these were not, an asymmetric gap that
// left enrichPr's comment-merge-and-sort logic (real orchestration, not a
// thin wrapper) running unverified.

const basePr = (o: Partial<Pr> = {}): Pr => ({
  repo: 'o/r', number: 5, url: 'u', title: 'T', body: '', branch: 'b',
  state: 'open', createdAt: 'c', updatedAt: 'u', mergedAt: null, closedAt: null,
  ciStatus: 'passing', reviewState: 'none', comments: [], ...o,
});

test('enrichPr merges issue comments, review comments, and review bodies into one sorted (oldest-first) list, sets reviewState, leaves CI to discovery, and marks the PR enriched', async () => {
  const pr = basePr();
  const fetchMock = vi.fn((url: string | URL) => {
    const u = String(url);
    if (u.includes('/issues/5/comments')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([
        { user: { login: 'alice' }, body: 'issue comment', created_at: '2026-01-02T00:00:00Z' },
      ]) });
    }
    if (u.includes('/pulls/5/comments')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([
        { user: { login: 'bob' }, body: 'review comment', created_at: '2026-01-01T00:00:00Z' },
      ]) });
    }
    if (u.includes('/pulls/5/reviews')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([
        { state: 'APPROVED', user: { login: 'carol' }, submitted_at: '2026-01-03T00:00:00Z', body: 'lgtm' },
      ]) });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: GithubConfig = { token: 't', org: 'o', repos: [], username: 'me' };
  const result = await enrichPr(pr, cfg);
  // Oldest first: bob (Jan 1) -> alice (Jan 2) -> carol's review body (Jan 3).
  expect(result.comments.map(c => c.author)).toEqual(['bob', 'alice', 'carol']);
  expect(result.comments.map(c => c.body)).toEqual(['review comment', 'issue comment', 'lgtm']);
  // CI came with discovery (the head commit rollup); enrichment never asks
  // check-runs and never touches it (#72).
  expect(result.ciStatus).toBe('passing');
  expect(fetchMock.mock.calls.some(([u]) => String(u).includes('check-runs'))).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(result.reviewState).toBe('approved');
  expect(result.enriched).toBe(true);
});

test('enrichPr keeps a pending review request ahead of an older approval', async () => {
  vi.stubGlobal('fetch', fakeGithub({}, u => u.includes('/reviews')
    ? [{ state: 'APPROVED', user: { login: 'carol' }, submitted_at: '2026-01-03T00:00:00Z' }]
    : []));
  const pr = await enrichPr(basePr({ reviewState: 'review_required' }), { token: 't', org: 'o', repos: [], username: 'me' });
  expect(pr.reviewState).toBe('review_required');
});

test('fetchPrs filters by author server-side in one GraphQL search per repo, no per-PR detail request', async () => {
  const fetchMock = fakeGithub({
    'o/r': [
      gqlPr({ number: 1, url: 'u1', headRefName: 'b1' }),
      gqlPr({ number: 4, url: 'u4', headRefName: 'b4', state: 'MERGED', mergedAt: '2026-07-01T00:00:00Z' }),
      // An Issue node (search type ISSUE can return one) is an empty object
      // under the PullRequest fragment and must be skipped, not mapped.
      {},
    ],
  });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: GithubConfig = { token: 't', org: 'o', repos: ['r'], username: 'me' };
  resetGithubStats();
  const { prs, errors } = await fetchPrs(cfg);
  expect(errors).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]! as [string, FetchInit];
  expect(url).toBe('https://api.github.com/graphql');
  expect(init.method).toBe('POST');
  const q = (JSON.parse(init.body ?? '') as { variables: { q: string } }).variables.q;
  expect(q).toContain('is:pr');
  expect(q).toContain('author:me');
  expect(q).toContain('repo:o/r');
  // Best-match is the GraphQL search default; the window must be by updated.
  expect(q).toContain('sort:updated-desc');
  expect(prs.map(p => p.number)).toEqual([1, 4]);
  expect(prs[0]!.branch).toBe('b1');       // headRefName survives the mapping
  expect(prs[1]!.state).toBe('merged');    // mergedAt survives the mapping
  expect(githubStats()).toMatchObject({ requests: 1, byFamily: { graphql: 1 } });
});

test('fetchPrs preserves an owner-qualified repository entry', async () => {
  const fetchMock = fakeGithub({ 'other/repo': [gqlPr({ number: 1 })] });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: GithubConfig = { token: 't', org: 'o', repos: ['other/repo'], username: 'me' };
  const { prs, errors } = await fetchPrs(cfg);
  expect(errors).toEqual([]);
  expect(prs[0]!.repo).toBe('other/repo');
});

test('fetchPrs isolates a per-repo failure into an "org/repo: message" error, without blanking the other repos', async () => {
  const fetchMock = vi.fn((url: string | URL, init?: FetchInit) => {
    const q = String((JSON.parse(init?.body ?? '{}') as { variables?: { q?: string } }).variables?.q ?? '');
    if (q.includes('repo:o/good')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { search: { nodes: [gqlPr({ number: 1 })] } } }) });
    }
    if (q.includes('repo:o/bad')) {
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') });
    }
    if (q.includes('repo:o/gql-error')) {
      // GraphQL reports some failures as a 200 with an errors array.
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: null, errors: [{ message: 'Could not resolve to a Repository' }] }) });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: GithubConfig = { token: 't', org: 'o', repos: ['good', 'bad', 'gql-error'], username: 'me' };
  const { prs, errors } = await fetchPrs(cfg);
  expect(prs).toHaveLength(1);
  expect(prs[0]!.number).toBe(1);
  expect(errors).toHaveLength(2);
  expect(errors[0]).toContain('o/bad:');
  expect(errors[0]).toContain('500');
  expect(errors[1]).toContain('o/gql-error:');
  expect(errors[1]).toContain('Could not resolve');
});

test('gh() sends If-None-Match on repeat calls and serves the cached body on 304', async () => {
  // Unique repo name: the etag cache is module-level and keyed by path, so
  // this test must not collide with paths other tests use.
  const etagged = (h: string) => h.toLowerCase() === 'etag' ? '"abc123"' : null;
  let reviewCalls = 0;
  let secondReviewHeaders: Record<string, string> | undefined;
  const fetchMock = vi.fn((url: string, init: FetchInit) => {
    const u = String(url);
    if (u.includes('/repos/etag-org/etag-repo/pulls/1/reviews')) {
      reviewCalls++;
      if (reviewCalls === 1) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: etagged },
          json: () => Promise.resolve([{ state: 'APPROVED', user: { login: 'a' }, submitted_at: '1' }]),
        });
      }
      secondReviewHeaders = init.headers;
      return Promise.resolve({ ok: false, status: 304, headers: { get: () => null } });
    }
    // Comment endpoints: no etag header, so they stay uncached — irrelevant here.
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: GithubConfig = { token: 't', org: 'etag-org', repos: ['etag-repo'], username: 'me' };

  const first = await enrichPr(basePr({ repo: 'etag-org/etag-repo', number: 1 }), cfg);
  expect(first.reviewState).toBe('approved');

  resetGithubStats();
  const second = await enrichPr(basePr({ repo: 'etag-org/etag-repo', number: 1 }), cfg);
  expect(secondReviewHeaders?.['If-None-Match']).toBe('"abc123"');
  // 304 is not an error: the cached reviews body is served as if fresh, and
  // the stats line shows it as a request that was not modified.
  expect(second.reviewState).toBe('approved');
  expect(githubStats()).toMatchObject({ requests: 3, notModified: 1, byFamily: { reviews: 1, issue_comments: 1, review_comments: 1 } });
});

// #69: GitHub's secondary rate limit answered a large enrich sweep with a 403,
// which gh() threw immediately, so a transient throttle became a raw error
// banner and a degraded refresh. gh() now honors GitHub's documented contract
// (Retry-After / x-ratelimit-reset, exponential backoff otherwise) and only
// throws once the retry budget is spent.

const headers = (h: Record<string, string> = {}) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
const SECONDARY = '{ "message": "You have exceeded a secondary rate limit." }';

test('throttleWaitMs recognises a throttle and picks the longest applicable wait', () => {
  const now = 1_000_000;
  // Body text alone is enough: GitHub often sends no Retry-After with a
  // secondary limit, so the exponential backoff is the floor.
  expect(throttleWaitMs({ status: 403, headers: headers() }, SECONDARY, 0, now)).toBe(1000);
  expect(throttleWaitMs({ status: 403, headers: headers() }, SECONDARY, 2, now)).toBe(4000);
  // Retry-After wins when it asks for longer than the backoff.
  expect(throttleWaitMs({ status: 429, headers: headers({ 'retry-after': '5' }) }, 'slow down', 0, now)).toBe(5000);
  expect(throttleWaitMs({ status: 429, headers: headers({ 'retry-after': '0' }) }, SECONDARY, 0, now)).toBe(1000);
  // Exhausted quota with a reset timestamp: wait until the reset, not past it.
  expect(throttleWaitMs(
    { status: 403, headers: headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 30) }) },
    'API rate limit exceeded', 0, now)).toBe(30_000);
  // Never block the refresh for longer than the cap, however far off the reset.
  expect(throttleWaitMs(
    { status: 403, headers: headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 3600) }) },
    'API rate limit exceeded', 0, now)).toBe(60_000);
});

test('throttleWaitMs leaves a non-throttle failure alone', () => {
  // A 403 from a bad token or an invisible repo must fail fast; retrying it
  // only delays the banner. Same for anything that isn't 403/429.
  expect(throttleWaitMs({ status: 403, headers: headers() }, '{ "message": "Bad credentials" }', 0)).toBeNull();
  expect(throttleWaitMs({ status: 404, headers: headers({ 'retry-after': '5' }) }, 'nope', 0)).toBeNull();
  expect(throttleWaitMs({ status: 500, headers: headers() }, SECONDARY, 0)).toBeNull();
  // A response object with no headers at all (test stubs, minimal shims).
  expect(throttleWaitMs({ status: 403 }, 'forbidden', 0)).toBeNull();
});

test('isThrottleMessage separates a throttle from a real failure', () => {
  expect(isThrottleMessage(`GitHub 403 /repos/o/r/issues/1/comments: ${SECONDARY}`)).toBe(true);
  expect(isThrottleMessage('GitHub 403 /repos/o/r: { "message": "API rate limit exceeded" }')).toBe(true);
  expect(isThrottleMessage('GitHub 404 /repos/o/r: not found')).toBe(false);
  expect(isThrottleMessage(undefined)).toBe(false);
});

test('gh backs off and retries a secondary rate limit instead of surfacing it', async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls++;
      if (calls <= 2) {
        return Promise.resolve({ ok: false, status: 403, headers: headers(), text: () => Promise.resolve(SECONDARY) });
      }
      return Promise.resolve({ ok: true, headers: headers(), json: () => Promise.resolve({ data: { search: { nodes: [gqlPr({ number: 3 })] } } }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const cfg: GithubConfig = { token: 't', org: 'o', repos: ['throttled'], username: 'me' };
    resetGithubStats();
    const pending = fetchPrs(cfg);
    await vi.runAllTimersAsync();
    const { prs, errors } = await pending;
    expect(errors).toEqual([]);
    expect(prs.map(p => p.number)).toEqual([3]);
    expect(calls).toBe(3);
    expect(githubStats()).toMatchObject({ requests: 3, retries: 2 });
  } finally {
    vi.useRealTimers();
  }
});

test('gh gives up after the retry budget, and a non-throttle 403 is not retried at all', async () => {
  vi.useFakeTimers();
  try {
    const throttleFetch = vi.fn(() => Promise.resolve(
      { ok: false, status: 403, headers: headers(), text: () => Promise.resolve(SECONDARY) }));
    vi.stubGlobal('fetch', throttleFetch);
    const cfg: GithubConfig = { token: 't', org: 'o', repos: ['always-throttled'], username: 'me' };
    const pending = fetchPrs(cfg);
    await vi.runAllTimersAsync();
    const { errors } = await pending;
    // 1 initial attempt + 3 retries, then the error reaches the caller with the
    // body intact so refresh.ts can recognise it as a throttle.
    expect(throttleFetch).toHaveBeenCalledTimes(4);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('secondary rate limit');

    const badToken = vi.fn(() => Promise.resolve(
      { ok: false, status: 403, headers: headers(), text: () => Promise.resolve('{ "message": "Bad credentials" }') }));
    vi.stubGlobal('fetch', badToken);
    const bad = fetchPrs({ ...cfg, repos: ['bad-token'] });
    await vi.runAllTimersAsync();
    expect((await bad).errors[0]).toContain('Bad credentials');
    expect(badToken).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
