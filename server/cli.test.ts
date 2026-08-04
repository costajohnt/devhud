import { test, expect, beforeAll, afterAll } from 'vitest';
import { run, formatStatus, probeServer } from './cli.ts';
import { createServer } from './index.ts';
import { loadState, saveState, emptyState } from './state.ts';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config, Snapshot, Item } from './types.ts';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 39217, // unused by direct-mode tests; a port nothing is listening on
    jira: { projectKey: 'PROJ', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
    github: { username: 'john', org: 'o', token: '', repos: [] },
    demo: false, writeEnabled: false,
    ...overrides,
  };
}
const config = makeConfig();

function needsAttentionItem(overrides: Partial<Item> = {}): Item {
  return {
    key: 'P-1', summary: 'S', jiraStatus: 'In Progress', jiraUrl: 'https://x/browse/P-1', bucket: 'needs_attention',
    attention: ['ci_failing'], newComments: [], comments: [], pr: null,
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z', daysSinceActivity: 0,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    updatedAt: 'x', errors: { jira: null, github: null },
    buckets: { needs_attention: [], in_progress: [], waiting_review: [], in_qa: [] },
    todo: [], unlinkedPrs: [],
    doneCards: [], doneTotal: 0, newlyDone: [], recentActivity: [],
    prLog: [],
    ...overrides,
  };
}

function tempStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'jd-cli-')), 'state.json');
}

// performWrite re-reads config from disk and fails CLOSED if that read
// throws, so write-back tests need a real config.json on disk matching the
// gate state they're exercising, not just an in-memory config passed to run().
function tempConfigFile(overrides: { demo?: boolean; writeEnabled?: boolean }): string {
  const path = join(mkdtempSync(join(tmpdir(), 'jd-cli-cfg-')), 'config.json');
  writeFileSync(path, JSON.stringify({
    jira: { projectKey: 'PROJ', accountId: 'me', ...(overrides.demo ? {} : { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't' }) },
    github: { username: 'john', org: 'o' },
    ...overrides,
  }));
  return path;
}

test('probeServer returns false when nothing is listening on the port', async () => {
  expect(await probeServer(39217, { timeoutMs: 100 })).toBe(false);
});

test('status in direct mode against a fresh temp state file prints the empty-board message', async () => {
  const statePath = tempStatePath();
  const { code, out, err } = await run(['status'], { config, statePath });
  expect(code).toBe(0);
  expect(err).toBe('direct');
  expect(out).toBe('No data yet — run `simon-dash refresh` to fetch a snapshot.');
});

test('status --json in direct mode against a populated temp state file returns the snapshot', async () => {
  const statePath = tempStatePath();
  const state = emptyState();
  state.snapshot = makeSnapshot({
    buckets: { needs_attention: [needsAttentionItem()], in_progress: [], waiting_review: [], in_qa: [] },
    doneTotal: 3,
  });
  saveState(statePath, state);
  const { code, out } = await run(['status', '--json'], { config, statePath });
  expect(code).toBe(0);
  expect(JSON.parse(out).doneTotal).toBe(3);
});

test('status human output includes needs-attention rows with key/summary/reasons', () => {
  const out = formatStatus(makeSnapshot({
    buckets: { needs_attention: [needsAttentionItem({ summary: 'Fix it' })], in_progress: [], waiting_review: [], in_qa: [] },
    todo: [{ key: 'T-1', summary: '', jiraUrl: '', createdAt: null }, { key: 'T-2', summary: '', jiraUrl: '', createdAt: null }],
    doneTotal: 5,
  }));
  expect(out).toContain('Needs Attention: 1');
  expect(out).toContain('Todo: 2  Done: 5');
  expect(out).toContain('P-1  Fix it  [ci_failing]');
});

test('ack via the shared action function persists a bucket change to disk (direct mode)', async () => {
  const statePath = tempStatePath();
  const state = emptyState();
  state.snapshot = makeSnapshot({
    updatedAt: '2026-07-01T00:00:00Z',
    buckets: { needs_attention: [needsAttentionItem({ summary: 'S' })], in_progress: [], waiting_review: [], in_qa: [] },
  });
  saveState(statePath, state);

  const { code, out } = await run(['ack', 'P-1'], { config, statePath });
  expect(code).toBe(0);
  expect(out).toBe('P-1 -> in_progress');

  const reloaded = loadState(statePath);
  expect(reloaded.cards['P-1']!.lastSeenPr).toBe('2026-07-01T00:00:00Z');
});

