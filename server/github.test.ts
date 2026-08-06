import { test, expect, vi, afterEach } from 'vitest';
import { mapPr, ciFromCheckRuns, reviewStateFrom, fetchPrs, enrichPr } from './github.ts';
import type { Pr, GithubConfig } from './types.ts';

afterEach(() => vi.unstubAllGlobals());

test('mapPr basic fields + merged state', () => {
  const raw = { number: 7, html_url: 'u', title: 'T', body: 'B', head: { ref: 'PROJ-1-x' },
    state: 'closed', merged_at: '2026-07-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' };
  const p = mapPr(raw, 'org/r');
  expect(p).toMatchObject({ repo: 'org/r', number: 7, branch: 'PROJ-1-x', state: 'merged' });
});

test('ciFromCheckRuns rollup', () => {
  expect(ciFromCheckRuns([])).toBe('unknown');
  expect(ciFromCheckRuns([{ status: 'completed', conclusion: 'success' }])).toBe('passing');
  expect(ciFromCheckRuns([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }])).toBe('failing');
  expect(ciFromCheckRuns([{ status: 'in_progress', conclusion: null }])).toBe('pending');
  expect(ciFromCheckRuns([{ status: 'completed', conclusion: 'neutral' }, { status: 'completed', conclusion: 'skipped' }])).toBe('passing');
});

test('ciFromCheckRuns dedups reruns by name, keeping the latest', () => {
  const runs = [
    { name: 'build', status: 'completed', conclusion: 'failure', started_at: '2026-01-01T00:00:00Z' },
    { name: 'build', status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:05:00Z' },
  ];
  expect(ciFromCheckRuns(runs)).toBe('passing');
});

test('reviewStateFrom', () => {
  expect(reviewStateFrom({ requested_reviewers: [{}] }, [])).toBe('review_required');
  expect(reviewStateFrom({ requested_reviewers: [] }, [{ state: 'CHANGES_REQUESTED', user: { login: 'a' }, submitted_at: '1' }])).toBe('changes_requested');
  expect(reviewStateFrom({ requested_reviewers: [] }, [
    { state: 'CHANGES_REQUESTED', user: { login: 'a' }, submitted_at: '2026-01-01' },
    { state: 'APPROVED', user: { login: 'a' }, submitted_at: '2026-01-02' }])).toBe('approved');
  expect(reviewStateFrom({ requested_reviewers: [] }, [])).toBe('none');
});

// enrichPr and fetchPrs are the network-orchestration functions in this
// file — jira.ts's fetchJiraCards equivalent orchestration IS covered with
// a mocked fetch (jira.test.ts); these were not, an asymmetric gap that
// left enrichPr's comment-merge-and-sort logic (real orchestration, not a
// thin wrapper) running unverified.

test('enrichPr merges issue comments, review comments, and review bodies into one sorted (oldest-first) list, sets ciStatus/reviewState, and deletes _raw', async () => {
  const pr: Pr = {
    repo: 'o/r', number: 5, url: 'u', title: 'T', body: '', branch: 'b',
    state: 'open', createdAt: 'c', updatedAt: 'u', mergedAt: null, closedAt: null,
    ciStatus: 'unknown', reviewState: 'none', comments: [],
    _raw: { head: { sha: 'abc123' }, requested_reviewers: [], requested_teams: [] },
  };
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
    if (u.includes('/commits/abc123/check-runs')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ check_runs: [{ status: 'completed', conclusion: 'success' }] }) });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: GithubConfig = { token: 't', org: 'o', repos: [], username: 'me' };
  const result = await enrichPr(pr, cfg);
  // Oldest first: bob (Jan 1) -> alice (Jan 2) -> carol's review body (Jan 3).
  expect(result.comments.map(c => c.author)).toEqual(['bob', 'alice', 'carol']);
  expect(result.comments.map(c => c.body)).toEqual(['review comment', 'issue comment', 'lgtm']);
  expect(result.ciStatus).toBe('passing');
  expect(result.reviewState).toBe('approved');
  expect(result._raw).toBeUndefined();
});

