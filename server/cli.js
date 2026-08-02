#!/usr/bin/env node
// Plain-JS ESM CLI, no deps. Dual transport: if a jira-dash server is
// already listening on the configured port, commands go through its HTTP
// API (so a running server's in-memory state — the source of truth while
// it's up — is what gets read/mutated); otherwise the CLI operates
// directly on disk via the same server/*.js modules the server itself
// uses (loadState/saveState/refresh/applyAction), so behavior is identical
// either way. Which transport was used is always printed to stderr in
// human mode.
import { parseArgs } from 'node:util';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { loadState, saveState, emptySnapshot } from './state.js';
import { refresh } from './refresh.js';
import { applyAction, BUCKETS } from './actions.js';
import { probeServer } from './transport.js';

// Re-exported for backward compatibility: server/cli.test.js imports
// probeServer from here, and server/transport.js is also used directly by
// the MCP server (mcp/handlers.js) so both transports can't drift.
export { probeServer };

const HELP = `jira-dash — Jira/GitHub board CLI

Usage:
  jira-dash status [--json]               Show the board snapshot
  jira-dash refresh [--json]              Refresh from Jira/GitHub (or demo data), then show it
  jira-dash ack <KEY> [--json]            Acknowledge a card's attention flags
  jira-dash move <KEY> <bucket> [--json]  Pin a card to a bucket (${BUCKETS.join('|')})
  jira-dash serve                         Run the dashboard server in the foreground
  jira-dash open                          Open the dashboard in your browser
  jira-dash --help                        Show this help

If a jira-dash server is already running on the configured port, commands
go through its HTTP API; otherwise they operate directly on data/state.json.
`;

