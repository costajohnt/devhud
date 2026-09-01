import type { Card, Pr, CardState, JiraStatuses, Bucket, NewComment, PrComment, JiraComment } from './types.ts';

// The one place a raw PR/Jira comment becomes a NewComment (300-char body
// cap, source tag, author fallback). classify's attention queue and
// refresh's itemComments both consume these; they used to each hand-roll
// the mapping and had already drifted on the Jira author fallback (`||` vs
// `??` — an empty-string author should fall through to authorId).
export const githubNewComment = (c: PrComment): NewComment =>
  ({ source: 'github', author: c.author, body: c.body?.slice(0, 300) ?? '', createdAt: c.createdAt ?? null });
export const jiraNewComment = (c: JiraComment): NewComment =>
  ({ source: 'jira', author: c.author || c.authorId || '', body: c.body?.slice(0, 300) ?? '', createdAt: c.createdAt });

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
export const STATE_REASONS: readonly string[] = ['ci_failing', 'merged_not_in_test', 'missing_qa_instructions', 'missing_fix_version'];

// A card has a lifecycle state (its Jira status / PR state) and it has pending
// events. Needs Attention is an overlay on the second axis, so only reasons
// that mean *blocked or broken* may evict a card from the column its status
// puts it in. Everything else stays where it belongs and wears a badge: new
// comments render as the "N new comments" pill, missing QA instructions as a
// pill on the QA Ready card. Before this split, one unread comment moved an In
// Progress card out of In Progress, and the missing-QA rule emptied QA Ready
// into Needs Attention on the day it shipped.
export const ROUTING_REASONS: readonly string[] = ['ci_failing', 'merged_not_in_test'];

// QA-instructions heuristic for In Test cards: a line mentioning "QA
// instructions" / "QA test instructions" / "test instructions" anywhere in
// the (ADF-flattened) description counts. ponytail: naive substring check,
// tighten to divider+heading parsing if it false-positives in practice.
export const hasQaInstructions = (description: string): boolean =>
  /(qa|test)\s+instructions/i.test(description);

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
      newComments.push(githubNewComment(c));
    }
  }
  if (newComments.length) attention.push('new_pr_comments');

  const jiraNew = (card.comments ?? []).filter(c =>
    c.authorId !== card.myAccountId && !isIgnoredAuthor(c.author, ignoreAuthors) && after(c.createdAt, cs.lastSeenJira));
  if (jiraNew.length) {
    attention.push('new_jira_comments');
    newComments.push(...jiraNew.map(jiraNewComment));
  }

  if (pr?.state === 'merged' && !sameStatus(card.status, statuses.inTest) && !sameStatus(card.status, statuses.done)) {
    attention.push('merged_not_in_test');
  }

  // An In Test card without QA instructions is invisible to QA: nudge the
  // developer to add them before a tester picks the card up. Jira-derived,
  // so it stays valid even when PR data is degraded.
  if (sameStatus(card.status, statuses.inTest) && !hasQaInstructions(card.description ?? '')) {
    attention.push('missing_qa_instructions');
  }

  // Same hand-off gap, other half: a card that reaches QA with no fix version
  // is missing from the release notes and gives the tester nothing to target.
  // Badge, not routing, for the same reason as the QA rule — it is retroactive
  // and would otherwise empty QA Ready on the day it ships.
  if (sameStatus(card.status, statuses.inTest) && !(card.fixVersions ?? []).length) {
    attention.push('missing_fix_version');
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
  if (cs.override && (sameStatus(card.status, statuses.inTest) || sameStatus(card.status, statuses.done))) {
    cs.override = null;
    cs.overrideAt = null;
  }

  // A pin is a statement about the card as it stood when it was dragged; a
  // Jira status transition supersedes it. Without this, a card pinned to In
  // Progress while addressing review feedback stayed pinned after the
  // In Progress → Code Review transition instead of falling back to the
  // classifier's Waiting in Review (#53). lastStatus is absent in
  // pre-existing state files, so the first refresh only records it.
  if (cs.override && cs.lastStatus != null && cs.lastStatus !== card.status) {
    cs.override = null;
    cs.overrideAt = null;
  }
  cs.lastStatus = card.status;

  // A draft PR is the executor's "I finished, you look at it first" signal
  // (github.ts maps a `Draft` label onto isDraft, which is how Simon marks
  // every PR it opens). Moving the Jira card to a review status is the
  // operator answering "I have looked, it is out for peer review" — an
  // explicit lifecycle statement, so the draft no longer holds the card in
  // Self Review Needed (#53). Same principle as #42: a card belongs in the
  // column its status earns unless something is blocked or broken.
  const draftOpen = pr?.state === 'open' && !!pr.isDraft;
  const outForReview = isInReview(card.status, statuses);

  let bucket: Bucket;
  if (draftOpen && !outForReview) {
    bucket = 'self_review';
  } else if (visible.some(r => ROUTING_REASONS.includes(r))) bucket = 'needs_attention';
  else if (cs.override) bucket = cs.override;
  // The one comment that IS routing. ROUTING_REASONS stays global and unchanged
  // (adding new_jira_comments to it would bounce In Progress cards on every
  // comment, which is exactly what that list exists to prevent). This is scoped
  // to In Test, where a Jira comment is QA saying they are waiting on the
  // developer — the card's own lifecycle state is what makes the comment
  // actionable rather than informational.
  //
  // Safe against the failure the ROUTING_REASONS comment records, where the
  // missing-QA rule emptied QA Ready on the day it shipped: that reason was
  // persistently true, so the column stayed empty. new_jira_comments is not a
  // STATE_REASON and so is not ack-governed — the lastSeen watermark clears it
  // as soon as the developer reads the comment, and the card falls straight
  // back to QA Ready.
  else if (sameStatus(card.status, statuses.inTest)) {
    bucket = visible.includes('new_jira_comments') ? 'needs_attention' : 'qa_ready';
  }
  // Checked before the approved branch below: a draft PR cannot be merged as
  // it stands, so it must not read as Mergeable however its reviews landed.
  else if (draftOpen) bucket = 'waiting_review';
  else if (pr?.state === 'open') {
    if (pr.reviewState === 'approved') {
      bucket = 'mergeable';
    } else if (isInReview(card.status, statuses) || pr.reviewState !== 'none') {
      bucket = 'waiting_review';
    } else {
      bucket = 'self_review';
    }
  }
  // A Code Review status routes here even with no open PR. Previously this
  // check lived only inside the branch above, so moving a card to Code Review
  // before its PR existed (or while the board had not linked one yet) left it
  // sitting in In Progress no matter how many refreshes ran (#64). The Jira
  // status is the developer's own statement about the work; it should not be
  // conditional on the board having found a PR.
  else if (isInReview(card.status, statuses)) bucket = 'waiting_review';
  else bucket = 'in_progress';

  newComments.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return { bucket, attention: visible, newComments };
}

