// M9: mcp/index.ts connects a StdioServerTransport at import time, so it is
// exercised as a real child process through the SDK client: this covers the
// tool registration and the index.ts -> handlers argument wiring (a dropped
// `reason` there turns a per-entry dismissal into a whole-card ack).
import { test, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { saveState, loadState, emptyState, emptySnapshot } from '../server/state.ts';
import type { QueueEntry } from '../server/types.ts';

// Same convention as handlers.test.ts: nothing listens here, so the child
// takes the direct-mode path against the temp state file.
const FREE_PORT = await (async () => {
  const srv = createNetServer();
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>(r => srv.close(() => r()));
  return port;
})();

test('devhud-mcp lists its tools and routes todo_list / ack_card (with reason) to the state file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jd-mcp-stdio-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    jira: { projectKey: 'DEMO', accountId: 'me' }, github: { org: 'acme', username: 'me', repos: [] }, demo: true, port: FREE_PORT,
  }));
  mkdirSync(join(home, 'data'));
  const statePath = join(home, 'data', 'state.json');
  const state = emptyState();
  state.snapshot = { ...emptySnapshot(), updatedAt: '2026-07-01T00:00:00Z' };
  state.snapshot.buckets.needs_attention.push({
    key: 'P-1', summary: 'Fix it', jiraStatus: 'In Progress', jiraUrl: 'https://x/browse/P-1', bucket: 'needs_attention',
    attention: ['new_pr_comments', 'new_jira_comments'],
    newComments: [
      { source: 'github', author: 'sarah', body: 'ping', createdAt: '2026-07-01T00:00:00Z' },
      { source: 'jira', author: 'qa', body: 'repro?', createdAt: '2026-07-01T00:00:00Z' },
    ],
    comments: [], pr: null, createdAt: null, updatedAt: null, daysSinceActivity: 0, pinned: false, pinnedAt: null,
  });
  saveState(statePath, state);

  const { DEVHUD_HOME: _, ...env } = process.env as Record<string, string>;
  const client = new Client({ name: 'devhud-test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./index.ts', import.meta.url))],
    env: { ...env, DEVHUD_HOME: home },
    stderr: 'pipe',
  }));
  try {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['todo_list', 'ack_card']));
    expect(Object.keys(tools.find(t => t.name === 'ack_card')!.inputSchema.properties ?? {}).sort()).toEqual(['key', 'reason']);

    const textOf = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as { type: string; text: string }[])[0]!.text;
    const todo = await client.callTool({ name: 'todo_list', arguments: {} });
    expect(todo.isError).toBeFalsy();
    const queue = (JSON.parse(textOf(todo)) as { queue: QueueEntry[] }).queue;
    expect(queue.map(e => e.reason).sort()).toEqual(['new_jira_comments', 'new_pr_comments']);

    const ack = await client.callTool({ name: 'ack_card', arguments: { key: 'P-1', reason: 'new_pr_comments' } });
    expect(ack.isError).toBeFalsy();
    expect(JSON.parse(textOf(ack))).toEqual({ ok: true, bucket: 'in_progress' });
    const persisted = loadState(statePath).snapshot!;
    expect(persisted.buckets.in_progress[0]!.attention).toEqual(['new_jira_comments']);
    expect(persisted.queue.map(e => e.reason)).toEqual(['new_jira_comments']);
  } finally {
    await client.close();
  }
}, 20_000);
