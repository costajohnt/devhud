import { cardState } from './state.js';

export const BUCKETS = ['in_progress', 'waiting_review', 'in_qa'];

// Shared ack/move logic used by both the HTTP handler (server/index.js
// POST /api/action) and the CLI (server/cli.js `ack`/`move` commands) so the
// two transports can never drift on semantics. Mutates `state` in place
// (same contract as the original inline handler); callers are responsible
// for saveState(). Returns `{ ok: true, bucket }` on success — `bucket` is
// the card's resulting bucket, or null if the card isn't on the current
// board (a valid no-op: it may have merged away or never been fetched) — or
// `{ error, status }` on failure.
export function applyAction({ state, config, type, key, bucket }) {
  const cs = cardState(state, key);
  const snap = state.snapshot;
  const findItem = () => {
    for (const b of Object.keys(snap?.buckets ?? {})) {
      const i = snap.buckets[b].findIndex(x => x.key === key);
      if (i >= 0) return { from: b, i, item: snap.buckets[b][i] };
    }
    return null;
  };
  // "Seen" horizon is the data horizon (last snapshot's updatedAt), not
  // wall-clock time — a comment that arrived between the last refresh and
  // this ack must still be treated as new on the next refresh.
  const horizon = state.snapshot?.updatedAt ?? new Date().toISOString();

  if (type === 'ack') {
    cs.lastSeenPr = cs.lastSeenJira = horizon;
    // override is intentionally kept: acking only clears the attention
    // flags, it doesn't undo a prior manual move.
    const loc = findItem();
    if (!loc) return { ok: true, bucket: null };
    loc.item.attention = [];
    loc.item.newComments = [];
    if (loc.from === 'needs_attention') {
      snap.buckets.needs_attention.splice(loc.i, 1);
      const dest = cs.override ?? (loc.item.jiraStatus === config.jira?.statuses?.inTest ? 'in_qa' : 'in_progress');
      loc.item.bucket = dest;
      snap.buckets[dest].push(loc.item);
      return { ok: true, bucket: dest };
    }
    return { ok: true, bucket: loc.from };
  }

  if (type === 'move') {
    if (!BUCKETS.includes(bucket)) return { error: `bucket must be one of ${BUCKETS.join(', ')}`, status: 400 };
    cs.override = bucket;
    cs.overrideAt = new Date().toISOString();
    // Also bump the seen horizon so old comments already accounted for by
    // the classifier don't bounce the card straight back to needs_attention
    // on the next refresh.
    cs.lastSeenPr = cs.lastSeenJira = horizon;
    const loc = findItem();
    if (!loc) return { ok: true, bucket: null };
    snap.buckets[loc.from].splice(loc.i, 1);
    loc.item.bucket = bucket;
    snap.buckets[bucket].push(loc.item);
    return { ok: true, bucket };
  }

  return { error: 'unknown action type', status: 400 };
}
