import { test, expect } from 'vitest';
import { lastNMonths, monthLabel, monthlyCounts, topRepos } from './chart-panel.js';

test('lastNMonths returns n ascending UTC YYYY-MM keys ending this month', () => {
  const months = lastNMonths(6);
  expect(months).toHaveLength(6);
  const now = new Date();
  const expectedLast = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  expect(months[5]).toBe(expectedLast);
  // Ascending, no gaps: consecutive keys are exactly one month apart.
  for (let i = 1; i < months.length; i++) {
    const [py, pm] = months[i - 1]!.split('-').map(Number);
    const [cy, cm] = months[i]!.split('-').map(Number);
    const prevIdx = py! * 12 + (pm! - 1);
    const curIdx = cy! * 12 + (cm! - 1);
    expect(curIdx).toBe(prevIdx + 1);
  }
});

test('lastNMonths rolls over a UTC year boundary correctly', () => {
  // Not dependent on wall-clock date: just check the rollover arithmetic
  // directly by asking for enough months to guarantee crossing a year
  // boundary regardless of when this test runs.
  const months = lastNMonths(13);
  expect(months).toHaveLength(13);
  // 13 consecutive months always span exactly two calendar years.
  const years = new Set(months.map(m => m.split('-')[0]));
  expect(years.size).toBe(2);
  for (const m of months) {
    expect(m).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  }
  // The load-bearing assertion: consecutive keys exactly one month apart
  // ACROSS the year boundary — a rollover bug that repeats or skips a month
  // passes the format/count checks above but fails here.
  for (let i = 1; i < months.length; i++) {
    const [py, pm] = months[i - 1]!.split('-').map(Number);
    const [cy, cm] = months[i]!.split('-').map(Number);
    expect(cy! * 12 + (cm! - 1)).toBe(py! * 12 + (pm! - 1) + 1);
  }
});

test('monthLabel renders a YYYY-MM key using UTC, with no local-timezone shift', () => {
  // Fixed keys, not wall-clock dependent. The whole point of the UTC fix:
  // this must render "Jan" for "2026-01" regardless of the host timezone
  // (a local Date(2026, 0, 1) constructor would render "Dec '25" west of
  // UTC on a build agent set to e.g. America/Los_Angeles).
  expect(monthLabel('2026-01')).toContain('Jan');
  expect(monthLabel('2026-01')).toContain('26');
  expect(monthLabel('2025-12')).toContain('Dec');
});

test('monthlyCounts buckets ISO timestamps by their UTC year-month, ignoring nulls', () => {
  const months = ['2026-01', '2026-02', '2026-03'];
  const dates = ['2026-01-05T10:00:00Z', '2026-01-31T23:59:59Z', null, '2026-03-01T00:00:00Z', '2026-03-01T00:00:01Z'];
  expect(monthlyCounts(dates, months)).toEqual([2, 0, 2]);
});

test('monthlyCounts returns 0 for a month with no matching dates', () => {
  expect(monthlyCounts([], ['2026-01'])).toEqual([0]);
});

test('topRepos aggregates active/merged/closed per repo from prLog entries', () => {
  const prLog = [
    { id: 'a/r#1', repo: 'a/r', openedAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-02T00:00:00Z', closedAt: null },
    { id: 'a/r#2', repo: 'a/r', openedAt: '2026-01-01T00:00:00Z', mergedAt: null, closedAt: null },
    { id: 'b/r#1', repo: 'b/r', openedAt: '2026-01-01T00:00:00Z', mergedAt: null, closedAt: '2026-01-05T00:00:00Z' },
  ];
  const result = topRepos(prLog);
  expect(result).toEqual([
    { repo: 'a/r', active: 1, merged: 1, closed: 0 },
    { repo: 'b/r', active: 0, merged: 0, closed: 1 },
  ]);
});

test('topRepos sorts by total activity descending, then alphabetically to break ties', () => {
  const prLog = [
    { id: 'z/r#1', repo: 'z/r', openedAt: null, mergedAt: '2026-01-01T00:00:00Z', closedAt: null },
    { id: 'a/r#1', repo: 'a/r', openedAt: null, mergedAt: '2026-01-01T00:00:00Z', closedAt: null },
    { id: 'busy/r#1', repo: 'busy/r', openedAt: '2026-01-01T00:00:00Z', mergedAt: null, closedAt: null },
    { id: 'busy/r#2', repo: 'busy/r', openedAt: '2026-01-01T00:00:00Z', mergedAt: null, closedAt: null },
  ];
  const result = topRepos(prLog);
  expect(result.map(r => r.repo)).toEqual(['busy/r', 'a/r', 'z/r']); // busy/r has 2, a/r and z/r tie at 1 -> alphabetical
});

test('topRepos respects the limit parameter', () => {
  const prLog = Array.from({ length: 15 }, (_, i) => ({
    id: `repo${i}/r#1`, repo: `repo${i}/r`, openedAt: '2026-01-01T00:00:00Z', mergedAt: null, closedAt: null,
  }));
  expect(topRepos(prLog)).toHaveLength(10); // default limit
  expect(topRepos(prLog, 3)).toHaveLength(3);
});
