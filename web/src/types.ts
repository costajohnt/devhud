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
  createdAt: string; updatedAt: string; daysSinceActivity: number | null; }

export interface DashboardData {
  updatedAt: string | null;
  errors: { jira: string | null; github: string | null };
  buckets: Record<Bucket, Item[]>;
  todo: { key: string; summary: string; jiraUrl: string; createdAt: string }[];
  unlinkedPrs: { repo: string; number: number; url: string; title: string; state: string }[];
  mergedCards: { key: string; summary: string; jiraUrl: string; pr: PrRef; mergedAt: string }[];
  mergedTotal: number;
  newlyMerged: string[];
  recentActivity: { type: string; label: string; url: string; date: string }[];
  mergedLog: { id: string; at: string | null }[];
}
