#!/usr/bin/env node
// Plain-TS ESM CLI, no deps. Dual transport: if a simon-dash server is
// already listening on the configured port, commands go through its HTTP
// API (so a running server's in-memory state — the source of truth while
// it's up — is what gets read/mutated); otherwise the CLI operates
// directly on disk via the same server/*.ts modules the server itself
// uses (loadState/saveState/refresh/applyAction), so behavior is identical
// either way. Which transport was used is always printed to stderr in
// human mode.
import { parseArgs } from 'node:util';
import { spawnSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { loadState, emptySnapshot } from './state.ts';
import { refresh } from './refresh.ts';
import { applyAction, BUCKETS } from './actions.ts';
import { performWrite } from './writeback.ts';
import { probeServer, serverAppearsRunning, splitBrainError, saveStateGuarded } from './transport.ts';
import type { Config, Snapshot } from './types.ts';

// Re-exported for backward compatibility: server/cli.test.ts imports
// probeServer from here, and server/transport.ts is also used directly by
// the MCP server (mcp/handlers.ts) so all transports (HTTP proxy, direct
// disk access, and the split-brain guard) can't drift between callers.
export { probeServer };

const HELP = `simon-dash — Jira/GitHub board CLI

Usage:
  simon-dash status [--json]               Show the board snapshot
  simon-dash refresh [--json]              Refresh from Jira/GitHub (or demo data), then show it
  simon-dash ack <KEY> [--json]            Acknowledge a card's attention flags
  simon-dash move <KEY> <bucket> [--json]  Pin a card to a bucket (${BUCKETS.join('|')})
  simon-dash transition <KEY> <status...> [--json]  Transition a Jira card to a workflow status
  simon-dash comment <KEY> <text...> [--json]       Comment on a Jira card
  simon-dash pr-comment <repo#num> <text...> [--json]  Comment on a GitHub PR
  simon-dash serve                         Run the dashboard server in the foreground
  simon-dash open                          Open the dashboard in your browser
  simon-dash --help                        Show this help

If a simon-dash server is already running on the configured port, commands
go through its HTTP API; otherwise they operate directly on data/state.json.

transition/comment/pr-comment are write-back: they mutate real Jira/GitHub
data. Gated by writeEnabled in config.json (refuses otherwise) and always a
no-op in demo mode. See the README's write-back section.
`;

export function formatStatus(payload: Snapshot): string {
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

export interface CliResult {
  code: number;
  out: string;
  err: string;
}

// Runs one CLI invocation and returns { code, out, err } instead of touching
// process.exit/console directly, so tests can call it in-process. The
// script-entry block at the bottom does the actual printing/exit.
export async function run(argv: string[], { config, statePath, configPath }: {
  config: Config; statePath: string; configPath?: string;
}): Promise<CliResult> {
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
    // `node server/index.ts` run directly.
    const result = spawnSync(process.execPath, [join(fileURLToPath(new URL('.', import.meta.url)), 'index.ts')], { stdio: 'inherit' });
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
    let payload: Snapshot;
    if (cmd === 'refresh') {
      if (viaServer) {
        const res = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' } });
        if (!res.ok) return { code: 1, out: '', err: [err, `HTTP ${res.status}`].join('\n') };
        payload = await res.json() as Snapshot;
      } else {
        const blockingPid = serverAppearsRunning(statePath);
        if (blockingPid) return { code: 1, out: '', err: [err, splitBrainError(blockingPid)].join('\n') };
        // quiet: refresh()'s operational log line would corrupt this
        // command's stdout (plain status text, or --json).
        const state = loadState(statePath);
        payload = await refresh({ config, state, quiet: true });
        // Re-checked immediately before the write (not just the early guard
        // above) — a server can start during the refresh itself.
        try {
          saveStateGuarded(statePath, state);
        } catch (e) {
          return { code: 1, out: '', err: [err, (e as Error).message].join('\n') };
        }
      }
    } else {
      payload = viaServer
        ? await (await fetch(`${base}/api/data`)).json() as Snapshot
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

    let result: { ok: true; bucket: string | null } | { error: string };
    if (viaServer) {
      const body = cmd === 'move' ? { type: 'move', key, bucket } : { type: 'ack', key };
      const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      // /api/action's own response already carries the resulting bucket —
      // no need for a second round-trip to /api/data just to look it up.
      const j = await res.json().catch(() => ({})) as { bucket?: string | null; error?: string };
      result = res.ok ? { ok: true, bucket: j.bucket ?? null } : { error: j.error ?? `HTTP ${res.status}` };
    } else {
      const blockingPid = serverAppearsRunning(statePath);
      if (blockingPid) return { code: 1, out: '', err: [err, splitBrainError(blockingPid)].join('\n') };
      const state = loadState(statePath);
      const r = applyAction({ state, config, type: cmd, key, bucket });
      if ('error' in r) {
        result = { error: r.error };
      } else {
        // Re-checked immediately before the write, not just the early guard
        // above — closes the gap a slow applyAction call could open.
        try {
          saveStateGuarded(statePath, state);
          result = { ok: true, bucket: r.bucket };
        } catch (e) {
          result = { error: (e as Error).message };
        }
      }
    }

    if (values.json) {
      const out = JSON.stringify(
        'error' in result
          ? { ok: false, key, error: result.error }
          : { ok: true, key, bucket: result.bucket },
      );
      return { code: 'error' in result ? 1 : 0, out, err };
    }
    if ('error' in result) return { code: 1, out: '', err: [err, `Error: ${result.error}`].join('\n') };
    const out = result.bucket ? `${key} -> ${result.bucket}` : `${key}: not currently on the board`;
    return { code: 0, out, err };
  }

  if (cmd === 'transition' || cmd === 'comment' || cmd === 'pr-comment') {
    const type = cmd === 'transition' ? 'transition' : cmd === 'comment' ? 'comment' : 'pr_comment';
    let key: string | undefined, repoRef: string | undefined, number: number | undefined, body: string | undefined, status: string | undefined;

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
    let result: Record<string, unknown>;
    if (viaServer) {
      const res = await fetch(`${base}/api/write`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(writeArgs) });
      result = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok && !result.error) result.error = `HTTP ${res.status}`;
    } else {
      // The write call itself is a network call to Jira/GitHub with no
      // local state — but performWrite's post-write refresh does write
      // state.json (same operation `refresh` guards), so this needs the
      // same split-brain guard.
      const blockingPid = serverAppearsRunning(statePath);
      if (blockingPid) return { code: 1, out: '', err: [err, splitBrainError(blockingPid)].join('\n') };
      const state = loadState(statePath);
      result = await performWrite({ config, state, ...writeArgs, configPath }) as unknown as Record<string, unknown>;
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
          result = { ...result, saveBlockedError: (e as Error).message };
        }
      }
    }

    if (values.json) {
      return { code: result.error ? 1 : 0, out: JSON.stringify(result), err };
    }
    if (result.error) return { code: 1, out: '', err: [err, `Error: ${result.error as string}`].join('\n') };
    if (result.demo) return { code: 0, out: result.message as string, err };
    const out = result.transitionedTo ? `${key} -> ${result.transitionedTo as string}` : `${cmd} ok`;
    // The write itself succeeded even if the post-write refresh failed, or
    // the local save got blocked — warnings, not errors: exit 0, success on
    // stdout, warning(s) on stderr.
    const warnings: string[] = [];
    if (result.refreshError) warnings.push(`Warning: board refresh after write failed: ${result.refreshError as string}`);
    if (result.saveBlockedError) warnings.push(`Warning: local board save skipped: ${result.saveBlockedError as string}`);
    const finalErr = warnings.length ? [err, ...warnings].join('\n') : err;
    return { code: 0, out, err: finalErr };
  }

  return { code: 1, out: '', err: `Unknown command: ${cmd}\n\n${HELP}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const configPath = fileURLToPath(new URL('../config.json', import.meta.url));
    const config = loadConfig(configPath);
    const root = fileURLToPath(new URL('..', import.meta.url));
    const statePath = join(root, 'data', 'state.json');
    const { code, out, err } = await run(process.argv.slice(2), { config, statePath, configPath });
    if (err) console.error(err);
    if (out) console.log(out);
    process.exit(code);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}
