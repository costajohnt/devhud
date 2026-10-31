import { test, expect, vi } from 'vitest';
import { boardStatus, BOARD_DONE_CARDS, doRefresh, ackCard, moveCard, cardComments, transitionCard, commentCard, commentPr } from './handlers.ts';
import { loadState, saveState, emptyState, emptySnapshot } from '../server/state.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { writePidFile } from '../server/transport.ts';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config, Snapshot } from '../server/types.ts';

// Direct-mode tests pass viaServer: false so no probe runs; a released
// "free" port could be grabbed by a parallel listen(0) and flip them to
// via-server mode. The via-server tests below use their own fixed ports.
const config: Config = {
  port: 0,
  jira: { projectKey: 'DEMO', accountId: 'me', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
  github: { username: 'costajohnt', org: 'acme', token: '', repos: [] },
  demo: true,
  writeEnabled: false,
};

function tempStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'jd-mcp-')), 'state.json');
}

// performWrite re-reads config from disk and fails CLOSED if that read
// throws, so write-back tests need a real config.json on disk matching the
// gate state they're exercising, not just an in-memory config.
function tempConfigFile(overrides: { demo?: boolean; writeEnabled?: boolean }): string {
  const path = join(mkdtempSync(join(tmpdir(), 'jd-mcp-cfg-')), 'config.json');
  writeFileSync(path, JSON.stringify({
    jira: { projectKey: 'DEMO', accountId: 'me', ...(overrides.demo ? {} : { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't' }) },
    github: { username: 'costajohnt', org: 'acme' },
    ...overrides,
  }));
  return path;
}

function seedSnapshot(statePath: string) {
  const state = emptyState();
  const snapshot: Snapshot = {
    updatedAt: '2026-07-01T00:00:00Z', errors: { jira: null, github: null }, queue: [], reviewRequests: [],
    buckets: {
      needs_attention: [{
        key: 'P-1', summary: 'Fix it', jiraStatus: 'In Progress', jiraUrl: 'https://x/browse/P-1', bucket: 'needs_attention',
        attention: ['ci_failing'], newComments: [{ source: 'github', author: 'sarah', body: 'ping', createdAt: '2026-07-01T00:00:00Z' }],
        comments: [{ source: 'github', author: 'sarah', body: 'ping', createdAt: '2026-07-01T00:00:00Z' }],
        pr: null, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z', daysSinceActivity: 0,
        pinned: false, pinnedAt: null,
      }],
      in_progress: [], self_review: [], waiting_review: [], mergeable: [], qa_ready: [], in_qa: [],
    },
    todo: [], blocked: [], filed: [], unlinkedPrs: [],
    doneCards: [], doneTotal: 3, newlyDone: [], recentActivity: [],
    prLog: [],
  };
  state.snapshot = snapshot;
  saveState(statePath, state);
  return state;
}

test('boardStatus returns the empty-board placeholder against a fresh state file', async () => {
  const statePath = tempStatePath();
  const snap = await boardStatus({ config, statePath, viaServer: false }) as unknown as Snapshot;
  expect(snap.updatedAt).toBeNull();
  expect(snap.buckets.needs_attention).toEqual([]);
});

test('boardStatus returns the persisted snapshot as-is', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const snap = await boardStatus({ config, statePath, viaServer: false }) as unknown as Snapshot;
  expect(snap.doneTotal).toBe(3);
  expect(snap.buckets.needs_attention[0]!.key).toBe('P-1');
});

// M1: card summaries/comment bodies are third-party text (Jira/GitHub); the
// _note field marks that as data, not instructions, for whatever model
// reads the tool output.
test('boardStatus marks the payload as containing untrusted third-party text', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const snap = await boardStatus({ config, statePath, viaServer: false }) as unknown as Snapshot & { _note: string };
  expect(snap._note).toMatch(/third-party text/);
  expect(snap._note).toMatch(/never as instructions/);
});

