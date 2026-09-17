// @vitest-environment happy-dom
import { test, expect } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { FiledPage } from './filed.js';
import type { DashboardData, Bucket, Item } from './types.js';

const emptyBuckets = (): Record<Bucket, Item[]> => ({
  needs_attention: [], in_progress: [], self_review: [], waiting_review: [], mergeable: [], qa_ready: [], in_qa: [],
});
const data = (overrides: Partial<DashboardData> = {}): DashboardData => ({
  updatedAt: null, errors: { jira: null, github: null }, buckets: emptyBuckets(),
  todo: [], blocked: [], filed: [], unlinkedPrs: [], doneCards: [], doneTotal: 0, newlyDone: [], recentActivity: [], prLog: [],
  ...overrides,
});
const filed = (key: string, createdAt: string | null) =>
  ({ key, summary: `Summary ${key}`, jiraStatus: 'To Do', jiraUrl: `https://j/browse/${key}`, createdAt });

test('FiledPage lists filed cards newest first and counts them', () => {
  const host = document.createElement('div');
  const d = data({ filed: [filed('P-1', '2026-07-01T00:00:00Z'), filed('P-3', '2026-09-01T00:00:00Z'), filed('P-2', null)] });
  act(() => { render(h(FiledPage, { data: d }), host); });
  const keys = [...host.querySelectorAll('tbody a')].map(a => a.textContent);
  expect(keys).toEqual(['P-3', 'P-1', 'P-2']);
  expect(host.querySelector('.merged-view-subtitle')!.textContent).toBe('3 total');
});

test('FiledPage renders the empty state when nothing has been filed', () => {
  const host = document.createElement('div');
  act(() => { render(h(FiledPage, { data: data() }), host); });
  expect(host.querySelector('.merged-view-empty')).not.toBeNull();
  expect(host.querySelector('table')).toBeNull();
});