test('enrichPr does not fetch check-runs for a non-open PR and leaves ciStatus unknown', async () => {
  const pr: Pr = {
    repo: 'o/r', number: 6, url: 'u', title: 'T', body: '', branch: 'b',
    state: 'merged', createdAt: 'c', updatedAt: 'u', mergedAt: '2026-01-01T00:00:00Z', closedAt: null,
    ciStatus: 'unknown', reviewState: 'none', comments: [],
    _raw: { head: { sha: 'zzz' } },
  };
  const fetchMock = vi.fn((url: string | URL) => {
    const u = String(url);
    if (u.includes('check-runs')) throw new Error('should not fetch check-runs for a merged PR');
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: GithubConfig = { token: 't', org: 'o', repos: [], username: 'me' };
  const result = await enrichPr(pr, cfg);
  expect(result.ciStatus).toBe('unknown');
});

test('fetchPrs filters to PRs authored by the configured username', async () => {
  const fetchMock = vi.fn((url: string | URL) => {
    const u = String(url);
    if (u.includes('/repos/o/r/pulls')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([
        { number: 1, html_url: 'u1', head: { ref: 'b1' }, state: 'open', created_at: 'c', updated_at: 'u', user: { login: 'me' } },
        { number: 2, html_url: 'u2', head: { ref: 'b2' }, state: 'open', created_at: 'c', updated_at: 'u', user: { login: 'someone-else' } },
      ]) });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: GithubConfig = { token: 't', org: 'o', repos: ['r'], username: 'me' };
  const { prs, errors } = await fetchPrs(cfg);
  expect(errors).toEqual([]);
  expect(prs).toHaveLength(1);
  expect(prs[0]!.number).toBe(1);
});

test('fetchPrs isolates a per-repo failure into an "org/repo: message" error, without blanking the other repos', async () => {
  const fetchMock = vi.fn((url: string | URL) => {
    const u = String(url);
    if (u.includes('/repos/o/good/pulls')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([
        { number: 1, html_url: 'u1', head: { ref: 'b1' }, state: 'open', created_at: 'c', updated_at: 'u', user: { login: 'me' } },
      ]) });
    }
    if (u.includes('/repos/o/bad/pulls')) {
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: GithubConfig = { token: 't', org: 'o', repos: ['good', 'bad'], username: 'me' };
  const { prs, errors } = await fetchPrs(cfg);
  expect(prs).toHaveLength(1);
  expect(prs[0]!.number).toBe(1);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('o/bad:');
  expect(errors[0]).toContain('500');
});

test('gh() sends If-None-Match on repeat calls and serves the cached body on 304', async () => {
  // Unique repo name: the etag cache is module-level and keyed by path, so
  // this test must not collide with paths other tests use.
  const listUrl = 'https://api.github.com/repos/etag-org/etag-repo/pulls?state=all&sort=updated&direction=desc&per_page=50';
  const rawPr = { number: 1, html_url: 'u', state: 'open', created_at: 'c', updated_at: 'u2', user: { login: 'me' } };
  let secondCallHeaders: Record<string, string> | undefined;
  let call = 0;
  const fetchMock = vi.fn((url: string, init: { headers: Record<string, string> }) => {
    if (url !== listUrl) throw new Error(`unexpected URL ${url}`);
    call++;
    if (call === 1) {
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: (h: string) => h.toLowerCase() === 'etag' ? '"abc123"' : null },
        json: () => Promise.resolve([rawPr]),
      });
    }
    secondCallHeaders = init.headers;
    return Promise.resolve({ ok: false, status: 304, headers: { get: () => null } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: GithubConfig = { token: 't', org: 'etag-org', repos: ['etag-repo'], username: 'me' };

  const first = await fetchPrs(cfg);
  expect(first.prs).toHaveLength(1);

  const second = await fetchPrs(cfg);
  expect(secondCallHeaders?.['If-None-Match']).toBe('"abc123"');
  // 304 is not an error: the cached body is served as if fresh.
  expect(second.errors).toEqual([]);
  expect(second.prs).toHaveLength(1);
  expect(second.prs[0]!.number).toBe(1);
});