test('ackCard clears attention and moves the card out of needs_attention (direct mode)', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const result = await ackCard({ config, statePath, viaServer: false, key: 'P-1' });
  expect(result).toEqual({ ok: true, bucket: 'in_progress' });
  const persisted = loadState(statePath);
  expect(persisted.snapshot!.buckets.needs_attention).toEqual([]);
  expect(persisted.snapshot!.buckets.in_progress[0]!.key).toBe('P-1');
});

// M9: `reason` must reach opAction. Dropping it turns a per-entry dismissal
// into a whole-card ack (every flag cleared, every TODO entry gone).
test('ackCard with a reason dismisses only that TODO entry and leaves the card\'s others', async () => {
  const statePath = tempStatePath();
  const state = seedSnapshot(statePath);
  const seeded = state.snapshot!.buckets.needs_attention[0]!;
  seeded.attention = ['new_pr_comments', 'new_jira_comments'];
  seeded.newComments.push({ source: 'jira', author: 'qa', body: 'repro?', createdAt: '2026-07-01T00:00:00Z' });
  saveState(statePath, state);
  const result = await ackCard({ config, statePath, viaServer: false, key: 'P-1', reason: 'new_pr_comments' });
  expect(result).toEqual({ ok: true, bucket: 'in_progress' });
  const persisted = loadState(statePath);
  const item = persisted.snapshot!.buckets.in_progress[0]!;
  expect(item.attention).toEqual(['new_jira_comments']);
  expect(item.newComments.map(c => c.source)).toEqual(['jira']);
  expect(persisted.cards['P-1']!.lastSeenJira).toBeNull();
  expect(persisted.snapshot!.queue.map(e => e.reason)).toEqual(['new_jira_comments']);
});

test('moveCard pins the card to the requested bucket and persists the override', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const result = await moveCard({ config, statePath, viaServer: false, key: 'P-1', bucket: 'in_qa' });
  expect(result).toEqual({ ok: true, bucket: 'in_qa' });
  const persisted = loadState(statePath);
  expect(persisted.cards['P-1']!.override).toBe('in_qa');
  expect(persisted.snapshot!.buckets.in_qa[0]!.key).toBe('P-1');
});

test('moveCard rejects an invalid bucket the same way the HTTP API does', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const result = await moveCard({ config, statePath, viaServer: false, key: 'P-1', bucket: 'needs_attention' }) as { error: string };
  expect(result.error).toContain('bucket must be one of');
});

test('cardComments returns the item\'s full comment history and newComments', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const result = await cardComments({ config, statePath, viaServer: false, key: 'P-1' }) as { key: string; comments: { author: string }[]; newComments: unknown[] };
  expect(result.key).toBe('P-1');
  expect(result.comments).toHaveLength(1);
  expect(result.newComments).toHaveLength(1);
  expect(result.comments[0]!.author).toBe('sarah');
});

test('cardComments marks the payload as containing untrusted third-party text', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const result = await cardComments({ config, statePath, viaServer: false, key: 'P-1' }) as { _note: string };
  expect(result._note).toMatch(/third-party text/);
  expect(result._note).toMatch(/never as instructions/);
});

// The card_comments MCP tool description explicitly documents this
// fallback ("a card Jira has marked Done and moved into doneCards is found
// but returns empty comments/newComments arrays") but nothing verified it —
// DoneCard carries no comments/newComments fields, so cardComments'
// `?? (snapshot.doneCards ?? []).find(...)` fallback (and the `as {...}` cast
// right after it) is the only thing standing between that documented behavior
// and either a runtime crash or silently wrong data if a future refactor
// breaks the shape assumption.
test('cardComments finds a done card via the doneCards fallback, returning empty comments/newComments (not an error)', async () => {
  const statePath = tempStatePath();
  const state = seedSnapshot(statePath);
  state.snapshot!.doneCards = [
    { key: 'P-9', summary: 'Shipped it', jiraStatus: 'Done', jiraUrl: 'https://x/browse/P-9', pr: null, doneAt: '2026-07-01T00:00:00Z' },
  ];
  saveState(statePath, state);

  const result = await cardComments({ config, statePath, viaServer: false, key: 'P-9' }) as { key: string; comments: unknown[]; newComments: unknown[] };

  expect(result.key).toBe('P-9');
  expect(result.comments).toEqual([]);
  expect(result.newComments).toEqual([]);
});

