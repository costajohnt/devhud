import { test, expect } from 'vitest';
import { applyEvent } from './live-event.js';
import type { DashboardData } from './types.js';

const snap = (updatedAt: string | null, newlyMerged: string[] = ['P-1']): DashboardData => ({
  updatedAt,
  errors: { jira: null, github: null },
  buckets: { needs_attention: [], in_progress: [], waiting_review: [], in_qa: [] },
  todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 0, newlyMerged, recentActivity: [],
  closedPrs: [], prLog: [],
});

test('never fires on the first event of a page load — the connect message is a replay', () => {
  // Even with a non-empty newlyMerged persisted in the snapshot: this is
  // exactly the case that replayed confetti on every reload/reconnect.
  const { fire, next } = applyEvent(undefined, snap('2026-08-06T12:00:00Z'));
  expect(fire).toBe(false);
  expect(next).toBe('2026-08-06T12:00:00Z');
});

test('fires when updatedAt changes after the first event', () => {
  const first = applyEvent(undefined, snap('2026-08-06T12:00:00Z'));
  const second = applyEvent(first.next, snap('2026-08-06T12:02:00Z'));
  expect(second.fire).toBe(true);
});

test('does not fire on a re-broadcast of the same snapshot (action broadcast, reconnect replay)', () => {
  const first = applyEvent(undefined, snap('2026-08-06T12:00:00Z'));
  const replay = applyEvent(first.next, snap('2026-08-06T12:00:00Z'));
  expect(replay.fire).toBe(false);
  expect(replay.next).toBe('2026-08-06T12:00:00Z');
});

test('a placeholder snapshot (updatedAt null) on first event still arms without firing', () => {
  const first = applyEvent(undefined, snap(null, []));
  expect(first.fire).toBe(false);
  expect(first.next).toBeNull();
  // ...and the first real refresh after it fires.
  const second = applyEvent(first.next, snap('2026-08-06T12:00:00Z'));
  expect(second.fire).toBe(true);
});
