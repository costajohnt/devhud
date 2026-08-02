import { test, expect } from 'vitest';
import { mapPr, ciFromCheckRuns, reviewStateFrom } from './github.ts';

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