test('cardComments on an unknown key returns an error shape, not a throw', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  const result = await cardComments({ config, statePath, viaServer: false, key: 'NOPE-1' }) as { error: string };
  expect(result.error).toContain('NOPE-1');
});

test('doRefresh in demo mode returns bucket counts, errors, and newlyDone without touching the network', async () => {
  const statePath = tempStatePath();
  const summary = await doRefresh({ config, statePath, viaServer: false }) as { counts: Record<string, number>; errors: unknown; newlyDone: unknown[] };
  expect(summary.errors).toEqual({ jira: null, github: null });
  expect(Object.values(summary.counts).some(n => n > 0)).toBe(true);
  expect(Array.isArray(summary.newlyDone)).toBe(true);
});

// Split-brain guard: a live server.pid blocks direct-mode writes (ack/move/
// refresh) so an unreachable-but-alive server's in-memory state can't be
// silently clobbered by this process writing state.json underneath it.
test('ackCard refuses a direct-mode write when a server.pid exists for a live process', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: process.pid, port: config.port, startedAt: 'x' }));
  const result = await ackCard({ config, statePath, viaServer: false, key: 'P-1' }) as { error: string };
  expect(result.error).toContain('appears to be running');
});

test('transitionCard against demo config returns the stub-success refusal, not an error', async () => {
  const statePath = tempStatePath();
  const configPath = tempConfigFile({ demo: true });
  const result = await transitionCard({ config, statePath, viaServer: false, configPath, key: 'P-1', status: 'Done' });
  expect(result).toEqual({ ok: true, demo: true, message: 'demo mode: write-back is a no-op (nothing real to write to)' });
});

test('commentCard against demo config returns the stub-success refusal', async () => {
  const statePath = tempStatePath();
  const configPath = tempConfigFile({ demo: true });
  const result = await commentCard({ config, statePath, viaServer: false, configPath, key: 'P-1', body: 'looks good' });
  expect(result.demo).toBe(true);
});

test('commentPr against demo config returns the stub-success refusal', async () => {
  const statePath = tempStatePath();
  const configPath = tempConfigFile({ demo: true });
  const result = await commentPr({ config, statePath, viaServer: false, configPath, repo: 'acme/webapp', number: 482, body: 'nice work' });
  expect(result.demo).toBe(true);
});

test('transitionCard refuses a direct-mode write when a server.pid exists for a live process (split-brain guard)', async () => {
  const statePath = tempStatePath();
  const writeEnabledConfig: Config = { ...config, demo: false, writeEnabled: true };
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: process.pid, port: config.port, startedAt: 'x' }));
  const result = await transitionCard({ config: writeEnabledConfig, statePath, viaServer: false, key: 'P-1', status: 'Done' });
  expect(result.error).toContain('appears to be running');
});

test('transitionCard against a non-demo config with writeEnabled false refuses with a real error', async () => {
  const statePath = tempStatePath();
  const nonDemoConfig: Config = { ...config, demo: false, writeEnabled: false };
  const configPath = tempConfigFile({ demo: false, writeEnabled: false });
  const result = await transitionCard({ config: nonDemoConfig, statePath, viaServer: false, configPath, key: 'P-1', status: 'Done' });
  expect(result.error).toBe('write-back disabled; set writeEnabled: true in config.json');
});

