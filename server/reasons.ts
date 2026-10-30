// Every attention reason, one row each (audit M19). The lists the rest of the
// server needs (which reasons route a card, which are ack-governed, which a
// PR alone produces, queue order and priority) are derived from this table,
// so adding a reason is one edit instead of five that can drift.
//
// - priority: TODO queue rank (1 broken or blocking someone, 2 waiting on a
//   reply, 3 housekeeping).
// - routing: may evict a card from its status column into Needs Attention.
//   Only "blocked or broken" reasons; everything else rides as a badge.
//   (new_jira_comments also routes, but only on an In Test card: see
//   routeBucket in classify.ts.)
// - stateful: true while a condition holds, so an ack mutes it while
//   continuously true (CardState.ackedReasons). Comment reasons are governed
//   by seen horizons instead; review_requested by its own dismissal.
// - prSource: produced by a PR alone (prAttention), card or no card.
// Key order is the queue's tie-break order.
export const REASONS = {
  ci_failing: { priority: 1, routing: true, stateful: true, prSource: true },
  changes_requested: { priority: 1, routing: false, stateful: true, prSource: true },
  review_requested: { priority: 2, routing: false, stateful: false, prSource: false },
  new_pr_comments: { priority: 2, routing: false, stateful: false, prSource: true },
  new_jira_comments: { priority: 2, routing: false, stateful: false, prSource: false },
  merged_not_in_test: { priority: 2, routing: true, stateful: true, prSource: false },
  ready_to_merge: { priority: 3, routing: false, stateful: true, prSource: true },
  missing_qa_instructions: { priority: 3, routing: false, stateful: true, prSource: false },
  missing_fix_version: { priority: 3, routing: false, stateful: true, prSource: false },
} as const satisfies Record<string, { priority: 1 | 2 | 3; routing: boolean; stateful: boolean; prSource: boolean }>;

export type Reason = keyof typeof REASONS;
export const isReason = (r: string): r is Reason => Object.hasOwn(REASONS, r);

const all = Object.keys(REASONS) as Reason[];
export const QUEUE_REASONS: readonly string[] = all;
export const ROUTING_REASONS: readonly string[] = all.filter(r => REASONS[r].routing);
export const STATE_REASONS: readonly string[] = all.filter(r => REASONS[r].stateful);
// The acks a PR carries between its card and state.ownPrs (refresh.ts).
export const PR_ACK_REASONS: readonly string[] = all.filter(r => REASONS[r].stateful && REASONS[r].prSource);
