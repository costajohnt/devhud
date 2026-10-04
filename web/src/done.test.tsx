// @vitest-environment happy-dom
import { test, expect } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { DonePage } from './done.js';
import type { DashboardData, Bucket, Item } from './types.js';

const emptyBuckets = (): Record<Bucket, Item[]> => ({
  needs_attention: [], in_progress: [], self_review: [], waiting_review: [], mergeable: [], qa_ready: [], in_qa: [],
});
const done = (key: string, doneAt: string | null) =>
  ({ key, summary: `Summary ${key}`, jiraStatus: 'Done', jiraUrl: `https://j/browse/${key}`, pr: null, doneAt });
const data = (doneCards: DashboardData['doneCards']): DashboardData => ({
  updatedAt: null, errors: { jira: null, github: null }, buckets: emptyBuckets(),
  todo: [], blocked: [], filed: [], unlinkedPrs: [], doneCards, doneTotal: doneCards.length,
  newlyDone: [], recentActivity: [], prLog: [],
});

const keys = (host: HTMLElement) =>
  [...host.querySelectorAll('tbody td:first-child .merged-table-pr-link')].map(a => a.textContent);

test('DonePage renders and sorts a null doneAt without throwing', () => {
  const host = document.createElement('div');
  const d = data([done('P-1', '2026-07-01T00:00:00Z'), done('P-2', null), done('P-3', '2026-09-01T00:00:00Z')]);
  act(() => { render(h(DonePage, { data: d }), host); });
  expect(keys(host)).toEqual(['P-3', 'P-1', 'P-2']);
  const dates = [...host.querySelectorAll('.merged-table-date')].map(s => s.textContent);
  expect(dates[2]).toBe('—');
  expect(dates.join(' ')).not.toContain('1970');

  act(() => { (host.querySelector('.sortable-th') as HTMLElement).click(); });
  expect(keys(host)).toEqual(['P-2', 'P-1', 'P-3']);
});

test('DonePage renders an unparseable doneAt as a dash', () => {
  const host = document.createElement('div');
  act(() => { render(h(DonePage, { data: data([done('P-1', 'garbage')]) }), host); });
  expect(host.querySelector('.merged-table-date')!.textContent).toBe('—');
});
