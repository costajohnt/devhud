// Payload types come straight from the server (type-only import, erased at
// build time; server/types.ts has no imports and no runtime code). The web
// used to keep a hand-copied mirror that had already drifted (audit M17:
// unlinkedPrs lacked the queue fields). Only UI constants live here.
import type {
  Bucket, PrRef, NewComment, Item, QueueEntry, PrLogEntry, Snapshot, TodoItem, FiledCard,
  ReviewRequest, UnlinkedPr, DoneCard, ActivityEntry,
} from '../../server/types.ts';

export type { Bucket, PrRef, NewComment, Item, QueueEntry, PrLogEntry, TodoItem, FiledCard, ReviewRequest, UnlinkedPr, DoneCard, ActivityEntry };
export type DashboardData = Snapshot;

export const BUCKET_ORDER: Bucket[] = ['needs_attention', 'in_progress', 'self_review', 'waiting_review', 'mergeable', 'qa_ready', 'in_qa'];
export const BUCKET_LABEL: Record<Bucket, string> = {
  needs_attention: 'Needs Attention', in_progress: 'In Progress',
  self_review: 'Self Review Needed', waiting_review: 'Waiting in Review',
  mergeable: 'Mergeable', qa_ready: 'QA Ready', in_qa: 'In QA',
};
