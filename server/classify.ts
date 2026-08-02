import type { Card, Pr, CardState, JiraStatuses, Bucket, NewComment } from './types.ts';

const after = (ts: string | null | undefined, since: string | null | undefined): boolean => !since || (!!ts && ts > since);

export interface ClassifyResult {
  bucket: Bucket;
  attention: string[];
  newComments: NewComment[];
}

export function classifyCard({ card, pr, cs, statuses, username }: {
  card: Card; pr: Pr | null; cs: CardState; statuses: JiraStatuses; username: string;
}): ClassifyResult {
  const attention: string[] = [];
  const newComments: NewComment[] = [];

  if (pr?.ciStatus === 'failing' && pr.state === 'open') attention.push('ci_failing');

  for (const c of pr?.comments ?? []) {
    if (c.author !== username && after(c.createdAt, cs.lastSeenPr)) {
      newComments.push({ source: 'github', author: c.author, body: c.body?.slice(0, 300) ?? '', createdAt: c.createdAt ?? null });
    }
  }
  if (newComments.length) attention.push('new_pr_comments');

  const jiraNew = (card.comments ?? []).filter(c => c.authorId !== card.myAccountId && after(c.createdAt, cs.lastSeenJira));
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

export const isTodo = (card: Card, statuses: JiraStatuses): boolean => card.status === statuses.todo;
export const isDone = (card: Card, statuses: JiraStatuses): boolean => card.status === statuses.done;
