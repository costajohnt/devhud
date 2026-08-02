// Shared dual-transport helper: if a simon-dash server is already listening
// on the configured port, callers (CLI, MCP server) should go through its
// HTTP API so the running server's in-memory state — the source of truth
// while it's up — is what gets read/mutated; otherwise they operate
// directly on disk via the same server/*.js modules the server itself uses
// (loadState/saveState/refresh/applyAction), so behavior is identical
// either way.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { saveState } from './state.js';

// ~500ms budget: long enough that a live server on loopback always answers,
// short enough that "no server running" doesn't make every command feel stuck.
export async function probeServer(port, { timeoutMs = 500 } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/data`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

// Split-brain guard for direct-mode WRITES (ack/move, refresh, write-back):
// the probe above can time out while a real server is nonetheless alive
// (slow response, momentary hiccup), and if direct mode writes state.json in
// that window, the server's next save silently clobbers it (or vice versa)
// since neither knows about the other's write. server/index.js writes
// data/server.pid with { pid, ... } on successful bind and removes it on
// shutdown, so a stale pid file (crash, kill -9) is the only false
// positive — process.kill(pid, 0) still filters those out (ESRCH) unless
// the pid was reused by an unrelated process, an accepted residual risk.
// Read-only reads don't need this — it's safe to read state.json while a
// server independently holds it in memory.
//
// What this guard does NOT cover: two direct-mode processes running at the
// same time with no server at all (e.g. two `simon-dash ack` invocations
// launched back to back from two terminals). Neither writes a pid file —
// there's nothing for the other one to detect — so that's a plain
// last-writer-wins race with no guard against it whatsoever. See
// docs/ARCHITECTURE.md's "Concurrency" section for the full picture; don't
// read this comment as covering that case too.
export function serverAppearsRunning(statePath) {
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

export const splitBrainError = (pid) =>
  `a server (pid ${pid}) appears to be running but did not answer the probe; retry, or stop it before using direct mode`;

// TOCTOU-safe save: every direct-mode call site already checks
// serverAppearsRunning() once, early, before doing any work (so a genuinely
// slow/expensive operation — a real Jira/GitHub write, a full refresh —
// doesn't run at all when a server is obviously up). But time passes
// between that early check and the actual disk write below it — a server
// can start in that window. This re-checks immediately before the write
// itself and throws (rather than returning a sentinel a caller could
// forget to check) so no caller can accidentally skip straight to
// saveState() after the gap.
export function saveStateGuarded(statePath, state) {
  const blockingPid = serverAppearsRunning(statePath);
  if (blockingPid) throw new Error(splitBrainError(blockingPid));
  saveState(statePath, state);
}
