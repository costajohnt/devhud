import { cardState } from './state.ts';
import { STATE_REASONS } from './classify.ts';
import type { State, Config, Bucket, ActionResult, Item } from './types.ts';

export const BUCKETS: Bucket[] = ['in_progress', 'self_review', 'waiting_review', 'mergeable', 'qa_ready', 'in_qa'];

// Union of already-acked reasons and the state-based reasons currently shown
// on the item — unioned, not overwritten, because a previously acked reason
// is already suppressed from item.attention and overwriting would silently
// un-mute it. Comment reasons never enter this set (the lastSeen watermarks
// govern those); classifyCard prunes entries whose reason has cleared.
const ackReasons = (prior: string[] | null | undefined, attention: string[]): string[] | null => {
  const merged = new Set([...(prior ?? []), ...attention.filter(r => STATE_REASONS.includes(r))]);
  return merged.size ? [...merged] : null;
};

// Shared ack/move logic used by both the HTTP handler (server/index.ts
// POST /api/action) and the CLI (server/cli.ts `ack`/`move` commands) so the
// two transports can never drift on semantics. Mutates `state` in place
// (same contract as the original inline handler); callers are responsible
// for saveState(). Returns `{ ok: true, bucket }` on success — `bucket` is
// the card's resulting bucket, or null if the card isn't on the current
// board (a valid no-op: it may have merged away or never been fetched) — or
// `{ error, status }` on failure.
export function applyAction({ state, config, type, key, bucket }: {
  state: State; config: Config; type: string; key: unknown; bucket?: string;
}): ActionResult {
  // Validated once here so every transport (HTTP, CLI direct mode, MCP
  // direct mode) gets the same rejection instead of cardState() silently
  // creating a `state.cards["undefined"]` (or similar) entry for a bad key.
  if (typeof key !== 'string' || !key) {
    return { error: 'key is required and must be a non-empty string', status: 400 };
  }
  // Prototype-pollution guard: `state.cards[key] ??= {...}` in cardState()
  // is a bracket-assignment sink. For key === '__proto__', the read side of
  // that expression returns the live Object.prototype (an inherited
  // accessor, not a missing key), which is never nullish — so `??=` never
  // assigns, and cardState() hands back Object.prototype itself. Every
  // subsequent `cs.lastSeenPr = ...` then lands as a real own-property on
  // Object.prototype, inherited by every plain object for the rest of the
  // process. 'constructor' and 'prototype' are blocked too as the same
  // class of key-as-accessor risk, even though only '__proto__' is
  // exploitable through a plain object today.
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    return { error: `key "${key}" is not allowed`, status: 400 };
  }
  const cs = cardState(state, key);
  const snap = state.snapshot;
  const findItem = (): { from: Bucket; i: number; item: Item } | null => {
    for (const b of Object.keys(snap?.buckets ?? {}) as Bucket[]) {
      const i = snap!.buckets[b].findIndex(x => x.key === key);
      if (i >= 0) return { from: b, i, item: snap!.buckets[b][i]! };
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
    if (!loc || !snap) return { ok: true, bucket: null };
    // Record acked state-based reasons so classifyCard keeps them muted on
    // subsequent refreshes — see CardState.ackedReasons and ackReasons above.
    cs.ackedReasons = ackReasons(cs.ackedReasons, loc.item.attention);
    loc.item.attention = [];
    loc.item.newComments = [];
    if (loc.from === 'needs_attention') {
      snap.buckets.needs_attention.splice(loc.i, 1);
      let dest: Bucket;
      if (cs.override) dest = cs.override;
      else if (loc.item.jiraStatus === config.jira?.statuses?.inTest) dest = 'qa_ready';
      else if (loc.item.pr?.state === 'open') {
        if (loc.item.pr.reviewState === 'approved') {
          dest = 'mergeable';
        } else if (loc.item.jiraStatus === 'Code Review' || loc.item.jiraStatus === 'In Review' || loc.item.pr.reviewState !== 'none') {
          dest = 'waiting_review';
        } else {
          dest = 'self_review';
        }
      }
      else dest = 'in_progress';
      loc.item.bucket = dest;
      snap.buckets[dest].push(loc.item);
      return { ok: true, bucket: dest };
    }
    return { ok: true, bucket: loc.from };
  }

  if (type === 'move') {
    if (!bucket || !BUCKETS.includes(bucket as Bucket)) return { error: `bucket must be one of ${BUCKETS.join(', ')}`, status: 400 };
    const target = bucket as Bucket;
    cs.override = target;
    cs.overrideAt = new Date().toISOString();
    // Also bump the seen horizon so old comments already accounted for by
    // the classifier don't bounce the card straight back to needs_attention
    // on the next refresh.
    cs.lastSeenPr = cs.lastSeenJira = horizon;
    const loc = findItem();
    if (!loc || !snap) return { ok: true, bucket: null };
    // A manual move is an acknowledgment too: mute state-based reasons and
    // clear the item's attention flags the same way ack does, so the moved
    // card doesn't keep its badges in the target bucket until the next
    // refresh (and doesn't bounce back on it).
    cs.ackedReasons = ackReasons(cs.ackedReasons, loc.item.attention);
    loc.item.attention = [];
    loc.item.newComments = [];
    snap.buckets[loc.from].splice(loc.i, 1);
    loc.item.bucket = target;
    snap.buckets[target].push(loc.item);
    return { ok: true, bucket: target };
  }

  return { error: 'unknown action type', status: 400 };
}
