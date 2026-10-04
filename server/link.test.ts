import { test, expect } from 'vitest';
import { linkPrsToCards, unlinked } from './link.ts';
import type { Card, Pr } from './types.ts';

const card = (key: string, description = ''): Card => ({ key, url: `https://x.atlassian.net/browse/${key}`, description, summary: '', status: '', myAccountId: '', createdAt: null, updatedAt: null, comments: [] });
const pr = (o: Partial<Pr> = {}): Pr => ({ repo: 'org/r', number: 1, url: 'https://github.com/org/r/pull/1', title: '', body: '', branch: '', state: 'open', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', mergedAt: null, closedAt: null, ciStatus: 'unknown', reviewState: 'none', comments: [], ...o });

test('links by branch name, case-insensitive', () => {
  const m = linkPrsToCards([card('PROJ-12')], [pr({ branch: 'proj-12-fix-thing' })], 'PROJ');
  expect(m.get('PROJ-12')!.number).toBe(1);
});

test('does not partial-match PROJ-1 against PROJ-12 branch', () => {
  const m = linkPrsToCards([card('PROJ-1')], [pr({ branch: 'PROJ-12-fix' })], 'PROJ');
  expect(m.get('PROJ-1')).toBeUndefined();
});

test('does not match APP-12 as a substring of WEBAPP-12-fix', () => {
  const m = linkPrsToCards([card('APP-12')], [pr({ branch: 'WEBAPP-12-fix' })], 'APP');
  expect(m.get('APP-12')).toBeUndefined();
});

test('links by card URL in PR body and PR URL in card description', () => {
  const m1 = linkPrsToCards([card('PROJ-3')], [pr({ body: 'closes https://x.atlassian.net/browse/PROJ-3' })], 'PROJ');
  expect(m1.get('PROJ-3')).toBeDefined();
  const m2 = linkPrsToCards([card('PROJ-4', 'see https://github.com/org/r/pull/1')], [pr({})], 'PROJ');
  expect(m2.get('PROJ-4')).toBeDefined();
});

// L1 (audit 2026-10-04): the URL checks were plain substring matches.
test('URL matches stop at a digit boundary: /pull/1 is not /pull/12, /browse/PROJ-1 is not PROJ-12', () => {
  const pr12 = pr({ number: 12, url: 'https://github.com/org/r/pull/12' });
  // Card PROJ-1 names PR #12 in its description; PR #1 must not ride along.
  const byDesc = linkPrsToCards([card('PROJ-1', 'see https://github.com/org/r/pull/12')], [pr(), pr12]);
  expect(byDesc.get('PROJ-1')?.number).toBe(12);
  expect(linkPrsToCards([card('PROJ-1', 'see https://github.com/org/r/pull/12')], [pr()]).size).toBe(0);
  // A trailing path or punctuation after the URL still matches.
  expect(linkPrsToCards([card('PROJ-1', 'https://github.com/org/r/pull/1/files.')], [pr()]).size).toBe(1);
  // PR body links PROJ-12 only.
  const body = pr({ body: 'Fixes https://x.atlassian.net/browse/PROJ-12' });
  expect(linkPrsToCards([card('PROJ-1')], [body]).size).toBe(0);
  expect(linkPrsToCards([card('PROJ-12')], [body]).get('PROJ-12')).toBe(body);
});

test('prefers open PR over merged when both match', () => {
  const open = pr({ number: 2, url: 'u2', branch: 'PROJ-5-b', state: 'open' });
  const merged = pr({ number: 3, url: 'u3', branch: 'PROJ-5-a', state: 'merged' });
  const m = linkPrsToCards([card('PROJ-5')], [merged, open], 'PROJ');
  expect(m.get('PROJ-5')!.number).toBe(2);
});

test('prefers merged PR over newer closed-unmerged PR', () => {
  const merged = pr({ number: 10, url: 'u10', branch: 'PROJ-7-a', state: 'merged', updatedAt: '2026-08-01T00:00:00Z' });
  const closed = pr({ number: 11, url: 'u11', branch: 'PROJ-7-a', state: 'closed', updatedAt: '2026-09-01T00:00:00Z' });
  const m = linkPrsToCards([card('PROJ-7')], [closed, merged], 'PROJ');
  expect(m.get('PROJ-7')!.number).toBe(10);
});

test('card key with regex metacharacters does not throw and does not false-match', () => {
  expect(() => linkPrsToCards([card('PROJ(1')], [pr({ branch: 'proj-12-fix-thing' })], 'PROJ')).not.toThrow();
  const m = linkPrsToCards([card('PROJ(1')], [pr({ branch: 'proj-12-fix-thing' })], 'PROJ');
  expect(m.get('PROJ(1')).toBeUndefined();
});

test('unlinked returns leftover PRs', () => {
  const prs = [pr({ branch: 'PROJ-6-x' }), pr({ number: 9, branch: 'random' })];
  const m = linkPrsToCards([card('PROJ-6')], prs, 'PROJ');
  expect(unlinked(prs, m).map(p => p.number)).toEqual([9]);
});
