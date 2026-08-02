// Tool handler functions for the jira-dash MCP server, kept separate from
// mcp/index.js's stdio wiring so they're callable directly in tests without
// spinning up a real MCP transport.
//
// Same dual-transport rule as the CLI (server/cli.js): probe the configured
// HTTP port first. If a jira-dash server is already running, go through its
// HTTP API so its in-memory state (source of truth while it's up) is what
// gets read/mutated. Otherwise operate directly on disk via the same
// server/*.js modules the server itself uses.
import { loadState, saveState, emptySnapshot } from '../server/state.js';
import { refresh } from '../server/refresh.js';
import { applyAction } from '../server/actions.js';
import { probeServer, serverAppearsRunning, splitBrainError } from '../server/transport.js';

async function getSnapshot({ config, statePath }) {
  const viaServer = await probeServer(config.port);
  if (viaServer) {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/data`);
    return await res.json();
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

export async function cardComments(ctx) {
  const { key } = ctx;
  const snapshot = await getSnapshot(ctx);
  const item = Object.values(snapshot.buckets ?? {}).flat().find(i => i.key === key)
    ?? (snapshot.mergedCards ?? []).find(i => i.key === key);
  if (!item) return { error: `no card with key "${key}" found on the current board` };
  return { key: item.key, comments: item.comments ?? [], newComments: item.newComments ?? [] };
}
