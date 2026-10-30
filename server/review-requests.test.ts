import { test, expect, vi, afterEach } from 'vitest';
import { fetchReviewRequests, resetGithubRateLimit } from './github.ts';
import { buildQueue } from './queue.ts';
import { buildSnapshot } from './refresh.ts';
import { applyAction } from './actions.ts';
import { emptyState, emptySnapshot } from './state.ts';
import type { Config, GithubConfig, ReviewRequest } from './types.ts';

afterEach(() => { vi.unstubAllGlobals(); resetGithubRateLimit(); });

const statuses = { todo: 'To Do', inTest: 'In Test', done: 'Done' };
const config: Config = {
  jira: { projectKey: 'P', accountId: 'me', statuses },
  github: { username: 'me', org: 'o', token: 't', repos: ['a', 'x/b'] },
  port: 3010, demo: false, writeEnabled: false,
};
const rr = (o: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: 'o/a#9', repo: 'o/a', number: 9, url: 'https://gh/o/a/9', title: 'Add retries', author: 'sam',
  requestedAt: '2026-07-02T00:00:00Z', updatedAt: '2026-07-03T00:00:00Z', dismissed: false, ...o,
});

test('fetchReviewRequests sends one search per identity covering all its repos, and maps nodes', async () => {
  const queries: string[] = [];
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: { body?: string }) => {
    queries.push(JSON.parse(init!.body!).variables.q);
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ data: { search: { nodes: [
      { number: 9, url: 'https://gh/o/a/9', title: 'Add retries', updatedAt: '2026-07-03T00:00:00Z', author: { login: 'sam' },
        repository: { nameWithOwner: 'o/a' }, timelineItems: { nodes: [{ createdAt: '2026-07-02T00:00:00Z' }] } },
      null,
      { title: 'an Issue node, no number' },
    ] } } }) });
  }));
  const r = await fetchReviewRequests(config.github);
  expect(queries).toEqual(['is:pr is:open draft:false review-requested:me repo:o/a repo:x/b sort:updated-desc']);
  expect(r).toEqual({ requests: [rr()], errors: [] });
});

test('fetchReviewRequests isolates a failing identity into errors', async () => {
  const cfg: GithubConfig = { ...config.github, identities: [
    { username: 'work', token: 'w', repos: ['a'] },
    { username: 'home', token: 'h', repos: ['x/b'] },
  ] };
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: { headers?: Record<string, string> }) =>
    init?.headers?.Authorization === 'Bearer w'
      ? Promise.resolve({ ok: false, status: 500, headers: { get: () => null }, text: () => Promise.resolve('boom'), json: () => Promise.resolve({}) })
      : Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ data: { search: { nodes: [] } } }) })));
  const r = await fetchReviewRequests(cfg);
  expect(r.requests).toEqual([]);
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0]).toMatch(/^review requests \(work\)/);
});

test('review requests become P2 PR-kind queue entries; dismissed ones are skipped', () => {
  const q = buildQueue(emptySnapshot().buckets, statuses, [rr(), rr({ id: 'o/a#10', number: 10, dismissed: true })]);
  expect(q).toEqual([{
    id: 'o/a#9:review_requested', kind: 'pr', key: 'o/a#9', summary: 'Add retries', reason: 'review_requested',
    priority: 2, title: 'Review requested: o/a#9 Add retries (sam)', detail: null, url: 'https://gh/o/a/9', at: '2026-07-02T00:00:00Z',
  }]);
});

test('ack with a PR ref dismisses the request until the PR changes again', () => {
  const state = emptyState();
  state.snapshot = buildSnapshot({ cards: [], prs: [], state, config, errors: {}, reviewRequests: [rr()] });
  expect(state.snapshot.queue).toHaveLength(1);

  expect(applyAction({ state, config, type: 'ack', key: 'o/a#9', reason: 'review_requested' })).toEqual({ ok: true, bucket: null });
  expect(state.snapshot.queue).toEqual([]);
  expect(state.prs).toEqual({ 'o/a#9': { dismissedAt: '2026-07-03T00:00:00Z' } });

  // Same PR, unchanged: stays dismissed across a refresh.
  expect(buildSnapshot({ cards: [], prs: [], state, config, errors: {}, reviewRequests: [rr()] }).queue).toEqual([]);
  // A new push or comment bumps updatedAt: back on the queue.
  expect(buildSnapshot({ cards: [], prs: [], state, config, errors: {}, reviewRequests: [rr({ updatedAt: '2026-07-04T00:00:00Z' })] }).queue).toHaveLength(1);
});

test('a review_requested ack needs a PR ref', () => {
  const state = emptyState();
  for (const key of ['P-1', '__proto__', 'o/a', 'o/a#', 'a/b/c#1']) {
    expect(applyAction({ state, config, type: 'ack', key, reason: 'review_requested' })).toMatchObject({ status: 400 });
  }
  expect(state.prs).toBeUndefined();
});
