import { test, expect, beforeAll, afterAll } from 'vitest';
import { run, formatStatus, probeServer } from './cli.js';
import { createServer } from './index.js';
import { loadState, saveState, emptyState } from './state.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const config = {
  port: 39217, // unused by direct-mode tests; a port nothing is listening on
  jira: { projectKey: 'PROJ', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
  github: { username: 'john' },
};

function tempStatePath() {
  return join(mkdtempSync(join(tmpdir(), 'jd-cli-')), 'state.json');
}

test('probeServer returns false when nothing is listening on the port', async () => {
  expect(await probeServer(39217, { timeoutMs: 100 })).toBe(false);
});

test('status in direct mode against a fresh temp state file prints the empty-board message', async () => {
  const statePath = tempStatePath();
  const { code, out, err } = await run(['status'], { config, statePath });
  expect(code).toBe(0);
  expect(err).toBe('direct');
  expect(out).toBe('No data yet — run `jira-dash refresh` to fetch a snapshot.');
});

test('status --json in direct mode against a populated temp state file returns the snapshot', async () => {
  const statePath = tempStatePath();
  const state = emptyState();
  state.snapshot = { updatedAt: 'x', errors: { jira: null, github: null },
    buckets: { needs_attention: [{ key: 'P-1', summary: 'Fix it', jiraStatus: 'In Progress', bucket: 'needs_attention', attention: ['ci_failing'], newComments: [] }], in_progress: [], waiting_review: [], in_qa: [] },
    todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 3, newlyMerged: [], recentActivity: [] };
  saveState(statePath, state);
  const { code, out } = await run(['status', '--json'], { config, statePath });
  expect(code).toBe(0);
  expect(JSON.parse(out).mergedTotal).toBe(3);
});

test('status human output includes needs-attention rows with key/summary/reasons', () => {
  const out = formatStatus({
    updatedAt: 'x',
    buckets: { needs_attention: [{ key: 'P-1', summary: 'Fix it', attention: ['ci_failing'] }], in_progress: [], waiting_review: [], in_qa: [] },
    todo: [1, 2], mergedTotal: 5,
  });
  expect(out).toContain('Needs Attention: 1');
  expect(out).toContain('TODO: 2  Merged: 5');
  expect(out).toContain('P-1  Fix it  [ci_failing]');
});

test('ack via the shared action function persists a bucket change to disk (direct mode)', async () => {
  const statePath = tempStatePath();
  const state = emptyState();
  state.snapshot = { updatedAt: '2026-07-01T00:00:00Z', errors: { jira: null, github: null },
    buckets: { needs_attention: [{ key: 'P-1', summary: 'S', jiraStatus: 'In Progress', bucket: 'needs_attention', attention: ['ci_failing'], newComments: [] }], in_progress: [], waiting_review: [], in_qa: [] },
    todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 0, newlyMerged: [], recentActivity: [] };
  saveState(statePath, state);

  const { code, out } = await run(['ack', 'P-1'], { config, statePath });
  expect(code).toBe(0);
  expect(out).toBe('P-1 -> in_progress');

  const reloaded = loadState(statePath);
  expect(reloaded.cards['P-1'].lastSeenPr).toBe('2026-07-01T00:00:00Z');
});

test('refresh --json in direct mode emits pure JSON on stdout (refresh()\'s own console.log must not leak in)', async () => {
  const statePath = tempStatePath();
  const demoConfig = {
    port: 39217, demo: true,
    jira: { projectKey: 'DEMO', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
    github: { username: 'costajohnt', org: 'acme' },
  };
  const { code, out } = await run(['refresh', '--json'], { config: demoConfig, statePath });
  expect(code).toBe(0);
  expect(() => JSON.parse(out)).not.toThrow();
});

test('move --json in direct mode reports the resulting bucket', async () => {
  const statePath = tempStatePath();
  const state = emptyState();
  state.snapshot = { updatedAt: 'x', errors: { jira: null, github: null },
    buckets: { needs_attention: [], in_progress: [{ key: 'P-2', summary: 'S', jiraStatus: 'In Progress', bucket: 'in_progress', attention: [], newComments: [] }], waiting_review: [], in_qa: [] },
    todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 0, newlyMerged: [], recentActivity: [] };
  saveState(statePath, state);
  const { code, out } = await run(['move', 'P-2', 'in_qa', '--json'], { config, statePath });
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ ok: true, key: 'P-2', bucket: 'in_qa' });
});

test('ack on an unknown key is a no-op that still exits 0', async () => {
  const statePath = tempStatePath();
  const { code, out } = await run(['ack', 'GHOST'], { config, statePath });
  expect(code).toBe(0);
  expect(out).toBe('GHOST: not currently on the board');
});

test('move with an invalid bucket exits 1 with the server-side error', async () => {
  const statePath = tempStatePath();
  const { code, err } = await run(['move', 'P-1', 'needs_attention'], { config, statePath });
  expect(code).toBe(1);
  expect(err).toContain('bucket must be one of');
});

