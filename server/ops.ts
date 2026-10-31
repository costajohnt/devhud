// Dual-transport OPERATIONS, one level above transport.ts's primitives:
// snapshot / refresh / action / write, each deciding once between the HTTP
// proxy path (a live server's in-memory state is the source of truth) and
// the direct-disk path (loadState → op → saveStateGuarded, with the
// split-brain guard). The CLI (server/cli.ts) and the MCP server
// (mcp/handlers.ts) both consume these; before this file each re-derived
// the whole branch near line-for-line, and the two copies had already
// drifted once (saveBlockedError treatment). Callers own presentation only:
// argv/output formatting in the CLI, tool-result shaping in MCP.
import { loadState, emptySnapshot } from './state.ts';
import { refresh } from './refresh.ts';
import { rebuildQueue } from './queue.ts';
import { applyAction } from './actions.ts';
import { performWrite } from './writeback.ts';
import { probeDevhud, serverAppearsRunning, splitBrainError, saveStateGuarded, readApiToken, tokenHeaders } from './transport.ts';
import type { Config, Snapshot, Bucket, WriteResult } from './types.ts';

export interface OpCtx {
  config: Config;
  statePath: string;
  configPath?: string;
  // Pass a pre-probed answer to avoid a second probe (the CLI probes once
  // up front to print "via server"/"direct"); omit to let the op probe.
  viaServer?: boolean;
}

export interface OpError { error: string; }

const base = (config: Config) => `http://127.0.0.1:${config.port}`;
const probed = (ctx: OpCtx) => ctx.viaServer ?? probeDevhud(ctx.config.port, ctx.statePath);
// The server's API token, read from next to the state file it guards.
const auth = (ctx: OpCtx) => tokenHeaders(readApiToken(ctx.statePath));

export async function opSnapshot(ctx: OpCtx): Promise<Snapshot | OpError> {
  if (await probed(ctx)) {
    // The probe and this fetch are two separate round-trips — a server that
    // answered the probe can still drop the connection by the time this
    // call lands. Catch into the same { error } shape as everything else.
    try {
      const res = await fetch(`${base(ctx.config)}/api/data`, { headers: auth(ctx) });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return await res.json() as Snapshot;
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  const state = loadState(ctx.statePath);
  const snap = state.snapshot ?? emptySnapshot();
  // A state file from before the queue existed migrates to queue: []; rebuild
  // from the buckets so the CLI/MCP don't report an empty TODO list until the
  // next refresh. Cheap and pure, so always rebuilt on this path.
  rebuildQueue(snap, ctx.config.jira.statuses, state.queueSeen);
  return snap;
}

export async function opRefresh(ctx: OpCtx): Promise<Snapshot | OpError> {
  if (await probed(ctx)) {
    // res.json() inside the try too: a non-JSON 200 must come back as
    // { error }, not escape the op as a raw throw (MCP would leak it to
    // the SDK; the CLI would mask it in its top-level catch).
    try {
      const res = await fetch(`${base(ctx.config)}/api/refresh`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(ctx) } });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return await res.json() as Snapshot;
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  const blockingPid = serverAppearsRunning(ctx.statePath);
  if (blockingPid) return { error: splitBrainError(blockingPid) };
  const state = loadState(ctx.statePath);
  // quiet: direct-mode callers' stdout is user-facing output (CLI) or a
  // protocol channel (MCP); refresh()'s log line has no business there.
  const payload = await refresh({ config: ctx.config, state, quiet: true });
  // Re-checked immediately before the write, not just the early guard
  // above — a server can start during the refresh itself.
  try {
    saveStateGuarded(ctx.statePath, state);
  } catch (e) {
    return { error: (e as Error).message };
  }
  return payload;
}

export interface OpActionResult { ok: true; bucket: Bucket | null; wasPinned?: boolean; }

export async function opAction(ctx: OpCtx, { type, key, bucket, reason }: {
  type: string; key: string; bucket?: string; reason?: string;
}): Promise<OpActionResult | OpError> {
  if (await probed(ctx)) {
    // Forward the type rather than collapsing everything-but-move to 'ack':
    // that shortcut silently turned an unpin into an acknowledgement over
    // the HTTP transport while direct mode did the right thing. Only 'move'
    // carries a bucket.
    const body = type === 'move' ? { type: 'move', key, bucket } : reason !== undefined ? { type, key, reason } : { type, key };
    let res: Response;
    try {
      res = await fetch(`${base(ctx.config)}/api/action`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...auth(ctx) }, body: JSON.stringify(body),
      });
    } catch (e) {
      return { error: (e as Error).message };
    }
    // /api/action's own response already carries the resulting bucket — no
    // need for a second round-trip to /api/data just to look it up.
    const j = await res.json().catch(() => ({})) as { bucket?: Bucket | null; wasPinned?: boolean; error?: string };
    return res.ok ? { ok: true, bucket: j.bucket ?? null, wasPinned: j.wasPinned } : { error: j.error ?? `HTTP ${res.status}` };
  }
  const blockingPid = serverAppearsRunning(ctx.statePath);
  if (blockingPid) return { error: splitBrainError(blockingPid) };
  const state = loadState(ctx.statePath);
  const r = applyAction({ state, config: ctx.config, type, key, bucket, reason });
  if ('error' in r) return { error: r.error };
  // Re-checked immediately before the write, not just the early guard above.
  try {
    saveStateGuarded(ctx.statePath, state);
  } catch (e) {
    return { error: (e as Error).message };
  }
  return { ok: true, bucket: r.bucket, wasPinned: r.wasPinned };
}

// Write-back (transition/comment/pr_comment): the write call itself is a
// network call to Jira/GitHub with no local state — but performWrite's
// post-write refresh does write state.json (the same operation opAction/
// opRefresh guard), so the direct branch needs the same split-brain guard.
// Gate refusal (writeEnabled false, or demo mode) is handled entirely
// inside performWrite.
export async function opWrite(ctx: OpCtx, writeArgs: {
  type: string; key?: string; repo?: string; number?: number; body?: string; status?: string;
  // 'mcp' for writes an MCP tool asked for: gated by mcpWriteEnabled too.
  source?: 'mcp';
}): Promise<WriteResult> {
  if (await probed(ctx)) {
    let res: Response;
    try {
      res = await fetch(`${base(ctx.config)}/api/write`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...auth(ctx) }, body: JSON.stringify(writeArgs),
      });
    } catch (e) {
      return { error: (e as Error).message };
    }
    const j = await res.json().catch(() => ({})) as WriteResult;
    if (!res.ok) return { error: ('error' in j ? j.error : undefined) ?? `HTTP ${res.status}` };
    return j;
  }
  const blockingPid = serverAppearsRunning(ctx.statePath);
  if (blockingPid) return { error: splitBrainError(blockingPid) };
  const state = loadState(ctx.statePath);
  const result = await performWrite({ state, ...writeArgs, configPath: ctx.configPath });
  if ('ok' in result && !('demo' in result)) {
    // The external Jira/GitHub write already succeeded by this point — a
    // blocked local save must not read as the whole call having failed
    // (nothing needs retrying upstream, and retrying could double-post);
    // it's a warning field on an otherwise-successful result, same
    // treatment as refreshError.
    try {
      saveStateGuarded(ctx.statePath, state);
    } catch (e) {
      return { ...result, saveBlockedError: (e as Error).message };
    }
  }
  return result;
}