// Split-brain guard for direct-mode WRITES (ack/move, refresh): the 500ms
// probe can time out while a real server is nonetheless alive (slow
// response, momentary hiccup), and if direct mode writes state.json in
// that window, the server's next save silently clobbers it (or vice
// versa) since neither knows about the other's write. server/index.js
// writes data/server.pid with { pid, ... } on successful bind and removes
// it on shutdown, so a stale pid file (crash, kill -9) is the only false
// positive — process.kill(pid, 0) still filters those out (ESRCH) unless
// the pid was reused by an unrelated process, an accepted residual risk.
// Read-only `status` doesn't call this — it's safe to read state.json
// while a server independently holds it in memory.
function serverAppearsRunning(statePath) {
  let pid;
  try {
    pid = JSON.parse(readFileSync(join(dirname(statePath), 'server.pid'), 'utf8')).pid;
  } catch {
    return null;
  }
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

const splitBrainError = (pid) =>
  `a server (pid ${pid}) appears to be running but did not answer the probe; retry, or stop it before using direct mode`;

export function formatStatus(payload) {
  if (!payload.updatedAt) {
    return 'No data yet — run `jira-dash refresh` to fetch a snapshot.';
  }
  const b = payload.buckets;
  const lines = [
    `Needs Attention: ${b.needs_attention.length}  In Progress: ${b.in_progress.length}  ` +
      `Waiting in Review: ${b.waiting_review.length}  In QA: ${b.in_qa.length}`,
    `TODO: ${payload.todo.length}  Merged: ${payload.mergedTotal}`,
  ];
  if (b.needs_attention.length) {
    lines.push('', 'Needs Attention:');
    for (const item of b.needs_attention) {
      lines.push(`  ${item.key}  ${item.summary}  [${item.attention.join(', ')}]`);
    }
  }
  return lines.join('\n');
}

// Runs one CLI invocation and returns { code, out, err } instead of touching
// process.exit/console directly, so tests can call it in-process. The
// script-entry block at the bottom does the actual printing/exit.
export async function run(argv, { config, statePath }) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
  });
  const [cmd, ...rest] = positionals;

  if (values.help) return { code: 0, out: HELP, err: '' };
  if (!cmd) return { code: 1, out: HELP, err: '' };

  if (cmd === 'serve') {
    // Foreground: inherit stdio and block until the server exits, mirroring
    // `node server/index.js` run directly.
    const result = spawnSync(process.execPath, [join(new URL('.', import.meta.url).pathname, 'index.js')], { stdio: 'inherit' });
    return { code: result.status ?? 1, out: '', err: '' };
  }
  if (cmd === 'open') {
    const url = `http://localhost:${config.port}`;
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    return { code: 0, out: `Opening ${url}`, err: '' };
  }

  const viaServer = await probeServer(config.port);
  const err = viaServer ? 'via server' : 'direct';
  const base = `http://127.0.0.1:${config.port}`;

  if (cmd === 'status' || cmd === 'refresh') {
    let payload;
    if (cmd === 'refresh') {
      if (viaServer) {
        payload = await (await fetch(`${base}/api/refresh`, { method: 'POST' })).json();
      } else {
        const blockingPid = serverAppearsRunning(statePath);
        if (blockingPid) return { code: 1, out: '', err: [err, splitBrainError(blockingPid)].join('\n') };
        // refresh() logs an operational one-liner via console.log — fine
        // when the server does it (that's its process log), but it would
        // corrupt this command's stdout (plain status text, or --json).
        // Silence it just for this call.
        const state = loadState(statePath);
        const originalLog = console.log;
        console.log = () => {};
        try {
          payload = await refresh({ config, state });
        } finally {
          console.log = originalLog;
        }
        saveState(statePath, state);
      }
    } else {
      payload = viaServer
        ? await (await fetch(`${base}/api/data`)).json()
        : (loadState(statePath).snapshot ?? emptySnapshot());
    }
    const out = values.json ? JSON.stringify(payload) : formatStatus(payload);
    return { code: 0, out, err };
  }

  if (cmd === 'ack' || cmd === 'move') {
    const key = rest[0];
    const bucket = cmd === 'move' ? rest[1] : undefined;
    if (!key || (cmd === 'move' && !bucket)) {
      const usage = `usage: jira-dash ${cmd} <KEY>${cmd === 'move' ? ' <bucket>' : ''}`;
      return { code: 1, out: '', err: [err, usage].join('\n') };
    }

    let result;
    if (viaServer) {
      const body = cmd === 'move' ? { type: 'move', key, bucket } : { type: 'ack', key };
      const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        result = { error: j.error ?? `HTTP ${res.status}` };
      } else {
        const data = await (await fetch(`${base}/api/data`)).json();
        const item = Object.values(data.buckets).flat().find(i => i.key === key);
        result = { ok: true, bucket: item?.bucket ?? null };
      }
    } else {
      const blockingPid = serverAppearsRunning(statePath);
      if (blockingPid) return { code: 1, out: '', err: [err, splitBrainError(blockingPid)].join('\n') };
      const state = loadState(statePath);
      const r = applyAction({ state, config, type: cmd, key, bucket });
      if (r.error) {
        result = { error: r.error };
      } else {
        saveState(statePath, state);
        result = { ok: true, bucket: r.bucket };
      }
    }

    if (values.json) {
      const out = JSON.stringify(
        result.error
          ? { ok: false, key, error: result.error }
          : { ok: true, key, bucket: result.bucket },
      );
      return { code: result.error ? 1 : 0, out, err };
    }
    if (result.error) return { code: 1, out: '', err: [err, `Error: ${result.error}`].join('\n') };
    const out = result.bucket ? `${key} -> ${result.bucket}` : `${key}: not currently on the board`;
    return { code: 0, out, err };
  }

  return { code: 1, out: '', err: `Unknown command: ${cmd}\n\n${HELP}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const config = loadConfig();
    const root = new URL('..', import.meta.url).pathname;
    const statePath = join(root, 'data', 'state.json');
    const { code, out, err } = await run(process.argv.slice(2), { config, statePath });
    if (err) console.error(err);
    if (out) console.log(out);
    process.exit(code);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