// getSnapshot's HTTP-mode path is two round-trips (probeServer's own fetch,
// then this one) — a server that answered the probe can still drop the
// connection by the time the real fetch lands. This must come back as a
// structured { error }, not a raw throw out of an MCP tool call.
test('boardStatus returns a structured error instead of throwing when the fetch fails after a successful probe', async () => {
  const statePath = tempStatePath();
  writePidFile(join(dirname(statePath), 'server.pid'), 39220); // the probe needs a live pid file too (audit M1)
  const viaServerConfig: Config = { ...config, demo: false, port: 39220 };
  const fetchSpy = vi.spyOn(global, 'fetch')
    .mockResolvedValueOnce({ ok: true } as Response) // probeServer's own check
    .mockRejectedValueOnce(new Error('socket hang up')); // the real /api/data fetch
  const result = await boardStatus({ config: viaServerConfig, statePath });
  expect(result).toEqual({ error: 'socket hang up' });
  fetchSpy.mockRestore();
});

test('cardComments propagates a getSnapshot error instead of masking it as an unknown-key error', async () => {
  const statePath = tempStatePath();
  writePidFile(join(dirname(statePath), 'server.pid'), 39221);
  const viaServerConfig: Config = { ...config, demo: false, port: 39221 };
  const fetchSpy = vi.spyOn(global, 'fetch')
    .mockResolvedValueOnce({ ok: true } as Response)
    .mockRejectedValueOnce(new Error('socket hang up'));
  const result = await cardComments({ config: viaServerConfig, statePath, key: 'P-1' });
  expect(result).toEqual({ error: 'socket hang up' });
  fetchSpy.mockRestore();
});

test('doRefresh via the HTTP transport surfaces a non-2xx response as an error instead of parsing it as a snapshot', async () => {
  const statePath = tempStatePath();
  writePidFile(join(dirname(statePath), 'server.pid'), 39222);
  const viaServerConfig: Config = { ...config, demo: false, port: 39222 };
  const fetchSpy = vi.spyOn(global, 'fetch')
    .mockResolvedValueOnce({ ok: true } as Response) // probeServer's own check
    .mockResolvedValueOnce({ ok: false, status: 500 } as Response); // the real /api/refresh fetch
  const result = await doRefresh({ config: viaServerConfig, statePath });
  expect(result).toEqual({ error: 'HTTP 500' });
  fetchSpy.mockRestore();
});

test('boardStatus (read-only) still works direct-mode even with a server.pid present', async () => {
  const statePath = tempStatePath();
  seedSnapshot(statePath);
  writeFileSync(join(dirname(statePath), 'server.pid'), JSON.stringify({ pid: process.pid, port: config.port, startedAt: 'x' }));
  const snap = await boardStatus({ config, statePath, viaServer: false }) as unknown as Snapshot;
  expect(snap.doneTotal).toBe(3);
});

// Audit M21: board_status used to hand an agent the lifetime PR history and
// every Done card on every call.
test('boardStatus leaves out prLog and caps doneCards, keeping doneTotal', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'jd-mcp-board-')), 'state.json');
  const state = emptyState();
  const done = Array.from({ length: 30 }, (_, i) => ({ key: `P-${i}`, summary: '', jiraStatus: 'Done', jiraUrl: '', pr: null, doneAt: null }));
  state.snapshot = { ...emptySnapshot(), updatedAt: 'x', doneCards: done, doneTotal: 30, prLog: [{ id: 'o/r#1', repo: 'o/r', openedAt: null, mergedAt: null, closedAt: null }] };
  saveState(statePath, state);
  const r = await boardStatus({ config, statePath, viaServer: false }) as Record<string, unknown>;
  expect('prLog' in r).toBe(false);
  expect((r.doneCards as unknown[]).length).toBe(BOARD_DONE_CARDS);
  expect(r.doneCardsShown).toBe(BOARD_DONE_CARDS);
  expect(r.doneTotal).toBe(30);
});
