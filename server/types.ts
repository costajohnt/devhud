// Shared types for server/ and mcp/. Mirrors web/src/types.ts's payload
// shapes (Bucket, Item, DashboardData and friends) so the two sides agree,
// but is defined independently rather than imported across packages: web/
// is a separate Vite/tsc project with its own tsconfig (DOM lib, JSX), and
// server/mcp run under plain Node with native type stripping (no build
// step), so cross-project imports would drag in an incompatible toolchain.

// --- Config ---

export interface JiraStatuses {
  todo: string;
  inTest: string;
  done: string;
}

export interface JiraConfig {
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  projectKey: string;
  accountId: string;
  statuses: JiraStatuses;
}

export interface GithubConfig {
  token: string;
  org: string;
  repos: string[];
  username: string;
}

export interface Config {
  jira: JiraConfig;
  github: GithubConfig;
  port: number;
  demo: boolean;
  writeEnabled: boolean;
}

// --- Jira cards ---

export interface JiraComment {
  author: string;
  authorId?: string;
  body: string;
  createdAt: string | null;
}

export interface Card {
  key: string;
  summary: string;
  status: string;
  description: string;
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
  myAccountId: string;
  comments: JiraComment[];
}

// --- GitHub PRs ---

export type PrState = 'open' | 'merged' | 'closed';
export type CiStatus = 'passing' | 'failing' | 'pending' | 'unknown';
export type ReviewState = 'review_required' | 'changes_requested' | 'approved' | 'none';

export interface PrComment {
  author: string;
  body: string;
  createdAt: string | null | undefined;
}

// _raw carries just enough of the raw GitHub API response through fetchPrs
// for enrichPr to finish the enrichment (check-run sha, requested
// reviewers/teams) — deleted before the Pr is used anywhere else, so it's
// optional here rather than a separate "PrWithRaw" type.
export interface Pr {
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  branch: string;
  state: PrState;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  ciStatus: CiStatus;
  reviewState: ReviewState;
  comments: PrComment[];
  _raw?: {
    head: { sha?: string };
    requested_reviewers?: unknown[];
    requested_teams?: unknown[];
  };
}

// --- Board / snapshot payload (mirrors web/src/types.ts) ---

export type Bucket = 'needs_attention' | 'in_progress' | 'waiting_review' | 'in_qa';

export interface NewComment {
  source: 'github' | 'jira';
  author: string;
  body: string;
  createdAt: string | null;
}

export interface PrRef {
  repo: string;
  number: number;
  url: string;
  branch: string;
  state: PrState;
  ciStatus: CiStatus;
  reviewState: ReviewState;
}

export interface Item {
  key: string;
  summary: string;
  jiraStatus: string;
  jiraUrl: string;
  bucket: Bucket;
  attention: string[];
  newComments: NewComment[];
  comments: NewComment[];
  pr: PrRef | null;
  createdAt: string | null;
  updatedAt: string | null;
  daysSinceActivity: number | null;
}

export interface TodoItem {
  key: string;
  summary: string;
  jiraUrl: string;
  createdAt: string | null;
}

export interface UnlinkedPr {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: string;
}

export interface ClosedPr {
  repo: string;
  number: number;
  url: string;
  title: string;
  closedAt: string;
}

export interface MergedCard {
  key: string;
  summary: string;
  jiraStatus: string;
  jiraUrl: string;
  pr: PrRef | null;
  mergedAt: string | null;
}

export interface ActivityEntry {
  type: 'merged' | 'closed' | 'comment';
  label: string;
  url: string;
  date: string;
}

export interface PrLogEntry {
  id: string;
  repo: string;
  openedAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
}

export interface Snapshot {
  updatedAt: string | null;
  errors: { jira: string | null; github: string | null };
  buckets: Record<Bucket, Item[]>;
  todo: TodoItem[];
  unlinkedPrs: UnlinkedPr[];
  mergedCards: MergedCard[];
  mergedTotal: number;
  newlyMerged: string[];
  recentActivity: ActivityEntry[];
  closedPrs: ClosedPr[];
  prLog: PrLogEntry[];
}

// --- Local state (data/state.json) ---

export interface CardState {
  lastSeenPr: string | null;
  lastSeenJira: string | null;
  override: Bucket | null;
  overrideAt: string | null;
}

export interface CelebratedEntry {
  id: string;
  at: string | null;
}

export interface State {
  cards: Record<string, CardState>;
  celebrated: CelebratedEntry[];
  mergedTotal: number;
  lastRefreshAt: string | null;
  snapshot: Snapshot | null;
  lastCards: Card[] | null;
  lastPrs: Pr[] | null;
  prLog: Record<string, PrLogEntry>;
}

// --- Action / write-back results ---

export type ActionResult =
  | { ok: true; bucket: Bucket | null }
  | { error: string; status?: number };

export interface WriteGateResult {
  blocked: boolean;
  demo?: boolean;
  message?: string;
}

export type WriteResult =
  | { ok: true; demo: true; message: string }
  | { ok: true; transitionedTo?: string; refreshError?: string; saveBlockedError?: string }
  | { error: string; status?: number };
