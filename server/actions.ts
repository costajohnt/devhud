import { cardState } from './state.ts';
import { STATE_REASONS, routeBucket } from './classify.ts';
import { QUEUE_REASONS, rebuildQueue, routesToAttention } from './queue.ts';
import { KEY_RE } from './writeback.ts';
import type { State, Config, Bucket, ActionResult, Item, NewComment } from './types.ts';

// "owner/repo#123". Has a slash and a '#', so it can never be __proto__ and
// friends when used as a State.prs key.
export const PR_REF_RE = /^[\w.-]+\/[\w.-]+#\d+$/;

// The time the current snapshot's data was read (Snapshot.dataAsOf). Not
// updatedAt: that is stamped after every fetch finishes, so a comment that
// landed mid-refresh would sit before it, be missing from the snapshot, and
// be silently treated as seen once acked. Older snapshots fall back to
// updatedAt.
const dataHorizon = (state: State): string =>
  state.snapshot?.dataAsOf ?? state.snapshot?.updatedAt ?? new Date().toISOString();

// The seen horizon an ack/move records for one comment source: the latest of
// the data horizon, the newest comment the entry actually showed, and the
// previous horizon. The data horizon alone is held back while any source is
// falling back (refresh.ts), so a dismissal during a long partial outage
// would otherwise not cover the comments it showed and they'd re-flag every
// refresh. Like any timestamp horizon it can't recover a comment that
// becomes visible later with an older timestamp (a pending GitHub review's
// inline comments carry their draft time; a refresh can land between the
// tab rendering and the click), so it covers the comments the entry showed
// and anything older. Keeping the previous value means a held horizon can
// never move a card's horizon backward.
export function seenThrough(horizon: string, previous: string | null | undefined, shown: readonly NewComment[], source: NewComment['source']): string {
  let t = horizon;
  for (const c of shown) if (c.source === source && c.createdAt && Date.parse(c.createdAt) > Date.parse(t)) t = c.createdAt;
  return previous && Date.parse(previous) > Date.parse(t) ? previous : t;
}

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

// Where the classifier would put this item if it had no override — the
// snapshot is already built by the time an action runs, so a card leaving
// its current bucket needs its destination recomputed here rather than
// waiting for the next refresh.
//
// Deliberately mirrors classifyCard's order (classify.ts), including the
// draft-PR rule that outranks everything and its one exception (a card in a
// review status is out for peer review, so the draft stops holding it in
// self_review, #53): ack used to compute this inline
// without the draft check, so acking a card on an approved draft PR sent it
// to `mergeable` while the next refresh moved it straight back to
// `self_review`. Shared between ack and unpin so the two can't drift from
// each other or from the classifier.
export function classifierDest(item: Item, config: Config, override: Bucket | null = null): Bucket {
  return routeBucket({ status: item.jiraStatus, pr: item.pr, visible: item.attention, override, statuses: config.jira?.statuses });
}

// Shared ack/move logic used by both the HTTP handler (server/index.ts
// POST /api/action) and the CLI (server/cli.ts `ack`/`move` commands) so the
// two transports can never drift on semantics. Mutates `state` in place
// (same contract as the original inline handler); callers are responsible
// for saveState(). Returns `{ ok: true, bucket }` on success — `bucket` is
// the card's resulting bucket, or null if the card isn't on the current
// board (a valid no-op: it may have merged away or never been fetched) — or
// `{ error, status }` on failure.
export function applyAction(args: {
  state: State; config: Config; type: string; key: unknown; bucket?: string; reason?: unknown;
}): ActionResult {
  const result = applyActionToSnapshot(args);
  // Every action can change attention or buckets, so the queue is rebuilt
  // from the edited snapshot rather than patched alongside it.
  if (!('error' in result) && args.state.snapshot) rebuildQueue(args.state.snapshot, args.config.jira.statuses);
  return result;
}

