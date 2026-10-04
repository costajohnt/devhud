import { test, expect, vi, afterEach } from 'vitest';
import { mapPr, newCiFailures, ciBaseVerdict, ciFromRollup, reviewStateFrom, fetchPrs, enrichPr, throttleWaitMs, isThrottleMessage, githubStats, resetGithubStats, resetGithubRateLimit, lastPageFromLink } from './github.ts';
import { classifyCard } from './classify.ts';
import type { Pr, GithubConfig, Card, CardState } from './types.ts';

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

test('lastPageFromLink reads rel="last", and none means a single page', () => {
  expect(lastPageFromLink('<https://api.github.com/repositories/1/issues/5/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/issues/5/comments?per_page=100&page=4>; rel="last"')).toBe(4);
  expect(lastPageFromLink('<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=1>; rel="first"')).toBeNull();
  expect(lastPageFromLink(null)).toBeNull();
});

// L2 (audit 2026-10-04): issue comments ignore sort/direction, so >100
// comments used to return only the oldest 100.
test('enrichPr fetches the newest issue comments on a thread longer than one page', async () => {
  const pages: Record<string, { body: unknown[]; link?: string }> = {};
  const comment = (n: number) => ({ user: { login: n === 350 ? 'human' : 'bot' }, body: `c${n}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString() });
  const page = (n: number) => Array.from({ length: n === 4 ? 50 : 100 }, (_, i) => comment((n - 1) * 100 + i + 1));
  const lastLink = '<https://api.github.com/repositories/9/issues/5/comments?per_page=100&page=4>; rel="last"';
  pages['/repos/lp-org/lp-repo/issues/5/comments?per_page=100'] = { body: page(1), link: lastLink };
  pages['/repos/lp-org/lp-repo/issues/5/comments?per_page=100&page=3'] = { body: page(3) };
  pages['/repos/lp-org/lp-repo/issues/5/comments?per_page=100&page=4'] = { body: page(4) };
  const fetchMock = vi.fn((url: string | URL) => {
    const path = String(url).replace('https://api.github.com', '');
    const hit = pages[path];
    const body = hit?.body ?? [];
    return Promise.resolve({ ok: true, status: 200, headers: headers(hit?.link ? { link: hit.link } : {}), json: () => Promise.resolve(body) });
  });
  vi.stubGlobal('fetch', fetchMock);
  resetGithubStats();
  const pr = await enrichPr(basePr({ repo: 'lp-org/lp-repo', number: 5 }), { token: 't', org: 'lp-org', repos: [], username: 'me' });
  // Pages 3 and 4: the newest 150 of 350, including the newest human comment.
  expect(pr.comments).toHaveLength(150);
  expect(pr.comments.at(-1)).toMatchObject({ author: 'human', body: 'c350' });
  expect(pr.comments[0]?.body).toBe('c201');
  expect(githubStats().byFamily.issue_comments).toBe(3);
  expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/issues/5/comments') && String(u).includes('sort='))).toBe(false);
});

test('enrichPr keeps both pages of a two-page issue-comment thread, at one extra request', async () => {
  const comment = (n: number) => ({ user: { login: 'u' }, body: `c${n}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString() });
  const fetchMock = vi.fn((url: string | URL) => {
    const u = String(url);
    const body = u.endsWith('/issues/6/comments?per_page=100') ? Array.from({ length: 100 }, (_, i) => comment(i + 1))
      : u.endsWith('/issues/6/comments?per_page=100&page=2') ? [comment(101)] : [];
    const link = u.endsWith('/issues/6/comments?per_page=100') ? '<https://api.github.com/x?per_page=100&page=2>; rel="next", <https://api.github.com/x?per_page=100&page=2>; rel="last"' : null;
    return Promise.resolve({ ok: true, status: 200, headers: headers(link ? { link } : {}), json: () => Promise.resolve(body) });
  });
  vi.stubGlobal('fetch', fetchMock);
  resetGithubStats();
  const pr = await enrichPr(basePr({ repo: 'lp-org/lp-two', number: 6 }), { token: 't', org: 'lp-org', repos: [], username: 'me' });
  expect(pr.comments).toHaveLength(101);
  expect(githubStats().byFamily.issue_comments).toBe(2);
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

// M2 (audit 2026-10-04): the per-wait cap alone let an exhausted primary
// limit block fetchPrs over 3 repos for 9 simulated minutes.
test('an exhausted primary limit with a far reset fails this and later requests fast, without waiting', async () => {
  vi.useFakeTimers();
  try {
    const exhausted = vi.fn(() => Promise.resolve({
      ok: false, status: 403,
      headers: headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) }),
      text: () => Promise.resolve('{ "message": "API rate limit exceeded for user." }'),
    }));
    vi.stubGlobal('fetch', exhausted);
    resetGithubStats();
    const start = Date.now();
    const pending = fetchPrs({ token: 't', org: 'o', repos: ['rl-a', 'rl-b', 'rl-c'], username: 'me' });
    await vi.runAllTimersAsync();
    const { errors } = await pending;
    // One request reached GitHub; the other repos failed without a fetch.
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(Date.now() - start).toBe(0);
    expect(errors).toHaveLength(3);
    expect(errors.every(e => isThrottleMessage(e))).toBe(true);
    // The marker outlives the refresh until the reset passes...
    resetGithubStats();
    const later = await fetchPrs({ token: 't', org: 'o', repos: ['rl-a'], username: 'me' });
    expect(later.errors[0]).toMatch(/rate limit exceeded until/);
    expect(exhausted).toHaveBeenCalledTimes(1);
  } finally {
    resetGithubRateLimit();
    vi.useRealTimers();
  }
});

