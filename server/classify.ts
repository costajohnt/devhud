import type { Card, Pr, CardState, JiraStatuses, Bucket, NewComment } from './types.ts';

const after = (ts: string | null | undefined, since: string | null | undefined): boolean => !since || (!!ts && ts > since);

// Case-insensitive substring match — 'John' matches 'John Costa' and the
// 'john' GitHub login, 'Rovo' matches 'Rovo (Atlassian Intelligence)'.
const isIgnoredAuthor = (name: string | null | undefined, ignore: string[]): boolean => {
  const n = (name ?? '').toLowerCase();
  return !!n && ignore.some(a => n.includes(a.toLowerCase()));
};

export interface ClassifyResult {
  bucket: Bucket;
  attention: string[];
  newComments: NewComment[];
}

export function classifyCard({ card, pr, cs, statuses, username, ignoreAuthors = [] }: {
  card: Card; pr: Pr | null; cs: CardState; statuses: JiraStatuses; username: string; ignoreAuthors?: string[];
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

  let bucket: Bucket;
  if (attention.length) bucket = 'needs_attention';
  else if (cs.override) bucket = cs.override;
  else if (card.status === statuses.inTest) bucket = 'in_qa';
  else if (pr?.state === 'open' && pr.reviewState !== 'none') bucket = 'waiting_review';
  else bucket = 'in_progress';

  newComments.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return { bucket, attention, newComments };
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
