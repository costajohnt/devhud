const after = (ts, since) => !since || ts > since;

export function classifyCard({ card, pr, cs, statuses, username }) {
  const attention = [];
  const newComments = [];

  if (pr?.ciStatus === 'failing' && pr.state === 'open') attention.push('ci_failing');

  for (const c of pr?.comments ?? []) {
    if (c.author !== username && after(c.createdAt, cs.lastSeenPr)) {
      newComments.push({ source: 'github', author: c.author, body: c.body?.slice(0, 300) ?? '', createdAt: c.createdAt });
    }
  }
  if (newComments.length) attention.push('new_pr_comments');

  const jiraNew = (card.comments ?? []).filter(c => c.authorId !== card.myAccountId && after(c.createdAt, cs.lastSeenJira));
  if (jiraNew.length) {
    attention.push('new_jira_comments');
    newComments.push(...jiraNew.map(c => ({ source: 'jira', author: c.author ?? c.authorId, body: c.body?.slice(0, 300) ?? '', createdAt: c.createdAt })));
  }

  if (pr?.state === 'merged' && card.status !== statuses.inTest && card.status !== statuses.done) {
    attention.push('merged_not_in_test');
  }

  let bucket;
  if (attention.length) bucket = 'needs_attention';
  else if (cs.override) bucket = cs.override;
  else if (card.status === statuses.inTest) bucket = 'in_qa';
  else if (pr?.state === 'open' && pr.reviewState !== 'none') bucket = 'waiting_review';
  else bucket = 'in_progress';

  newComments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { bucket, attention, newComments };
}

export const isTodo = (card, statuses) => card.status === statuses.todo;
export const isDone = (card, statuses) => card.status === statuses.done;