test('refresh --json in direct mode emits pure JSON on stdout (refresh()\'s own console.log must not leak in)', async () => {
  const statePath = tempStatePath();
  const demoConfig = makeConfig({
    demo: true,
    jira: { projectKey: 'DEMO', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
    github: { username: 'costajohnt', org: 'acme', token: '', repos: [] },
  });
  const { code, out } = await run(['refresh', '--json'], { config: demoConfig, statePath });
  expect(code).toBe(0);
  expect(() => JSON.parse(out)).not.toThrow();
});

test('move --json in direct mode reports the resulting bucket', async () => {
  const statePath = tempStatePath();
  const state = emptyState();
  state.snapshot = makeSnapshot({
    buckets: { needs_attention: [], in_progress: [needsAttentionItem({ key: 'P-2', bucket: 'in_progress', attention: [] })], waiting_review: [], in_qa: [] },
  });
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
  state.snapshot = makeSnapshot({
    buckets: { needs_attention: [needsAttentionItem({ attention: [] })], in_progress: [], waiting_review: [], in_qa: [] },
  });
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
  expect(out).toBe('No data yet — run `simon-dash refresh` to fetch a snapshot.');
});

test('a stale server.pid (dead process) does not block direct-mode writes', async () => {
  const statePath = tempStatePath();
  const state = emptyState();
  state.snapshot = makeSnapshot({
    buckets: { needs_attention: [needsAttentionItem({ attention: [] })], in_progress: [], waiting_review: [], in_qa: [] },
  });
  saveState(statePath, state);
  // A pid essentially guaranteed not to be alive.
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: 999999, port: 39217, startedAt: 'x' }));
  const { code, out } = await run(['ack', 'P-1'], { config, statePath });
  expect(code).toBe(0);
  expect(out).toBe('P-1 -> in_progress');
});

test('transition in direct mode against demo config prints a clean demo-refusal message (not an error)', async () => {
  const statePath = tempStatePath();
  const demoConfig = makeConfig({ demo: true });
  const configPath = tempConfigFile({ demo: true });
  const { code, out, err } = await run(['transition', 'FAKE-1', 'Done'], { config: demoConfig, statePath, configPath });
  expect(code).toBe(0);
  expect(err).toBe('direct');
  expect(out).toBe('demo mode: write-back is a no-op (nothing real to write to)');
});

test('transition --json in direct mode against demo config returns the stub-success shape', async () => {
  const statePath = tempStatePath();
  const demoConfig = makeConfig({ demo: true });
  const configPath = tempConfigFile({ demo: true });
  const { code, out } = await run(['transition', 'FAKE-1', 'In', 'Review', '--json'], { config: demoConfig, statePath, configPath });
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ ok: true, demo: true, message: 'demo mode: write-back is a no-op (nothing real to write to)' });
});

test('comment in direct mode refuses with the real gate error when writeEnabled is false (non-demo)', async () => {
  const statePath = tempStatePath();
  const configPath = tempConfigFile({ demo: false, writeEnabled: false });
  const { code, err } = await run(['comment', 'P-1', 'looks', 'good'], { config, statePath, configPath });
  expect(code).toBe(1);
  expect(err).toContain('write-back disabled; set writeEnabled: true in config.json');
});

test('pr-comment usage error when the repo#num ref is malformed', async () => {
  const statePath = tempStatePath();
  const { code, err } = await run(['pr-comment', 'not-a-ref', 'nice', 'work'], { config, statePath });
  expect(code).toBe(1);
  expect(err).toContain('usage: simon-dash pr-comment <repo#num> <text...>');
});

test('pr-comment usage error when no comment text is given', async () => {
  const statePath = tempStatePath();
  const { code, err } = await run(['pr-comment', 'acme/webapp#482'], { config, statePath });
  expect(code).toBe(1);
  expect(err).toContain('usage: simon-dash pr-comment <repo#num> <text...>');
});

test('pr-comment demo-refuses cleanly with repo/number parsed from the ref', async () => {
  const statePath = tempStatePath();
  const demoConfig = makeConfig({ demo: true });
  const configPath = tempConfigFile({ demo: true });
  const { code, out } = await run(['pr-comment', 'acme/webapp#482', 'nice', 'work', '--json'], { config: demoConfig, statePath, configPath });
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ ok: true, demo: true, message: 'demo mode: write-back is a no-op (nothing real to write to)' });
});

