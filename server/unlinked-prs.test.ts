import { test, expect } from 'vitest';
import { buildSnapshot } from './refresh.ts';
import { applyAction } from './actions.ts';
import { emptyState } from './state.ts';
import type { Config, Pr } from './types.ts';

const config: Config = {
  jira: { projectKey: 'P', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
  github: { username: 'me', org: 'o', token: 't', repos: ['r'] },
  port: 3010, demo: false, writeEnabled: false,
};
const pr = (o: Partial<Pr> = {}): Pr => ({
  repo: 'o/r', number: 4, url: 'https://gh/o/r/4', title: 'Bump node', body: '', branch: 'chore-node', state: 'open',
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-05T00:00:00Z', mergedAt: null, closedAt: null,
  ciStatus: 'failing', reviewState: 'changes_requested', enriched: true,
  comments: [
    { author: 'amy', body: 'please pin it', createdAt: '2026-07-03T00:00:00Z' },
    { author: 'me', body: 'will do', createdAt: '2026-07-03T01:00:00Z' },
  ],
  ...o,
});
const build = (state: ReturnType<typeof emptyState>, prs: Pr[], errors: { github?: string } = {}) =>
  (state.snapshot = buildSnapshot({ cards: [], prs, state, config, errors }));

test('a card-less open PR feeds the queue with its own reasons, keyed by PR ref', () => {
  const state = emptyState();
  const snap = build(state, [pr(), pr({ number: 5, state: 'merged', mergedAt: '2026-07-04T00:00:00Z' })]);
  expect(snap.unlinkedPrs.map(u => u.number)).toEqual([4]);
  expect(snap.queue.map(e => [e.kind, e.key, e.reason, e.priority])).toEqual([
    ['pr', 'o/r#4', 'ci_failing', 1],
    ['pr', 'o/r#4', 'changes_requested', 1],
    ['pr', 'o/r#4', 'new_pr_comments', 2],
  ]);
  const comments = snap.queue[2]!;
  expect(comments.title).toBe('1 new PR comment from amy');
  expect(comments.url).toBe('https://gh/o/r/4');
});

test('acking a card-less PR entry dismisses just that reason and survives the next refresh', () => {
  const state = emptyState();
  build(state, [pr()]);
  expect(applyAction({ state, config, type: 'ack', key: 'o/r#4', reason: 'new_pr_comments' })).toEqual({ ok: true, bucket: null });
  expect(applyAction({ state, config, type: 'ack', key: 'o/r#4', reason: 'changes_requested' })).toEqual({ ok: true, bucket: null });
  expect(state.snapshot!.queue.map(e => e.reason)).toEqual(['ci_failing']);

  const again = build(state, [pr()]);
  expect(again.queue.map(e => e.reason)).toEqual(['ci_failing']);
  // A new comment after the ack flags again; the review state stays muted
  // while it is continuously true.
  const later = build(state, [pr({ comments: [...pr().comments, { author: 'amy', body: 'ping', createdAt: new Date(Date.now() + 60_000).toISOString() }] })]);
  expect(later.queue.map(e => e.reason)).toEqual(['ci_failing', 'new_pr_comments']);
});

test('a reason the PR does not show, or an unknown PR, records nothing', () => {
  const state = emptyState();
  build(state, [pr({ ciStatus: 'passing', reviewState: 'none', comments: [] })]);
  expect(applyAction({ state, config, type: 'ack', key: 'o/r#4', reason: 'ci_failing' })).toEqual({ ok: true, bucket: null });
  expect(applyAction({ state, config, type: 'ack', key: 'o/r#99', reason: 'ci_failing' })).toEqual({ ok: true, bucket: null });
  expect(state.ownPrs!['o/r#4']!.ackedReasons ?? null).toBeNull();
  expect(state.ownPrs!['o/r#99']).toBeUndefined();
});

test('ownPrs is pruned when a PR closes, but kept while its repo is degraded', () => {
  const state = emptyState();
  build(state, [pr()]);
  expect(Object.keys(state.ownPrs!)).toEqual(['o/r#4']);
  build(state, [], { github: 'o/r: 500' });
  expect(Object.keys(state.ownPrs!)).toEqual(['o/r#4']);
  build(state, []);
  expect(state.ownPrs).toEqual({});
});
