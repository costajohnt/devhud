// The TODO queue: every pending thing on the board that needs the developer,
// one entry per (card, attention reason), ranked. Derived purely from the
// snapshot's bucket items, so it is rebuilt after every refresh and every
// action and can never drift from the badges the board shows.
import { primaryStatus, sameStatus } from './classify.ts';
import { REASONS, QUEUE_REASONS, ROUTING_REASONS, isReason } from './reasons.ts';
import type { Bucket, Item, JiraStatuses, QueueEntry, ReviewRequest, Snapshot, UnlinkedPr } from './types.ts';

// Every reason the queue knows how to render (reasons.ts). Also the
// allowlist for a per-reason ack (actions.ts), so an ack can't name something
// the queue would never show.
export { QUEUE_REASONS };

const plural = (n: number, word: string) => `${n} new ${word}${n === 1 ? '' : 's'}`;
const authors = (names: string[]) => [...new Set(names)].join(', ');

function entry(item: Item, reason: string, statuses: JiraStatuses): QueueEntry | null {
  const pr = item.pr;
  const prName = pr ? `${pr.repo}#${pr.number}` : '';
  const base = { id: `${item.key}:${reason}`, kind: 'card' as const, key: item.key, summary: item.summary, reason, priority: isReason(reason) ? REASONS[reason].priority : 3, detail: null as string | null, at: item.updatedAt };
  switch (reason) {
    case 'ci_failing':
      return pr && { ...base, title: `CI failing on ${prName}`, url: pr.url, detail: pr.ciNewFailures?.length ? pr.ciNewFailures.join(', ') : null };
    case 'changes_requested':
      return pr && { ...base, title: `Changes requested on ${prName}`, url: pr.url };
    case 'ready_to_merge':
      return pr && { ...base, title: `${prName} is approved, ready to merge`, url: pr.url };
    case 'new_pr_comments':
    case 'new_jira_comments': {
      const source = reason === 'new_pr_comments' ? 'github' : 'jira';
      // newComments is newest first; the oldest unread comment is how long
      // someone has been waiting.
      const cs = item.newComments.filter(c => c.source === source);
      if (!cs.length) return null;
      const oldest = cs[cs.length - 1]!;
      // A Jira comment on a card in QA is the tester waiting on the
      // developer, the same case classify routes to needs_attention.
      const qaWaiting = source === 'jira' && sameStatus(item.jiraStatus, statuses.inTest);
      return {
        ...base,
        priority: qaWaiting ? 1 : base.priority,
        title: `${plural(cs.length, source === 'github' ? 'PR comment' : 'Jira comment')} from ${authors(cs.map(c => c.author))}${qaWaiting ? ' (QA waiting)' : ''}`,
        url: source === 'github' && pr ? pr.url : item.jiraUrl,
        detail: cs[0]!.body || null,
        at: oldest.createdAt ?? item.updatedAt,
      };
    }
    case 'merged_not_in_test':
      return { ...base, title: `PR merged, move ${item.key} to ${primaryStatus(statuses.inTest)}`, url: item.jiraUrl };
    case 'missing_qa_instructions':
      return { ...base, title: `Add QA instructions to ${item.key}`, url: item.jiraUrl };
    case 'missing_fix_version':
      return { ...base, title: `Set a fix version on ${item.key}`, url: item.jiraUrl };
    default:
      return null;
  }
}

// A state reason (REASONS.stateful) has no timestamp of its own; entry()
// stands in the card's (or card-less PR's) updatedAt, which moves on every
// unrelated edit. seen is State.queueSeen: when this entry id first appeared
// in the queue, stamped by buildSnapshot. Comment reasons keep their oldest
// unread comment and review requests their requestedAt, both real times.
const firstSeen = (e: QueueEntry, seen: Record<string, string> | undefined): QueueEntry => {
  const at = isReason(e.reason) && REASONS[e.reason].stateful ? seen?.[e.id] : undefined;
  return at ? { ...e, at } : e;
};

// Highest priority first; within a priority, whoever has waited longest
// first (entries with no timestamp last).
export function buildQueue(buckets: Record<Bucket, Item[]>, statuses: JiraStatuses, reviewRequests: ReviewRequest[] = [], unlinkedPrs: UnlinkedPr[] = [], seen?: Record<string, string>): QueueEntry[] {
  const out: QueueEntry[] = [];
  // The user's PRs with no card: the same PR reasons a card's PR produces,
  // rendered through the same entry() as an item keyed by the PR ref.
  for (const u of unlinkedPrs) {
    if (!u.pr) continue;
    const key = `${u.repo}#${u.number}`;
    const asItem: Item = {
      key, summary: u.title, jiraStatus: '', jiraUrl: u.url, bucket: 'in_progress', attention: u.attention ?? [],
      newComments: u.newComments ?? [], comments: [], pr: u.pr, createdAt: null, updatedAt: u.updatedAt ?? null,
      daysSinceActivity: null, pinned: false, pinnedAt: null,
    };
    for (const reason of asItem.attention) {
      const e = entry(asItem, reason, statuses);
      if (e) out.push(firstSeen({ ...e, kind: 'pr', summary: `${key} ${u.title}` }, seen));
    }
  }
  // Someone else's PR waiting on your review: no card, keyed by the PR ref.
  for (const rr of reviewRequests) {
    if (rr.dismissed) continue;
    out.push({
      id: `${rr.id}:review_requested`, kind: 'pr', key: rr.id, summary: rr.title, reason: 'review_requested',
      priority: REASONS.review_requested.priority, title: `Review requested: ${rr.id} ${rr.title}${rr.author ? ` (${rr.author})` : ''}`,
      detail: null, url: rr.url, at: rr.requestedAt ?? rr.updatedAt,
    });
  }
  for (const items of Object.values(buckets)) {
    for (const item of items) {
      for (const reason of item.attention) {
        const e = entry(item, reason, statuses);
        if (e) out.push(firstSeen(e, seen));
      }
    }
  }
  // QUEUE_REASONS order breaks ties, so red CI lists before the review on
  // the same PR.
  return out.sort((a, b) =>
    a.priority - b.priority
    || (a.at && b.at ? a.at.localeCompare(b.at) : a.at ? -1 : b.at ? 1 : 0)
    || QUEUE_REASONS.indexOf(a.reason) - QUEUE_REASONS.indexOf(b.reason)
    || a.key.localeCompare(b.key));
}

export const rebuildQueue = (snap: Snapshot, statuses: JiraStatuses, seen: Record<string, string> | undefined): void => {
  snap.queue = buildQueue(snap.buckets, statuses, snap.reviewRequests, snap.unlinkedPrs, seen);
};

// Whether an item's remaining attention still earns needs_attention, using
// the same two rules as classifyCard: a routing reason, or a Jira comment on
// an In Test card.
export const routesToAttention = (item: Item, statuses: JiraStatuses | undefined): boolean =>
  item.attention.some(r => ROUTING_REASONS.includes(r))
  || (item.attention.includes('new_jira_comments') && sameStatus(item.jiraStatus, statuses?.inTest));