test('direct-mode ack refuses when a server.pid exists for a live process (split-brain guard)', async () => {
  const statePath = tempStatePath();
  const state = emptyState();
  state.snapshot = { updatedAt: 'x', errors: { jira: null, github: null },
    buckets: { needs_attention: [{ key: 'P-1', summary: 'S', jiraStatus: 'In Progress', bucket: 'needs_attention', attention: [], newComments: [] }], in_progress: [], waiting_review: [], in_qa: [] },
    todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 0, newlyMerged: [], recentActivity: [] };
  saveState(statePath, state);
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: process.pid, port: 39217, startedAt: 'x' }));

  const { code, err } = await run(['ack', 'P-1'], { config, statePath });
  expect(code).toBe(1);
  expect(err).toContain(`a server (pid ${process.pid}) appears to be running`);
  // No mutation happened: the card is untouched on disk.
  expect(loadState(statePath).cards['P-1']).toBeUndefined();
});

test('direct-mode refresh refuses when a server.pid exists for a live process', async () => {
  const statePath = tempStatePath();
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: process.pid, port: 39217, startedAt: 'x' }));
  const { code, err } = await run(['refresh'], { config, statePath });
  expect(code).toBe(1);
  expect(err).toContain('appears to be running but did not answer the probe');
});

test('status still works direct-mode even with a server.pid present (read-only)', async () => {
  const statePath = tempStatePath();
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: process.pid, port: 39217, startedAt: 'x' }));
  const { code, out } = await run(['status'], { config, statePath });
  expect(code).toBe(0);
  expect(out).toBe('No data yet — run `jira-dash refresh` to fetch a snapshot.');
});

test('a stale server.pid (dead process) does not block direct-mode writes', async () => {
  const statePath = tempStatePath();
  const state = emptyState();
  state.snapshot = { updatedAt: 'x', errors: { jira: null, github: null },
    buckets: { needs_attention: [{ key: 'P-1', summary: 'S', jiraStatus: 'In Progress', bucket: 'needs_attention', attention: [], newComments: [] }], in_progress: [], waiting_review: [], in_qa: [] },
    todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 0, newlyMerged: [], recentActivity: [] };
  saveState(statePath, state);
  // A pid essentially guaranteed not to be alive.
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: 999999, port: 39217, startedAt: 'x' }));
  const { code, out } = await run(['ack', 'P-1'], { config, statePath });
  expect(code).toBe(0);
  expect(out).toBe('P-1 -> in_progress');
});

test('exit code 1 for an unknown command', async () => {
  const { code, err } = await run(['bogus'], { config, statePath: tempStatePath() });
  expect(code).toBe(1);
  expect(err).toContain('Unknown command: bogus');
});

test('exit code 1 when ack/move is called without a KEY argument', async () => {
  const ack = await run(['ack'], { config, statePath: tempStatePath() });
  expect(ack.code).toBe(1);
  expect(ack.err).toContain('usage: jira-dash ack <KEY>');
  const move = await run(['move'], { config, statePath: tempStatePath() });
  expect(move.code).toBe(1);
  expect(move.err).toContain('usage: jira-dash move <KEY> <bucket>');
});

test('--help / no command prints usage; exit 0 with --help, exit 1 with no command', async () => {
  const withHelp = await run(['--help'], { config, statePath: tempStatePath() });
  expect(withHelp.code).toBe(0);
  expect(withHelp.out).toContain('Usage:');
  const bare = await run([], { config, statePath: tempStatePath() });
  expect(bare.code).toBe(1);
  expect(bare.out).toContain('Usage:');
});

let server, serverConfig;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-cli-http-'));
  const statePath = join(dir, 'state.json');
  const webDist = join(dir, 'dist');
  mkdirSync(webDist);
  writeFileSync(join(webDist, 'index.html'), '<html>app</html>');
  const state = emptyState();
  state.snapshot = { updatedAt: 'x', errors: { jira: null, github: null },
    buckets: { needs_attention: [{ key: 'P-9', summary: 'S', jiraStatus: 'In Progress', bucket: 'needs_attention', attention: ['ci_failing'], newComments: [] }], in_progress: [], waiting_review: [], in_qa: [] },
    todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 7, newlyMerged: [], recentActivity: [] };
  saveState(statePath, state);
  serverConfig = { port: 0, jira: { statuses: { inTest: 'In Test' } }, github: {} };
  server = createServer({ config: serverConfig, statePath, webDist });
  await new Promise(r => server.listen(0, r));
  serverConfig.port = server.address().port; // cli.js probes/talks to this port
});
afterAll(() => server.close());

test('status goes through the HTTP transport when a server is listening on the configured port', async () => {
  const { code, out, err } = await run(['status', '--json'], { config: serverConfig, statePath: '/nonexistent/should-not-be-read.json' });
  expect(code).toBe(0);
  expect(err).toBe('via server');
  expect(JSON.parse(out).mergedTotal).toBe(7);
});

test('ack goes through the HTTP transport and reports the resulting bucket', async () => {
  const { code, out, err } = await run(['ack', 'P-9'], { config: serverConfig, statePath: '/nonexistent/should-not-be-read.json' });
  expect(code).toBe(0);
  expect(err).toBe('via server');
  expect(out).toBe('P-9 -> in_progress');
});