function applyActionToSnapshot({ state, config, type, key, bucket, reason }: {
  state: State; config: Config; type: string; key: unknown; bucket?: string; reason?: unknown;
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
  // A review request has no card: it is keyed by its PR ref and dismissed
  // until the PR next changes (State.prs, applied in buildSnapshot).
  if (type === 'ack' && reason === 'review_requested') {
    if (!PR_REF_RE.test(key)) return { error: 'review_requested acks take a PR ref like owner/repo#123', status: 400 };
    const rr = state.snapshot?.reviewRequests?.find(r => r.id === key);
    if (!rr) return { ok: true, bucket: null };
    rr.dismissed = true;
    (state.prs ??= {})[key] = { dismissedAt: rr.updatedAt };
    return { ok: true, bucket: null };
  }
  // One of the user's card-less PRs: same per-reason semantics as a card
  // (comments advance the seen horizon, state reasons mute while true), and
  // likewise only for a reason the PR currently shows.
  if (type === 'ack' && typeof reason === 'string' && PR_REF_RE.test(key)) {
    const u = state.snapshot?.unlinkedPrs?.find(p => `${p.repo}#${p.number}` === key);
    if (!u?.attention?.includes(reason)) return { ok: true, bucket: null };
    const ps = ((state.ownPrs ??= {})[key] ??= { lastSeenPr: null });
    if (reason === 'new_pr_comments') {
      ps.lastSeenPr = seenThrough(dataHorizon(state), ps.lastSeenPr, u.newComments ?? [], 'github');
      u.newComments = [];
    } else {
      ps.ackedReasons = ackReasons(ps.ackedReasons, [reason]);
    }
    u.attention = u.attention.filter(r => r !== reason);
    return { ok: true, bucket: null };
  }
  // Everything else is validated before cardState() too: it creates a
  // state.cards entry on first touch, so a bad type, bucket or a key that is
  // not a Jira key would otherwise grow state.json without limit.
  if (!KEY_RE.test(key)) return { error: 'key must be a Jira issue key like PROJ-123', status: 400 };
  if (type !== 'ack' && type !== 'move' && type !== 'unpin') return { error: 'unknown action type', status: 400 };
  if (reason !== undefined && (type !== 'ack' || typeof reason !== 'string' || !QUEUE_REASONS.includes(reason))) {
    return { error: `reason is only valid on ack and must be one of ${QUEUE_REASONS.join(', ')}`, status: 400 };
  }
  if (type === 'move' && (!bucket || !BUCKETS.includes(bucket as Bucket))) {
    return { error: `bucket must be one of ${BUCKETS.join(', ')}`, status: 400 };
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
  // "Seen" horizon is the data horizon, not wall-clock time — a comment that
  // arrived after the data was read must still be treated as new.
  const horizon = dataHorizon(state);

  // Per-reason ack: dismisses one TODO entry and leaves the card's other
  // entries alone. Comment reasons advance only their own source's seen
  // horizon; state reasons are muted the same way a full ack mutes them.
  if (type === 'ack' && typeof reason === 'string') {
    // Only an entry the user can actually see may be dismissed. Recording an
    // ack for a reason not currently on the card would pre-mute it: the next
    // real CI failure would arrive already acked (classifyCard keeps acks
    // whose reason is true) and never surface.
    const loc = findItem();
    if (!loc || !snap || !loc.item.attention.includes(reason)) return { ok: true, bucket: loc?.from ?? null };
    if (reason === 'new_pr_comments') cs.lastSeenPr = seenThrough(horizon, cs.lastSeenPr, loc.item.newComments, 'github');
    else if (reason === 'new_jira_comments') cs.lastSeenJira = seenThrough(horizon, cs.lastSeenJira, loc.item.newComments, 'jira');
    else cs.ackedReasons = ackReasons(cs.ackedReasons, [reason]);
    const source = reason === 'new_pr_comments' ? 'github' : reason === 'new_jira_comments' ? 'jira' : null;
    loc.item.attention = loc.item.attention.filter(r => r !== reason);
    if (source) loc.item.newComments = loc.item.newComments.filter(c => c.source !== source);
    if (loc.from === 'needs_attention' && !routesToAttention(loc.item, config.jira?.statuses)) {
      snap.buckets.needs_attention.splice(loc.i, 1);
      const dest = classifierDest(loc.item, config, cs.override);
      loc.item.bucket = dest;
      snap.buckets[dest].push(loc.item);
      return { ok: true, bucket: dest };
    }
    return { ok: true, bucket: loc.from };
  }

  // Full ack and move both mark every comment the card showed as seen.
  const markSeen = (shown: readonly NewComment[]) => {
    cs.lastSeenPr = seenThrough(horizon, cs.lastSeenPr, shown, 'github');
    cs.lastSeenJira = seenThrough(horizon, cs.lastSeenJira, shown, 'jira');
  };

  if (type === 'ack') {
    // override is intentionally kept: acking only clears the attention
    // flags, it doesn't undo a prior manual move.
    const loc = findItem();
    markSeen(loc?.item.newComments ?? []);
    if (!loc || !snap) return { ok: true, bucket: null };
    // Record acked state-based reasons so classifyCard keeps them muted on
    // subsequent refreshes — see CardState.ackedReasons and ackReasons above.
    cs.ackedReasons = ackReasons(cs.ackedReasons, loc.item.attention);
    loc.item.attention = [];
    loc.item.newComments = [];
    if (loc.from === 'needs_attention') {
      snap.buckets.needs_attention.splice(loc.i, 1);
      // A prior manual move still wins: acking clears attention flags, it
      // doesn't undo a pin (that's what unpin is for).
      const dest = classifierDest(loc.item, config, cs.override);
      loc.item.bucket = dest;
      snap.buckets[dest].push(loc.item);
      return { ok: true, bucket: dest };
    }
    return { ok: true, bucket: loc.from };
  }

  if (type === 'move') {
    const target = bucket as Bucket;
    cs.override = target;
    cs.overrideAt = new Date().toISOString();
    // Also bump the seen horizon so old comments already accounted for by
    // the classifier don't bounce the card straight back to needs_attention
    // on the next refresh.
    const loc = findItem();
    markSeen(loc?.item.newComments ?? []);
    if (!loc || !snap) return { ok: true, bucket: null };
    // A manual move is an acknowledgment too: mute state-based reasons and
    // clear the item's attention flags the same way ack does, so the moved
    // card doesn't keep its badges in the target bucket until the next
    // refresh (and doesn't bounce back on it).
    cs.ackedReasons = ackReasons(cs.ackedReasons, loc.item.attention);
    loc.item.attention = [];
    loc.item.newComments = [];
    // Mirror the pin onto the snapshot item so the broadcast that follows
    // this action already shows it (the Unpin affordance appears in every
    // tab immediately, not on the next refresh).
    loc.item.pinned = true;
    loc.item.pinnedAt = cs.overrideAt;
    snap.buckets[loc.from].splice(loc.i, 1);
    loc.item.bucket = target;
    snap.buckets[target].push(loc.item);
    return { ok: true, bucket: target };
  }

  // Releases a manual pin and hands the card back to the classifier. Without
  // this, `override` was write-only: drag-to-pin set it, and the only other
  // exit is a Jira status transition (classifyCard's lastStatus rule).
  //
  // Unlike ack this does NOT touch the seen horizons — unpinning says
  // "stop forcing this bucket", not "I've read the new comments", and
  // conflating them would silently mark unread activity as seen.
  if (type === 'unpin') {
    const wasPinned = cs.override !== null;
    cs.override = null;
    cs.overrideAt = null;
    const loc = findItem();
    if (!loc || !snap) return { ok: true, bucket: null, wasPinned };
    // Recompute from the item as it stands, including any attention flags
    // still on it: a pinned card CAN sit in needs_attention (classifyCard
    // checks attention before override), and unpinning must not quietly
    // pull it out of the triage queue.
    const dest = classifierDest(loc.item, config);
    loc.item.pinned = false;
    loc.item.pinnedAt = null;
    snap.buckets[loc.from].splice(loc.i, 1);
    loc.item.bucket = dest;
    snap.buckets[dest].push(loc.item);
    return { ok: true, bucket: dest, wasPinned };
  }

  return { error: 'unknown action type', status: 400 };
}
