import { test, expect } from 'vitest';
import { foldRun } from './simon-run-fold.js';
import type { SimonEvent } from './types.js';

const EVENTS: SimonEvent[] = [
  { ts: '2026-08-01T10:00:00Z', event: 'run_start', key: 'PROJ-1', source: 'jira' },
  { ts: '2026-08-01T10:00:01Z', event: 'budgets', implement: 5, review: 3 },
  { ts: '2026-08-01T10:00:05Z', event: 'phase_start', phase: 'plan' },
  { ts: '2026-08-01T10:05:05Z', event: 'phase_end', phase: 'plan' },
  { ts: '2026-08-01T10:05:06Z', event: 'phase_start', phase: 'implement' },
  { ts: '2026-08-01T10:05:07Z', event: 'phase_retry', phase: 'implement' },
  { ts: '2026-08-01T10:06:00Z', event: 'agent_spawn', agent: 'implement', model: 'sonnet' },
  { ts: '2026-08-01T10:07:00Z', event: 'review_round', round: 1 },
  { ts: '2026-08-01T10:08:00Z', event: 'review_round', round: 2 },
  { ts: '2026-08-01T10:09:00Z', event: 'implement_round', round: 1 },
];

test('folds header, phases, rounds, spawns from a live run', () => {
  const now = Date.parse('2026-08-01T10:10:00Z');
  const f = foldRun(EVENTS, now);
  expect(f.key).toBe('PROJ-1');
  expect(f.source).toBe('jira');
  expect(f.budgets).toEqual({ implement: 5, review: 3 });
  expect(f.phases).toEqual([
    { phase: 'plan', startedAt: '2026-08-01T10:00:05Z', endedAt: '2026-08-01T10:05:05Z', durationS: 300, retries: 0 },
    { phase: 'implement', startedAt: '2026-08-01T10:05:06Z', endedAt: null, durationS: null, retries: 1 },
  ]);
  expect(f.rounds).toEqual({ review_round: 2, implement_round: 1 });
  expect(f.spawns).toEqual([{ ts: '2026-08-01T10:06:00Z', agent: 'implement', model: 'sonnet' }]);
  expect(f.live).toBe(true);
  expect(f.staleSeconds).toBe(60); // last event 10:09, now 10:10
});

test('run_end flips live off and carries outcome', () => {
  const f = foldRun([
    ...EVENTS,
    { ts: '2026-08-01T10:30:00Z', event: 'run_end', outcome: 'shipped', halted_at: '' },
  ]);
  expect(f.live).toBe(false);
  expect(f.outcome).toBe('shipped');
  expect(f.haltedAt).toBeNull(); // empty halted_at not surfaced
  expect(f.staleSeconds).toBeNull();
});
