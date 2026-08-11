import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listRuns, readRun, type ExecFn } from './simon.ts';
import type { Config } from './types.ts';

function baseConfig(simonRoot?: string): Config {
  return {
    jira: { projectKey: 'PROJ', accountId: 'id', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
    github: { token: '', org: 'o', repos: [], username: 'u' },
    port: 0, demo: true, writeEnabled: false,
    simon: simonRoot ? { root: simonRoot, bin: 'simon' } : undefined,
  };
}

// exec stub that never resolves with a report — forces the ledger fallback.
const execFails: ExecFn = (() => Promise.reject(new Error('spawn simon ENOENT'))) as unknown as ExecFn;

function execReturning(items: { key: string; class: string }[]): ExecFn {
  return (() => Promise.resolve({ stdout: JSON.stringify({ items }), stderr: '' })) as unknown as ExecFn;
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'simon-'));
  mkdirSync(join(root, 'state', 'runs'), { recursive: true });
  return root;
}

const FINISHED = [
  { ts: '2026-08-01T10:00:00Z', event: 'run_start', key: 'PROJ-1', source: 'jira' },
  { ts: '2026-08-01T10:00:05Z', event: 'phase_start', phase: 'plan' },
  { ts: '2026-08-01T10:05:00Z', event: 'phase_end', phase: 'plan' },
  { ts: '2026-08-01T10:05:01Z', event: 'phase_start', phase: 'implement' },
  { ts: '2026-08-01T10:30:00Z', event: 'run_end', outcome: 'shipped', halted_at: '' },
].map(e => JSON.stringify(e)).join('\n');

const IN_FLIGHT = [
  { ts: '2026-08-02T09:00:00Z', event: 'run_start', key: 'PROJ-2' },
  { ts: '2026-08-02T09:00:10Z', event: 'phase_start', phase: 'preview' },
].map(e => JSON.stringify(e)).join('\n');

test('unconfigured returns configured:false', async () => {
  const payload = await listRuns(baseConfig(), execFails);
  expect(payload).toEqual({ configured: false, runs: [] });
});

test('missing runs dir is the empty state, not an error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'simon-'));
  const payload = await listRuns(baseConfig(root), execFails);
  expect(payload.configured).toBe(true);
  expect(payload.runs).toEqual([]);
});

test('summarizes runs, skips malformed lines, sorts newest first', async () => {
  const root = makeRoot();
  writeFileSync(join(root, 'state', 'runs', '2026-08-01T100000Z-PROJ-1.jsonl'), FINISHED + '\nnot json\n');
  writeFileSync(join(root, 'state', 'runs', '2026-08-02T090000Z-PROJ-2.jsonl'), IN_FLIGHT);
  const payload = await listRuns(baseConfig(root), execFails);
  expect(payload.runs.map(r => r.key)).toEqual(['PROJ-2', 'PROJ-1']);
  const done = payload.runs[1]!;
  expect(done.id).toBe('2026-08-01T100000Z-PROJ-1');
  expect(done.outcome).toBe('shipped');
  expect(done.phase).toBe('implement'); // last phase_start
  expect(done.startedAt).toBe('2026-08-01T10:00:00Z');
  expect(done.endedAt).toBe('2026-08-01T10:30:00Z');
  expect(done.durationS).toBe(1800);
});

test('joins attention classes from the CLI onto the newest run per key', async () => {
  const root = makeRoot();
  writeFileSync(join(root, 'state', 'runs', '2026-08-01T100000Z-PROJ-1.jsonl'), FINISHED);
  writeFileSync(join(root, 'state', 'runs', '2026-08-02T090000Z-PROJ-1.jsonl'), IN_FLIGHT.replaceAll('PROJ-2', 'PROJ-1'));
  const payload = await listRuns(baseConfig(root), execReturning([{ key: 'PROJ-1', class: 'in_flight' }]));
  expect(payload.statusError).toBeUndefined();
  expect(payload.runs[0]!.class).toBe('in_flight');       // newest run gets the CLI class
  expect(payload.runs[1]!.class).toBe('shipped');         // older run falls back to its outcome
});

test('CLI failure sets statusError and falls back to ledger classes', async () => {
  const root = makeRoot();
  writeFileSync(join(root, 'state', 'runs', '2026-08-01T100000Z-PROJ-1.jsonl'), FINISHED);
  writeFileSync(join(root, 'state', 'runs', '2026-08-02T090000Z-PROJ-2.jsonl'), IN_FLIGHT);
  const payload = await listRuns(baseConfig(root), execFails);
  expect(payload.statusError).toMatch(/ENOENT/);
  expect(payload.runs[1]!.class).toBe('shipped');
  // In-flight run with an old last event → stale (fixture ts is far in the past).
  expect(payload.runs[0]!.class).toBe('stale');
});

test('readRun returns raw events; rejects traversal and unknown ids', async () => {
  const root = makeRoot();
  writeFileSync(join(root, 'state', 'runs', '2026-08-01T100000Z-PROJ-1.jsonl'), FINISHED);
  const run = await readRun(baseConfig(root), '2026-08-01T100000Z-PROJ-1');
  expect(run?.key).toBe('PROJ-1');
  expect(run?.events).toHaveLength(5);
  expect(await readRun(baseConfig(root), '../../etc/passwd')).toBeNull();
  expect(await readRun(baseConfig(root), 'nope')).toBeNull();
  expect(await readRun(baseConfig(), '2026-08-01T100000Z-PROJ-1')).toBeNull();
});

test('missing run_start falls back to the key parsed from the id', async () => {
  const root = makeRoot();
  // Ledger whose first line (run_start) was lost: only a phase event remains.
  writeFileSync(join(root, 'state', 'runs', '2026-08-03T120000Z-PROJ-9.jsonl'),
    JSON.stringify({ ts: '2026-08-03T12:00:05Z', event: 'phase_start', phase: 'plan' }) + '\n');
  const payload = await listRuns(baseConfig(root), execReturning([{ key: 'PROJ-9', class: 'in_flight' }]));
  expect(payload.runs[0]!.key).toBe('PROJ-9');
  // The recovered key must still join against the attention report.
  expect(payload.runs[0]!.class).toBe('in_flight');
  const run = await readRun(baseConfig(root), '2026-08-03T120000Z-PROJ-9');
  expect(run?.key).toBe('PROJ-9');
});

test('unparsable last-event timestamp classifies as stale, not in_flight', async () => {
  const root = makeRoot();
  writeFileSync(join(root, 'state', 'runs', '2026-08-03T120000Z-PROJ-8.jsonl'),
    JSON.stringify({ event: 'phase_start', phase: 'plan' }) + '\n'); // no ts at all
  const payload = await listRuns(baseConfig(root), execFails);
  expect(payload.runs[0]!.class).toBe('stale');
});
