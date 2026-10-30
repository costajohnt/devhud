export type Bucket = 'needs_attention' | 'in_progress' | 'self_review' | 'waiting_review' | 'mergeable' | 'qa_ready' | 'in_qa';
export const BUCKET_ORDER: Bucket[] = ['needs_attention', 'in_progress', 'self_review', 'waiting_review', 'mergeable', 'qa_ready', 'in_qa'];
export const BUCKET_LABEL: Record<Bucket, string> = {
  needs_attention: 'Needs Attention', in_progress: 'In Progress',
  self_review: 'Self Review Needed', waiting_review: 'Waiting in Review',
  mergeable: 'Mergeable', qa_ready: 'QA Ready', in_qa: 'In QA',
};

export interface PrRef { repo: string; number: number; url: string; branch: string;
  state: 'open' | 'merged' | 'closed'; ciStatus: 'passing' | 'failing' | 'pending' | 'unknown';
  // Failed checks not also failing on the base branch; [] = all pre-existing.
  ciNewFailures?: string[];
  // Base branch CI still running, so ciNewFailures may be unknown (#86).
  ciBasePending?: boolean;
  reviewState: 'review_required' | 'changes_requested' | 'approved' | 'none'; isDraft?: boolean; }

// createdAt is nullable to match the server: classify.ts's githubNewComment
// falls back to null when GitHub omits the timestamp, and jira.ts's iso()
// yields null for an unparseable one. Typing it as plain string here was a
// drift that hid the null case from every consumer (`ago()` already handles
// it; the render keys quietly stringified it).
export interface NewComment { source: 'github' | 'jira'; author: string; body: string; createdAt: string | null; }

export interface Item { key: string; summary: string; jiraStatus: string; jiraUrl: string; fixVersions?: string[];
  bucket: Bucket; attention: string[]; newComments: NewComment[]; comments: NewComment[]; pr: PrRef | null;
  // Nullable to match the server (jira.ts's iso() yields null for a missing
  // field); typing these as plain string hid an "Invalid Date" render.
  createdAt: string | null; updatedAt: string | null; daysSinceActivity: number | null;
  // A manual pin holds this card in its bucket until unpinned (or until it
  // reaches In Test/Done, which auto-clears). pinnedAt is when it was set.
  pinned: boolean; pinnedAt: string | null; }

// One TODO queue entry (mirrors server/types.ts QueueEntry).
export interface QueueEntry { id: string; key: string; summary: string; reason: string;
  priority: 1 | 2 | 3; title: string; detail: string | null; url: string; at: string | null; }

export interface PrLogEntry { id: string; repo: string; openedAt: string | null; mergedAt: string | null; closedAt: string | null; }

export interface DashboardData {
  updatedAt: string | null;
  errors: { jira: string | null; github: string | null };
  buckets: Record<Bucket, Item[]>;
  // Ranked TODO queue, highest priority and longest waiting first. The
  // server migrates an old snapshot that lacks it, so it is always present.
  queue: QueueEntry[];
  // createdAt/doneAt are nullable to match server/types.ts (TodoItem,
  // DoneCard): jira.ts's iso() yields null for an unparseable timestamp.
  todo: TodoItem[];
  blocked: TodoItem[];
  unlinkedPrs: { repo: string; number: number; url: string; title: string; state: string }[];
  doneCards: { key: string; summary: string; jiraStatus: string; jiraUrl: string; pr: PrRef | null; doneAt: string | null }[];
  doneTotal: number;
  newlyDone: string[];
  recentActivity: { type: 'merged' | 'closed' | 'comment'; label: string; url: string; date: string }[];
  prLog: PrLogEntry[];
  // Cards this user reported, newest first (server migrates an old snapshot
  // that lacks it, so it is always present).
  filed: FiledCard[];
}

export interface TodoItem { key: string; summary: string; jiraUrl: string; createdAt: string | null }

export interface FiledCard { key: string; summary: string; jiraStatus: string; jiraUrl: string; createdAt: string | null }