test('the GraphQL rate-limit marker does not block REST, and clears once the reset passes', async () => {
  vi.useFakeTimers();
  try {
    const reset = Math.floor(Date.now() / 1000) + 600;
    let graphqlCalls = 0;
    vi.stubGlobal('fetch', vi.fn((url: string | URL) => {
      if (String(url).endsWith('/graphql')) {
        graphqlCalls++;
        return Promise.resolve({ ok: false, status: 403, headers: headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
          text: () => Promise.resolve('{ "message": "API rate limit exceeded" }') });
      }
      return Promise.resolve({ ok: true, status: 200, headers: headers(), json: () => Promise.resolve([]) });
    }));
    resetGithubStats();
    expect((await fetchPrs({ token: 't', org: 'o', repos: ['gq-a', 'gq-b'], username: 'me' })).errors).toHaveLength(2);
    expect(graphqlCalls).toBe(1);
    // REST is a separate budget: enrichment still goes out.
    const pr = await enrichPr(basePr({ repo: 'o/gq-a', number: 2 }), { token: 't', org: 'o', repos: [], username: 'me' });
    expect(pr.enriched).toBe(true);
    // Past the reset, GraphQL is tried again.
    await vi.advanceTimersByTimeAsync(601_000);
    // (The stub still answers with the old, now-past reset, so this one
    // backs off briefly rather than failing fast.)
    const retried = fetchPrs({ token: 't', org: 'o', repos: ['gq-a'], username: 'me' });
    await vi.runAllTimersAsync();
    await retried;
    expect(graphqlCalls).toBeGreaterThan(1);
  } finally {
    resetGithubRateLimit();
    vi.useRealTimers();
  }
});

