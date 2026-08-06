import { test, expect } from 'vitest';
import { probeServer, serverAppearsRunning, splitBrainError, saveStateGuarded } from './transport.ts';
import { emptyState, loadState } from './state.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

function tempStatePath() {
  return join(mkdtempSync(join(tmpdir(), 'jd-transport-')), 'state.json');
}

test('probeServer returns false when nothing is listening on the port', async () => {
  expect(await probeServer(39299, { timeoutMs: 100 })).toBe(false);
});

test('serverAppearsRunning returns null when no pid file exists', () => {
  expect(serverAppearsRunning(tempStatePath())).toBeNull();
});

test('serverAppearsRunning returns null for a stale pid (dead process)', () => {
  const statePath = tempStatePath();
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: 999999, port: 1, startedAt: 'x' }));
  expect(serverAppearsRunning(statePath)).toBeNull();
});

test('serverAppearsRunning returns the pid for a live process', () => {
  const statePath = tempStatePath();
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: process.pid, port: 1, startedAt: 'x' }));
  expect(serverAppearsRunning(statePath)).toBe(process.pid);
});

test('saveStateGuarded saves normally when no server is running', () => {
  const statePath = tempStatePath();
  const state = emptyState();
  state.lastRefreshAt = '2026-07-08T00:00:00Z';
  saveStateGuarded(statePath, state);
  expect(loadState(statePath).lastRefreshAt).toBe('2026-07-08T00:00:00Z');
});

// TOCTOU: a call site's early guard check (serverAppearsRunning at the top
// of a command) can pass, then a server starts in the window before the
// actual saveState — the whole point of saveStateGuarded is to re-check
// right at the write, not trust the earlier check.
test('saveStateGuarded refuses when a server.pid appears after an initial check but before the save', () => {
  const statePath = tempStatePath();
  const state = emptyState();

  // Simulates a call site's early guard: passes, because nothing has
  // started yet.
  expect(serverAppearsRunning(statePath)).toBeNull();

  // A server starts in the gap between that check and the actual write.
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: process.pid, port: 1, startedAt: 'x' }));

  expect(() => saveStateGuarded(statePath, state)).toThrow(splitBrainError(process.pid));
});
