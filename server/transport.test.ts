import { test, expect } from 'vitest';
import { probeServer, serverAppearsRunning, splitBrainError, saveStateGuarded, writePidFile } from './transport.ts';
import { emptyState, loadState } from './state.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

function tempStatePath() {
  return join(mkdtempSync(join(tmpdir(), 'jd-transport-')), 'state.json');
}

// A pid guaranteed dead on both platforms: above pid_max on macOS (99998)
// and Linux (max 4194304), still a valid int32 for process.kill — never a
// live pid, and no reuse race a spawned-and-reaped child pid would carry.
const DEAD_PID = 2147483647;

// A port with nothing listening: bind to 0 (OS-assigned), then release it —
// unlike a hardcoded port, which flakes if any local process claims it.
async function vacatedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>(r => srv.close(() => r()));
  return port;
}

test('probeServer returns false when nothing is listening on the port', async () => {
  expect(await probeServer(await vacatedPort(), { timeoutMs: 100 })).toBe(false);
});

test('serverAppearsRunning returns null when no pid file exists', () => {
  expect(serverAppearsRunning(tempStatePath())).toBeNull();
});

test('serverAppearsRunning returns null for a stale pid (dead process)', () => {
  const statePath = tempStatePath();
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: DEAD_PID, port: 1, startedAt: 'x' }));
  expect(serverAppearsRunning(statePath)).toBeNull();
});

// Round-trip through the real writer: index.ts's main block calls
// writePidFile on listen, and every split-brain scenario depends on
// serverAppearsRunning being able to read what it wrote. Before writePidFile
// existed the shape lived as copy-pasted literals in three test files, so a
// writer-side field rename would have passed the whole suite.
test('writePidFile round-trips through serverAppearsRunning', () => {
  const statePath = tempStatePath();
  writePidFile(join(dirname(statePath), 'server.pid'), 1);
  expect(serverAppearsRunning(statePath)).toBe(process.pid);
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