test('total throttle backoff in one refresh is capped by a budget, then requests fail fast', async () => {
  vi.useFakeTimers();
  try {
    // A secondary limit that always asks for the full capped wait.
    const throttled = vi.fn(() => Promise.resolve(
      { ok: false, status: 429, headers: headers({ 'retry-after': '60' }), text: () => Promise.resolve(SECONDARY) }));
    vi.stubGlobal('fetch', throttled);
    resetGithubStats();
    const start = Date.now();
    const pending = fetchPrs({ token: 't', org: 'o', repos: ['budget-a', 'budget-b', 'budget-c'], username: 'me' });
    await vi.runAllTimersAsync();
    const { errors } = await pending;
    expect(errors).toHaveLength(3);
    // Without the budget: 3 repos x 3 waits x 60s = 9 minutes. With it, one
    // 60s wait fits in the 90s budget, and every later throttle fails at once.
    expect(Date.now() - start).toBe(60_000);
    expect(throttled).toHaveBeenCalledTimes(4);
    // A new refresh gets a new budget.
    resetGithubStats();
    const again = fetchPrs({ token: 't', org: 'o', repos: ['budget-a'], username: 'me' });
    await vi.runAllTimersAsync();
    await again;
    expect(throttled).toHaveBeenCalledTimes(6);
  } finally {
    vi.useRealTimers();
  }
});

// --- #79: CI failures that pre-exist on the base branch ---

const rollup = (checks: Record<string, string>) => ({
  state: 'FAILURE',
  contexts: { nodes: Object.entries(checks).map(([name, conclusion]) => ({ name, conclusion })) },
});

test('newCiFailures: PR red, base green on the same checks -> the PR failures', () => {
  expect(newCiFailures(rollup({ test: 'FAILURE', lint: 'SUCCESS' }), rollup({ test: 'SUCCESS', lint: 'SUCCESS' }))).toEqual(['test']);
});

test('newCiFailures: PR red on exactly the checks red on base -> []', () => {
  expect(newCiFailures(rollup({ test: 'FAILURE' }), rollup({ test: 'FAILURE' }))).toEqual([]);
});

test('newCiFailures: superset of the base failures -> only the new ones', () => {
  expect(newCiFailures(rollup({ test: 'FAILURE', lint: 'TIMED_OUT' }), rollup({ test: 'FAILURE', lint: 'SUCCESS' }))).toEqual(['lint']);
});

test('newCiFailures: legacy commit statuses compare by context', () => {
  const status = (context: string, state: string) => ({ state: 'FAILURE', contexts: { nodes: [{ context, state }] } });
  expect(newCiFailures(status('ci/legacy', 'ERROR'), status('ci/legacy', 'FAILURE'))).toEqual([]);
});

test('newCiFailures: base data unavailable, or no named head failure -> undefined (keep flagging)', () => {
  expect(newCiFailures(rollup({ test: 'FAILURE' }), null)).toBeUndefined();
  expect(newCiFailures(rollup({ test: 'FAILURE' }), { state: 'FAILURE' })).toBeUndefined();
  expect(newCiFailures(rollup({ test: 'SUCCESS' }), rollup({ test: 'FAILURE' }))).toBeUndefined();
});

// #86: base rollup incomplete — suppress rather than assert new failures

test('newCiFailures: base has in-progress CheckRun (conclusion null) -> undefined', () => {
  const inProgressBase = {
    state: 'PENDING',
    contexts: { nodes: [{ name: 'test', conclusion: null as string | null }] },
  };
  expect(newCiFailures(rollup({ test: 'FAILURE' }), inProgressBase)).toBeUndefined();
});

test('newCiFailures: base has pending StatusContext -> undefined', () => {
  const pendingBase = {
    state: 'PENDING',
    contexts: { nodes: [{ context: 'ci/status', state: 'pending' }] },
  };
  const headStatus = { state: 'FAILURE', contexts: { nodes: [{ context: 'ci/status', state: 'ERROR' }] } };
  expect(newCiFailures(headStatus, pendingBase)).toBeUndefined();
});

test('newCiFailures: failing head check absent from base rollup entirely -> undefined', () => {
  // base ran different checks; head failure has no base verdict yet
  expect(newCiFailures(rollup({ 'new-check': 'FAILURE' }), rollup({ 'other-check': 'SUCCESS' }))).toBeUndefined();
});

