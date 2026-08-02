#!/usr/bin/env node
// Plain-JS ESM CLI, no deps. Dual transport: if a simon-dash server is
// already listening on the configured port, commands go through its HTTP
// API (so a running server's in-memory state — the source of truth while
// it's up — is what gets read/mutated); otherwise the CLI operates
// directly on disk via the same server/*.js modules the server itself
// uses (loadState/saveState/refresh/applyAction), so behavior is identical
// either way. Which transport was used is always printed to stderr in
// human mode.
import { parseArgs } from 'node:util';
import { spawnSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { loadState, emptySnapshot } from './state.js';
import { refresh } from './refresh.js';
import { applyAction, BUCKETS } from './actions.js';
import { performWrite } from './writeback.js';
import { probeServer, serverAppearsRunning, splitBrainError, saveStateGuarded } from './transport.js';

// Re-exported for backward compatibility: server/cli.test.js imports
// probeServer from here, and server/transport.js is also used directly by
// the MCP server (mcp/handlers.js) so all transports (HTTP proxy, direct
// disk access, and the split-brain guard) can't drift between callers.
export { probeServer };

const HELP = `simon-dash — Jira/GitHub board CLI

Usage:
  simon-dash status [--json]               Show the board snapshot
  simon-dash refresh [--json]              Refresh from Jira/GitHub (or demo data), then show it
  simon-dash ack <KEY> [--json]            Acknowledge a card's attention flags
  simon-dash move <KEY> <bucket> [--json]  Pin a card to a bucket (${BUCKETS.join('|')})
  simon-dash transition <KEY> <status...>  Transition a Jira card to a workflow status
  simon-dash comment <KEY> <text...>       Comment on a Jira card
  simon-dash pr-comment <repo#num> <text...>  Comment on a GitHub PR
  simon-dash serve                         Run the dashboard server in the foreground
  simon-dash open                          Open the dashboard in your browser
  simon-dash --help                        Show this help

If a simon-dash server is already running on the configured port, commands
go through its HTTP API; otherwise they operate directly on data/state.json.

transition/comment/pr-comment are write-back: they mutate real Jira/GitHub
data. Gated by writeEnabled in config.json (refuses otherwise) and always a
no-op in demo mode. See the README's write-back section.
`;

export function formatStatus(payload) {
  if (!payload.updatedAt) {
    return 'No data yet — run `simon-dash refresh` to fetch a snapshot.';
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
        payload = await (await fetch(`${base}/api/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' } })).json();
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
        // Re-checked immediately before the write (not just the early guard
        // above) — a server can start during the refresh itself.
        try {
          saveStateGuarded(statePath, state);
        } catch (e) {
          return { code: 1, out: '', err: [err, e.message].join('\n') };
        }
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
      const usage = `usage: simon-dash ${cmd} <KEY>${cmd === 'move' ? ' <bucket>' : ''}`;
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
        // Re-checked immediately before the write, not just the early guard
        // above — closes the gap a slow applyAction call could open.
        try {
          saveStateGuarded(statePath, state);
          result = { ok: true, bucket: r.bucket };
        } catch (e) {
          result = { error: e.message };
        }
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

  if (cmd === 'transition' || cmd === 'comment' || cmd === 'pr-comment') {
    const type = cmd === 'transition' ? 'transition' : cmd === 'comment' ? 'comment' : 'pr_comment';
    let key, repoRef, number, body, status;

    if (cmd === 'pr-comment') {
      const m = rest[0]?.match(/^(.+)#(\d+)$/);
      body = rest.slice(1).join(' ');
      if (!m || !body) {
        return { code: 1, out: '', err: [err, 'usage: simon-dash pr-comment <repo#num> <text...>'].join('\n') };
      }
      repoRef = m[1];
      number = Number(m[2]);
    } else {
      key = rest[0];
      const rest2 = rest.slice(1).join(' ');
      if (cmd === 'transition') status = rest2; else body = rest2;
      if (!key || !rest2) {
        const usage = cmd === 'transition' ? 'usage: simon-dash transition <KEY> <status...>' : 'usage: simon-dash comment <KEY> <text...>';
        return { code: 1, out: '', err: [err, usage].join('\n') };
      }
    }

    const writeArgs = { type, key, repo: repoRef, number, body, status };
    let result;
    if (viaServer) {
      const res = await fetch(`${base}/api/write`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(writeArgs) });
      result = await res.json().catch(() => ({}));
      if (!res.ok && !result.error) result.error = `HTTP ${res.status}`;
    } else {
      // The write call itself is a network call to Jira/GitHub with no
      // local state — but performWrite's post-write refresh does write
      // state.json (same operation `refresh` guards), so this needs the
      // same split-brain guard.
      const blockingPid = serverAppearsRunning(statePath);
      if (blockingPid) return { code: 1, out: '', err: [err, splitBrainError(blockingPid)].join('\n') };
      const state = loadState(statePath);
      result = await performWrite({ config, state, ...writeArgs });
      if (result.ok && !result.demo) {
        // Re-checked immediately before the write, not just the early guard
        // above. The external Jira/GitHub write already went through by
        // this point though — a save being blocked here must not read as
        // the whole command having failed (nothing needs retrying upstream,
        // and retrying could double-post a comment); it's a warning field
        // on an otherwise-successful result, same treatment as refreshError.
        try {
          saveStateGuarded(statePath, state);
        } catch (e) {
          result = { ...result, saveBlockedError: e.message };
        }
      }
    }

    if (values.json) {
      return { code: result.error ? 1 : 0, out: JSON.stringify(result), err };
    }
    if (result.error) return { code: 1, out: '', err: [err, `Error: ${result.error}`].join('\n') };
    if (result.demo) return { code: 0, out: result.message, err };
    const out = result.transitionedTo ? `${key} -> ${result.transitionedTo}` : `${cmd} ok`;
    // The write itself succeeded even if the post-write refresh failed, or
    // the local save got blocked — warnings, not errors: exit 0, success on
    // stdout, warning(s) on stderr.
    const warnings = [];
    if (result.refreshError) warnings.push(`Warning: board refresh after write failed: ${result.refreshError}`);
    if (result.saveBlockedError) warnings.push(`Warning: local board save skipped: ${result.saveBlockedError}`);
    const finalErr = warnings.length ? [err, ...warnings].join('\n') : err;
    return { code: 0, out, err: finalErr };
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
