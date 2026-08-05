import type { Card, Pr, CardState, JiraStatuses, Bucket, NewComment } from './types.ts';

const after = (ts: string | null | undefined, since: string | null | undefined): boolean => !since || (!!ts && ts > since);

// Case-insensitive substring match — 'John' matches 'John Costa' and the
// 'john' GitHub login, 'Rovo' matches 'Rovo (Atlassian Intelligence)'.
const isIgnoredAuthor = (name: string | null | undefined, ignore: string[]): boolean => {
  const n = (name ?? '').toLowerCase();
  return !!n && ignore.some(a => n.includes(a.toLowerCase()));
};

// The attention reasons that stay true across refreshes (unlike comment
// reasons, which the lastSeen* watermarks govern). Only these may live in
// CardState.ackedReasons — ack recording (actions.ts) and the pruning below
// both filter against this list so the two files can't drift.
export const STATE_REASONS: readonly string[] = ['ci_failing', 'merged_not_in_test'];

export interface ClassifyResult {
  bucket: Bucket;
  attention: string[];
  newComments: NewComment[];
}

export function classifyCard({ card, pr, cs, statuses, username, ignoreAuthors = [], prDegraded = false }: {
  card: Card; pr: Pr | null; cs: CardState; statuses: JiraStatuses; username: string; ignoreAuthors?: string[];
  // True when this refresh's PR data is degraded (GitHub fetch or enrichment
  // errors). Both state-based reasons derive from PR data, so pruning acks
  // against a degraded view would wipe them and bounce the card back into
  // Needs Attention on the next healthy refresh.
  prDegraded?: boolean;
}): ClassifyResult {
  const attention: string[] = [];
  const newComments: NewComment[] = [];

  if (pr?.ciStatus === 'failing' && pr.state === 'open') attention.push('ci_failing');

  for (const c of pr?.comments ?? []) {
    if (c.author !== username && !isIgnoredAuthor(c.author, ignoreAuthors) && after(c.createdAt, cs.lastSeenPr)) {
      newComments.push({ source: 'github', author: c.author, body: c.body?.slice(0, 300) ?? '', createdAt: c.createdAt ?? null });
    }
  }
  if (newComments.length) attention.push('new_pr_comments');

  const jiraNew = (card.comments ?? []).filter(c =>
    c.authorId !== card.myAccountId && !isIgnoredAuthor(c.author, ignoreAuthors) && after(c.createdAt, cs.lastSeenJira));
  if (jiraNew.length) {
    attention.push('new_jira_comments');
    newComments.push(...jiraNew.map(c => ({ source: 'jira' as const, author: c.author ?? c.authorId ?? '', body: c.body?.slice(0, 300) ?? '', createdAt: c.createdAt })));
  }

  if (pr?.state === 'merged' && card.status !== statuses.inTest && card.status !== statuses.done) {
    attention.push('merged_not_in_test');
  }

  // Ack suppression: an acknowledged state-based reason stays muted for as
  // long as it remains continuously true. Once a reason clears, its ack is
  // forgotten — a recurrence is a new event and re-triggers Needs Attention.
  // Skipped while PR data is degraded (see prDegraded above). Filtering
  // against STATE_REASONS also drops junk entries (hand-edited state files)
  // that would otherwise mute comment attention forever. cs is mutated in
  // place; the caller persists card state after the refresh, same as the
  // celebration bookkeeping in buildSnapshot.
  const acked = (cs.ackedReasons ?? []).filter(r => STATE_REASONS.includes(r) && (prDegraded || attention.includes(r)));
  cs.ackedReasons = acked.length ? acked : null;
  const visible = attention.filter(r => !acked.includes(r));

  // Auto-clear a stale override once the card reaches In Test or Done:
  // the card's lifecycle has moved past developer-side bucketing.
  if (cs.override && (card.status === statuses.inTest || card.status === statuses.done)) {
    cs.override = null;
    cs.overrideAt = null;
  }

  let bucket: Bucket;
  if (pr?.state === 'open' && pr.isDraft) {
    bucket = 'self_review';
  } else if (visible.length) bucket = 'needs_attention';
  else if (cs.override) bucket = cs.override;
  else if (card.status === statuses.inTest) bucket = 'qa_ready';
  else if (pr?.state === 'open') {
    if (pr.reviewState === 'approved') {
      bucket = 'mergeable';
    } else if (card.status === 'Code Review' || card.status === 'In Review' || pr.reviewState !== 'none') {
      bucket = 'waiting_review';
    } else {
      bucket = 'self_review';
    }
  }
  else bucket = 'in_progress';

  newComments.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return { bucket, attention: visible, newComments };
}

// Category-first, exact-name fallback. Jira routing must follow the status
// *category*, not one hard-coded name: 'Assigned' is a To Do status, 'Canceled'
// is a Done status, and neither equals the configured todo/done name. Fixtures
// and configs without a category fall back to the exact-name comparison.
export const isCanceled = (card: Card, statuses: JiraStatuses): boolean =>
  card.status === (statuses.canceled ?? 'Canceled');

export const isTodo = (card: Card, statuses: JiraStatuses): boolean =>
  card.statusCategory === 'new' || card.status === statuses.todo;

// Completion is the Jira Done category, minus Canceled (which lives in the Done
// category but is an abandonment, not a completion — see isCanceled).
export const isDone = (card: Card, statuses: JiraStatuses): boolean =>
  !isCanceled(card, statuses) && (card.statusCategory === 'done' || card.status === statuses.done);