test('ciBaseVerdict marks only a still-running base as pending', () => {
  const running = { state: 'PENDING', contexts: { nodes: [{ name: 'test', conclusion: null as string | null }] } };
  expect(ciBaseVerdict(rollup({ test: 'FAILURE' }), running)).toEqual({ basePending: true });
  // The rollup's own PENDING state counts even when the node for the failing
  // head check has not appeared on base yet.
  expect(ciBaseVerdict(rollup({ test: 'FAILURE' }), { ...rollup({ lint: 'SUCCESS' }), state: 'PENDING' })).toEqual({ basePending: true });
  // Missing base data, or a check absent from a finished base: unknown, not pending.
  expect(ciBaseVerdict(rollup({ test: 'FAILURE' }), null)).toEqual({ basePending: false });
  expect(ciBaseVerdict(rollup({ 'new-check': 'FAILURE' }), rollup({ other: 'SUCCESS' }))).toEqual({ basePending: false });
  expect(ciBaseVerdict(rollup({ test: 'FAILURE' }), rollup({ test: 'FAILURE' }))).toEqual({ newFailures: [], basePending: false });
});

// H2 (audit 2026-10-04): the #89 tests only checked the helper, so the board
// still flagged a pre-existing failure for the whole base run. End to end:
const statuses = { todo: 'To Do', inTest: 'In Test', done: 'Done', canceled: 'Canceled' };
const jiraCard: Card = { key: 'PROJ-1', status: 'In Progress', myAccountId: 'me', comments: [], summary: '', description: '', url: '', createdAt: null, updatedAt: null };
const cardState: CardState = { lastSeenPr: null, lastSeenJira: null, override: null, overrideAt: null };
const classifyNode = (baseRollup: unknown) => classifyCard({
  card: jiraCard, cs: cardState, statuses, username: 'me',
  pr: mapPr(gqlPr({
    commits: { nodes: [{ commit: { statusCheckRollup: rollup({ test: 'FAILURE' }) } }] },
    baseRef: { target: { statusCheckRollup: baseRollup as never } },
  }), 'o/r'),
});

test('mapPr -> classifyCard: a failure already red on a finished base does not flag', () => {
  const r = classifyNode(rollup({ test: 'FAILURE' }));
  expect(r.attention).not.toContain('ci_failing');
  expect(r.bucket).toBe('waiting_review');
});

test('mapPr -> classifyCard: a still-running base does not flag', () => {
  const r = classifyNode({ state: 'PENDING', contexts: { nodes: [{ name: 'test', conclusion: null }] } });
  expect(r.attention).not.toContain('ci_failing');
  expect(r.bucket).toBe('waiting_review');
});

test('mapPr -> classifyCard: a new failure on a finished base, or no base data, still flags', () => {
  expect(classifyNode(rollup({ test: 'SUCCESS' })).attention).toContain('ci_failing');
  expect(classifyNode(null).attention).toContain('ci_failing');
  expect(classifyNode(null).bucket).toBe('needs_attention');
});

test('mapPr sets ciNewFailures only on an open failing PR', () => {
  const node = (state: string, headState: string) => ({
    number: 1, url: '', state, createdAt: '', updatedAt: '',
    commits: { nodes: [{ commit: { statusCheckRollup: { ...rollup({ test: 'FAILURE' }), state: headState } } }] },
    baseRef: { target: { statusCheckRollup: rollup({ test: 'FAILURE' }) } },
  });
  expect(mapPr(node('OPEN', 'FAILURE'), 'o/r').ciNewFailures).toEqual([]);
  expect('ciNewFailures' in mapPr(node('OPEN', 'SUCCESS'), 'o/r')).toBe(false);
  expect('ciNewFailures' in mapPr(node('MERGED', 'FAILURE'), 'o/r')).toBe(false);
});