// Every Jira status name — configured or fetched — is free text an admin can
// re-case or pad, so no status comparison in this file may be an exact `===`.
// The review comparison normalized (#64) while In Test / Done / Canceled / To Do
// stayed exact, so a project whose column read "in test" routed review
// case-insensitively and In Test not at all (#67). This helper is the single
// comparison every one of them now goes through. An undefined or blank status
// never matches, including against another blank.
export const sameStatus = (a: string | undefined, b: string | undefined): boolean => {
  const x = a?.trim().toLowerCase();
  return !!x && x === b?.trim().toLowerCase();
};

// Unlike To Do / Done, this cannot be decided by status category: Jira files
// both 'In Progress' and 'Code Review' under the same 'indeterminate'
// category, so the name is the only signal. The two stock names stay
// recognised alongside any configured one so existing configs (which have no
// `review` key) keep working (#64).
const REVIEW_ALIASES = ['code review', 'in review'];

export const isInReview = (status: string | undefined, statuses: JiraStatuses | undefined): boolean => {
  const name = status?.trim().toLowerCase();
  if (!name) return false;
  return sameStatus(name, statuses?.review) || REVIEW_ALIASES.includes(name);
};

// Category-first, exact-name fallback. Jira routing must follow the status
// *category*, not one hard-coded name: 'Assigned' is a To Do status, 'Canceled'
// is a Done status, and neither equals the configured todo/done name. Fixtures
// and configs without a category fall back to the exact-name comparison.
export const isCanceled = (card: Card, statuses: JiraStatuses): boolean =>
  sameStatus(card.status, statuses.canceled ?? 'Canceled');

export const isTodo = (card: Card, statuses: JiraStatuses): boolean =>
  card.statusCategory === 'new' || sameStatus(card.status, statuses.todo);

// Completion is the Jira Done category, minus Canceled (which lives in the Done
// category but is an abandonment, not a completion — see isCanceled).
export const isDone = (card: Card, statuses: JiraStatuses): boolean =>
  !isCanceled(card, statuses) && (card.statusCategory === 'done' || sameStatus(card.status, statuses.done));
