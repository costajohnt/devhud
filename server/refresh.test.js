import { test, expect, vi } from 'vitest';
import { buildSnapshot, refresh } from './refresh.js';
import { emptyState } from './state.js';

vi.mock('./jira.js', () => ({ fetchJiraCards: vi.fn(() => Promise.reject(new Error('jira down'))) }));
vi.mock('./github.js', () => ({
  fetchPrs: vi.fn(() => Promise.resolve({ prs: [], errors: [] })),
  enrichPr: vi.fn((p) => Promise.resolve(p)),
}));

const config = {
  jira: { projectKey: 'PROJ', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
  github: { username: 'john' },
};
const card = (o) => ({ key: 'PROJ-1', summary: 'S', status: 'In Progress', description: '',
  url: 'https://x/browse/PROJ-1', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  myAccountId: 'me', comments: [], ...o });
const pr = (o) => ({ repo: 'o/r', number: 1, url: 'https://gh/o/r/pull/1', title: '', body: '',
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
  expect(p1.todo[0].key).toBe('PROJ-2');
  expect(p1.mergedCards[0].key).toBe('PROJ-3');
  expect(p1.newlyMerged).toEqual(['PROJ-3']);
  expect(p1.mergedTotal).toBe(1);
  const p2 = buildSnapshot({ cards, prs, state, config, errors: {} });
  expect(p2.newlyMerged).toEqual([]);   // celebrated already
  expect(p2.mergedTotal).toBe(1);
});

test('unlinked PRs surface; errors pass through', () => {
  const p = buildSnapshot({ cards: [], prs: [pr({ branch: 'other' })], state: emptyState(), config, errors: { jira: 'boom' } });
  expect(p.unlinkedPrs[0].number).toBe(1);
  expect(p.errors.jira).toBe('boom');
});

test('never blanks the board: jira error reuses lastCards, errors.jira is set', async () => {
  const state = emptyState();
  state.lastCards = [card()];
  const payload = await refresh({ config, state });
  expect(payload.errors.jira).toBe('jira down');
  expect(payload.buckets.in_progress).toHaveLength(1);
  expect(payload.buckets.in_progress[0].key).toBe('PROJ-1');
});

test('recentActivity lists merges within 7 days of now', () => {
  const now = new Date().toISOString();
  const prs = [pr({ branch: 'PROJ-4-x', state: 'merged', mergedAt: now })];
  const p = buildSnapshot({ cards: [card({ key: 'PROJ-4', status: 'Done' })], prs, state: emptyState(), config, errors: {} });
  expect(p.recentActivity.some(e => e.type === 'merged')).toBe(true);
});
