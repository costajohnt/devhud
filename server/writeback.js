// Write-back to Jira/GitHub: the only code in jira-dash that mutates
// external systems. Everything else (refresh, ack, move) is read-only or
// local-only. Plain fetch, same shape as jira.js/github.js — no deps,
// 30s timeouts, throws Error on a non-2xx response.
//
// Gated hard, on by nobody by default: config.writeEnabled must be true,
// and demo mode always refuses regardless of the flag (there's nothing
// real to write to). See checkWriteGate/performWrite below — every write
// path (POST /api/write, the CLI's transition/comment/pr-comment commands,
// the MCP write tools) goes through performWrite() so the gate and the
// post-write refresh can't drift between callers, mirroring applyAction's
// role for ack/move.
import { refresh } from './refresh.js';

/** Minimal ADF (Atlassian Document Format) doc wrapping plain text in one paragraph. */
export function buildAdfDoc(text) {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

// Case-insensitive match on transition.to.name (the workflow status a
// transition leads to, not the transition's own name/id — "targetStatusName"
// is what a caller thinks of as the destination status).
export function findTransition(transitions, targetStatusName) {
  const target = (targetStatusName ?? '').toLowerCase();
  const match = transitions.find(t => (t.to?.name ?? '').toLowerCase() === target);
  if (match) return match;
  const available = transitions.map(t => t.to?.name).filter(Boolean);
  throw new Error(
    `no transition to "${targetStatusName}" available from the card's current status; ` +
    `available: ${available.length ? available.join(', ') : '(none)'}`,
  );
}

function jiraAuth(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
}

export async function transitionCard(cfg, key, targetStatusName) {
  const auth = jiraAuth(cfg);
  const url = new URL(`/rest/api/3/issue/${key}/transitions`, cfg.baseUrl);
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const transition = findTransition(data.transitions ?? [], targetStatusName);
  const postRes = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, Accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ transition: { id: transition.id } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!postRes.ok) throw new Error(`Jira ${postRes.status}: ${(await postRes.text()).slice(0, 200)}`);
  return { transitionedTo: transition.to.name };
}

export async function commentCard(cfg, key, body) {
  const url = new URL(`/rest/api/3/issue/${key}/comment`, cfg.baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: jiraAuth(cfg), Accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ body: buildAdfDoc(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return {};
}

export async function commentPr(cfg, repo, number, body) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return {};
}

// Demo mode has nothing real to write to, so it always refuses regardless
// of writeEnabled — but that's not an error state (nothing is misconfigured),
// so callers get a "stub success" shape ({ blocked: true, demo: true, ... })
// rather than one that reads as a failure. writeEnabled: false outside demo
// IS the user's explicit configuration blocking real writes, so that one
// stays a real refusal.
export function checkWriteGate(config) {
  if (config.demo) {
    return { blocked: true, demo: true, message: 'demo mode: write-back is a no-op (nothing real to write to)' };
  }
  if (!config.writeEnabled) {
    return { blocked: true, demo: false, message: 'write-back disabled; set writeEnabled: true in config.json' };
  }
  return { blocked: false };
}

const WRITE_TYPES = ['transition', 'comment', 'pr_comment'];

// Shared entry point for every write path. `state` is mutated in place by
// the post-write refresh (same contract as applyAction) — callers persist
// it themselves. Returns:
//   - { ok: true, demo: true, message } — demo-mode stub, nothing written
//   - { ok: true, ...writebackResult } — real write succeeded, board refreshed
//   - { error, status } — validation failure, gate refusal, or write failure
export async function performWrite({ config, state, type, key, repo, number, body, status }) {
  if (!WRITE_TYPES.includes(type)) {
    return { error: `unknown write type "${type}"`, status: 400 };
  }
  if (type === 'transition' && (!key || !status)) {
    return { error: 'transition requires key and status', status: 400 };
  }
  if (type === 'comment' && (!key || !body)) {
    return { error: 'comment requires key and body', status: 400 };
  }
  if (type === 'pr_comment' && (!repo || !number || !body)) {
    return { error: 'pr_comment requires repo, number, and body', status: 400 };
  }

  const gate = checkWriteGate(config);
  if (gate.blocked) {
    if (gate.demo) return { ok: true, demo: true, message: gate.message };
    return { error: gate.message, status: 403 };
  }

  let result;
  try {
    if (type === 'transition') result = await transitionCard(config.jira, key, status);
    else if (type === 'comment') result = await commentCard(config.jira, key, body);
    else result = await commentPr(config.github, repo, number, body);
  } catch (e) {
    return { error: e.message, status: 502 };
  }

  // Board reflects the write immediately instead of waiting for the next
  // poll. refresh() logs an operational one-liner via console.log — fine
  // for the server's own /api/refresh, but this call has no business
  // writing to a CLI/MCP caller's stdout on its own; silence it.
  const originalLog = console.log;
  console.log = () => {};
  try {
    await refresh({ config, state });
  } finally {
    console.log = originalLog;
  }

  return { ok: true, ...result };
}
