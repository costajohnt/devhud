// Tool handler functions for the simon-dash MCP server, kept separate from
// mcp/index.js's stdio wiring so they're callable directly in tests without
// spinning up a real MCP transport.
//
// Same dual-transport rule as the CLI (server/cli.js): probe the configured
// HTTP port first. If a simon-dash server is already running, go through its
// HTTP API so its in-memory state (source of truth while it's up) is what
// gets read/mutated. Otherwise operate directly on disk via the same
// server/*.js modules the server itself uses.
import { loadState, saveState, emptySnapshot } from '../server/state.js';
import { refresh } from '../server/refresh.js';
import { applyAction } from '../server/actions.js';
import { performWrite } from '../server/writeback.js';
import { probeServer, serverAppearsRunning, splitBrainError } from '../server/transport.js';

async function getSnapshot({ config, statePath }) {
  const viaServer = await probeServer(config.port);
  if (viaServer) {
    // The probe and this fetch are two separate round-trips — a server that
    // answered the probe can still drop the connection (or start erroring)
    // by the time this call lands. Catch it into the same { error } shape
    // every other handler returns instead of letting a raw throw propagate
    // out of an MCP tool call.
    try {
      const res = await fetch(`http://127.0.0.1:${config.port}/api/data`);
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return await res.json();
    } catch (e) {
      return { error: e.message };
    }
  }
  return loadState(statePath).snapshot ?? emptySnapshot();
}

export async function boardStatus(ctx) {
  return await getSnapshot(ctx);
}

export async function doRefresh({ config, statePath }) {
  const viaServer = await probeServer(config.port);
  let payload;
  if (viaServer) {
    payload = await (await fetch(`http://127.0.0.1:${config.port}/api/refresh`, { method: 'POST' })).json();
  } else {
    const blockingPid = serverAppearsRunning(statePath);
    if (blockingPid) return { error: splitBrainError(blockingPid) };
    const state = loadState(statePath);
    // refresh() logs an operational one-liner via console.log — fine when
    // the server does it, but this call has no business writing to the
    // MCP host's stdout/stderr on its own, so silence it for this call.
    const originalLog = console.log;
    console.log = () => {};
    try {
      payload = await refresh({ config, state });
    } finally {
      console.log = originalLog;
    }
    saveState(statePath, state);
  }
  const counts = Object.fromEntries(Object.entries(payload.buckets).map(([b, items]) => [b, items.length]));
  return { counts, errors: payload.errors, newlyMerged: payload.newlyMerged };
}

async function doAction({ config, statePath, type, key, bucket }) {
  const viaServer = await probeServer(config.port);
  if (viaServer) {
    const body = type === 'move' ? { type: 'move', key, bucket } : { type: 'ack', key };
    const res = await fetch(`http://127.0.0.1:${config.port}/api/action`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { error: j.error ?? `HTTP ${res.status}` };
    }
    const data = await (await fetch(`http://127.0.0.1:${config.port}/api/data`)).json();
    const item = Object.values(data.buckets).flat().find(i => i.key === key);
    return { ok: true, bucket: item?.bucket ?? null };
  }
  const blockingPid = serverAppearsRunning(statePath);
  if (blockingPid) return { error: splitBrainError(blockingPid) };
  const state = loadState(statePath);
  const r = applyAction({ state, config, type, key, bucket });
  if (r.error) return { error: r.error };
  saveState(statePath, state);
  return { ok: true, bucket: r.bucket };
}

export async function ackCard({ config, statePath, key }) {
  return await doAction({ config, statePath, type: 'ack', key });
}

export async function moveCard({ config, statePath, key, bucket }) {
  return await doAction({ config, statePath, type: 'move', key, bucket });
}

// Write-back (transition/comment/pr_comment): the write call itself is a
// network call to Jira/GitHub with no local state — but performWrite's
// post-write refresh does write state.json (same operation doAction/
// doRefresh guard), so this needs the same split-brain guard before the
// direct-mode branch. Gate refusal (writeEnabled false, or demo mode) is
// handled entirely inside performWrite.
async function doWrite({ config, statePath, type, key, repo, number, body, status }) {
  const viaServer = await probeServer(config.port);
  const writeArgs = { type, key, repo, number, body, status };
  if (viaServer) {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/write`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(writeArgs),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { error: j.error ?? `HTTP ${res.status}` };
    return j;
  }
  const blockingPid = serverAppearsRunning(statePath);
  if (blockingPid) return { error: splitBrainError(blockingPid) };
  const state = loadState(statePath);
  const result = await performWrite({ config, state, ...writeArgs });
  if (result.ok && !result.demo) saveState(statePath, state);
  return result;
}

export async function transitionCard({ config, statePath, key, status }) {
  return await doWrite({ config, statePath, type: 'transition', key, status });
}

export async function commentCard({ config, statePath, key, body }) {
  return await doWrite({ config, statePath, type: 'comment', key, body });
}

export async function commentPr({ config, statePath, repo, number, body }) {
  return await doWrite({ config, statePath, type: 'pr_comment', repo, number, body });
}

export async function cardComments(ctx) {
  const { key } = ctx;
  const snapshot = await getSnapshot(ctx);
  if (snapshot.error) return snapshot;
  const item = Object.values(snapshot.buckets ?? {}).flat().find(i => i.key === key)
    ?? (snapshot.mergedCards ?? []).find(i => i.key === key);
  if (!item) return { error: `no card with key "${key}" found on the current board` };
  return { key: item.key, comments: item.comments ?? [], newComments: item.newComments ?? [] };
}