test('direct-mode transition refuses when a server.pid exists for a live process (split-brain guard)', async () => {
  const statePath = tempStatePath();
  const writeEnabledConfig = makeConfig({ demo: false, writeEnabled: true });
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: process.pid, port: 39217, startedAt: 'x' }));
  const { code, err } = await run(['transition', 'P-1', 'Done'], { config: writeEnabledConfig, statePath });
  expect(code).toBe(1);
  expect(err).toContain(`a server (pid ${process.pid}) appears to be running`);
});

test('transition/comment usage errors when KEY or status/text is missing', async () => {
  const t = await run(['transition', 'P-1'], { config, statePath: tempStatePath() });
  expect(t.code).toBe(1);
  expect(t.err).toContain('usage: simon-dash transition <KEY> <status...>');
  const c = await run(['comment'], { config, statePath: tempStatePath() });
  expect(c.code).toBe(1);
  expect(c.err).toContain('usage: simon-dash comment <KEY> <text...>');
});

test('exit code 1 for an unknown command', async () => {
  const { code, err } = await run(['bogus'], { config, statePath: tempStatePath() });
  expect(code).toBe(1);
  expect(err).toContain('Unknown command: bogus');
});

test('exit code 1 when ack/move is called without a KEY argument', async () => {
  const ack = await run(['ack'], { config, statePath: tempStatePath() });
  expect(ack.code).toBe(1);
  expect(ack.err).toContain('usage: simon-dash ack <KEY>');
  const move = await run(['move'], { config, statePath: tempStatePath() });
  expect(move.code).toBe(1);
  expect(move.err).toContain('usage: simon-dash move <KEY> <bucket>');
});

test('--help / no command prints usage; exit 0 with --help, exit 1 with no command', async () => {
  const withHelp = await run(['--help'], { config, statePath: tempStatePath() });
  expect(withHelp.code).toBe(0);
  expect(withHelp.out).toContain('Usage:');
  const bare = await run([], { config, statePath: tempStatePath() });
  expect(bare.code).toBe(1);
  expect(bare.out).toContain('Usage:');
});

let server: http.Server;
let serverConfig: Config;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-cli-http-'));
  const statePath = join(dir, 'state.json');
  const webDist = join(dir, 'dist');
  mkdirSync(webDist);
  writeFileSync(join(webDist, 'index.html'), '<html>app</html>');
  const state = emptyState();
  state.snapshot = makeSnapshot({
    buckets: { needs_attention: [needsAttentionItem({ key: 'P-9', summary: 'S' })], in_progress: [], waiting_review: [], in_qa: [] },
    doneTotal: 7,
  });
  saveState(statePath, state);
  serverConfig = makeConfig({ port: 0 });
  server = createServer({ config: serverConfig, statePath, webDist });
  await new Promise<void>(r => server.listen(0, () => r()));
  serverConfig.port = (server.address() as AddressInfo).port; // cli.ts probes/talks to this port
});
afterAll(() => server.close());

test('status goes through the HTTP transport when a server is listening on the configured port', async () => {
  const { code, out, err } = await run(['status', '--json'], { config: serverConfig, statePath: '/nonexistent/should-not-be-read.json' });
  expect(code).toBe(0);
  expect(err).toBe('via server');
  expect(JSON.parse(out).doneTotal).toBe(7);
});

test('ack goes through the HTTP transport and reports the resulting bucket', async () => {
  const { code, out, err } = await run(['ack', 'P-9'], { config: serverConfig, statePath: '/nonexistent/should-not-be-read.json' });
  expect(code).toBe(0);
  expect(err).toBe('via server');
  expect(out).toBe('P-9 -> in_progress');
});

// A minimal double answering the probe (GET /api/data -> 200) but failing
// the actual refresh (POST /api/refresh -> 500), so `refresh`'s via-server
// path has to handle a non-2xx response instead of blindly parsing its body
// as if it were a snapshot payload.
test('refresh via the HTTP transport surfaces a non-2xx response as an error instead of parsing it as a snapshot', async () => {
  const badServer = http.createServer((req, res) => {
    if (req.url === '/api/data') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    if (req.url === '/api/refresh') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'boom' })); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => badServer.listen(0, () => r()));
  try {
    const badConfig = makeConfig({ port: (badServer.address() as AddressInfo).port });
    const { code, err } = await run(['refresh'], { config: badConfig, statePath: '/nonexistent/should-not-be-read.json' });
    expect(code).toBe(1);
    expect(err).toContain('HTTP 500');
  } finally {
    badServer.close();
  }
});
