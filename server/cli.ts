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
import { BUCKETS } from './actions.ts';
import { opSnapshot, opRefresh, opAction, opWrite } from './ops.ts';
import { probeServer } from './transport.ts';
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
  simon-dash unpin <KEY> [--json]          Release a pin, returning the card to the classifier
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
      `Self Review: ${b.self_review.length}  Waiting in Review: ${b.waiting_review.length}  Mergeable: ${b.mergeable.length}  QA Ready: ${b.qa_ready.length}  In QA: ${b.in_qa.length}`,
    `Todo: ${payload.todo.length}  Done: ${payload.doneTotal}`,
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
    // Platform-appropriate opener: the macOS-only `open` binary printed
    // "Opening …" and exited 0 on Linux/Windows while opening nothing, and
    // its missing 'error' listener turned the ENOENT into an unhandled
    // 'error' event (a raw stack trace) whenever anything delayed the exit.
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.on('error', (e) => console.error(`could not launch ${opener}: ${e.message} — open ${url} yourself`));
    child.unref();
    return { code: 0, out: `Opening ${url}`, err: '' };
  }

  // Probed once here (not inside each op) so the transport note on stderr
  // can never disagree with the path the op actually took.
  const viaServer = await probeServer(config.port);
  const err = viaServer ? 'via server' : 'direct';
  const ctx = { config, statePath, configPath, viaServer };

  if (cmd === 'status' || cmd === 'refresh') {
    const result = cmd === 'refresh' ? await opRefresh(ctx) : await opSnapshot(ctx);
    if ('error' in result) return { code: 1, out: '', err: [err, result.error].join('\n') };
    const payload = result as Snapshot;
    const out = values.json ? JSON.stringify(payload) : formatStatus(payload);
    return { code: 0, out, err };
  }

  if (cmd === 'ack' || cmd === 'move' || cmd === 'unpin') {
    const key = rest[0];
    const bucket = cmd === 'move' ? rest[1] : undefined;
    if (!key || (cmd === 'move' && !bucket)) {
      const usage = `usage: simon-dash ${cmd} <KEY>${cmd === 'move' ? ' <bucket>' : ''}`;
      return { code: 1, out: '', err: [err, usage].join('\n') };
    }

    const result = await opAction(ctx, { type: cmd, key, bucket });

    if (values.json) {
      const out = JSON.stringify(
        'error' in result
          ? { ok: false, key, error: result.error }
          : { ok: true, key, bucket: result.bucket, ...(cmd === 'unpin' ? { wasPinned: result.wasPinned ?? false } : {}) },
      );
      return { code: 'error' in result ? 1 : 0, out, err };
    }
    if ('error' in result) return { code: 1, out: '', err: [err, `Error: ${result.error}`].join('\n') };
    // Unpinning a card that wasn't pinned is a no-op worth naming, rather
    // than reporting a move that didn't really happen.
    if (cmd === 'unpin' && result.wasPinned === false) {
      const out = result.bucket ? `${key}: was not pinned (in ${result.bucket})` : `${key}: was not pinned`;
      return { code: 0, out, err };
    }
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

    const result = await opWrite(ctx, { type, key, repo: repoRef, number, body, status });

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
