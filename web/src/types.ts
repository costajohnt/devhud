export type Bucket = 'needs_attention' | 'in_progress' | 'waiting_review' | 'in_qa';
export const BUCKET_ORDER: Bucket[] = ['needs_attention', 'in_progress', 'waiting_review', 'in_qa'];
export const BUCKET_LABEL: Record<Bucket, string> = {
  needs_attention: 'Needs Attention', in_progress: 'In Progress',
  waiting_review: 'Waiting in Review', in_qa: 'In QA',
};

export interface PrRef { repo: string; number: number; url: string; branch: string;
  state: 'open' | 'merged' | 'closed'; ciStatus: 'passing' | 'failing' | 'pending' | 'unknown';
  reviewState: 'review_required' | 'changes_requested' | 'approved' | 'none'; }

export interface NewComment { source: 'github' | 'jira'; author: string; body: string; createdAt: string; }

export interface Item { key: string; summary: string; jiraStatus: string; jiraUrl: string;
  bucket: Bucket; attention: string[]; newComments: NewComment[]; comments: NewComment[]; pr: PrRef | null;
  // Nullable to match the server (jira.ts's iso() yields null for a missing
  // field); typing these as plain string hid an "Invalid Date" render.
  createdAt: string | null; updatedAt: string | null; daysSinceActivity: number | null; }

export interface PrLogEntry { id: string; repo: string; openedAt: string | null; mergedAt: string | null; closedAt: string | null; }

export interface DashboardData {
  updatedAt: string | null;
  errors: { jira: string | null; github: string | null };
  buckets: Record<Bucket, Item[]>;
  todo: { key: string; summary: string; jiraUrl: string; createdAt: string }[];
  unlinkedPrs: { repo: string; number: number; url: string; title: string; state: string }[];
  mergedCards: { key: string; summary: string; jiraUrl: string; pr: PrRef; mergedAt: string }[];
  mergedTotal: number;
  newlyMerged: string[];
  recentActivity: { type: 'merged' | 'closed' | 'comment'; label: string; url: string; date: string }[];
  closedPrs: { repo: string; number: number; url: string; title: string; closedAt: string }[];
  prLog: PrLogEntry[];
}
