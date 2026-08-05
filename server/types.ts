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
  // Status name that means the work was abandoned (Jira puts it in the Done
  // category, but it is not a completion). Cards in this status are excluded
  // from the whole dashboard. Optional so existing { todo, inTest, done }
  // config/test fixtures keep working; defaults to 'Canceled' in loadConfig.
  canceled?: string;
}

// Jira status categories: every status rolls up to one of these three. Used
// for To Do / Done routing that must not depend on an exact status name
// ('Assigned' is To Do, 'Canceled' is Done, etc.).
export type StatusCategory = 'new' | 'indeterminate' | 'done' | '';

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
  // Comment authors (case-insensitive substring match) whose comments never
  // trigger Needs Attention triage and never enter the actionable New
  // Comments queue — e.g. the user themselves ('John') and the Rovo agent.
  // They remain visible in the full activity history. Defaults in loadConfig.
  ignoreAuthors?: string[];
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
  // Jira status category key ('new' | 'indeterminate' | 'done'). Optional so
  // existing fixtures without it fall back to exact status-name matching.
  statusCategory?: StatusCategory;
  // Jira Fix Version names (a card can target more than one release). Empty
  // array means no Fix Version is set, which the detail view flags explicitly.
  fixVersions?: string[];
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
  fixVersions?: string[];
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

// A card Jira has marked complete (Done category, excluding Canceled). Drives
// the Done page. Carries the linked PR (if any) purely as supporting context.
export interface DoneCard {
  key: string;
  summary: string;
  jiraStatus: string;
  jiraUrl: string;
  pr: PrRef | null;
  doneAt: string | null;
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
  // Completion is driven by the Jira Done category (a merged PR only means code
  // is ready for QA). A merged PR rides along on its active card's `pr` as
  // supporting context; merged/closed PRs in the last 7 days show in
  // recentActivity. There is no Merged/Closed page or counter.
  doneCards: DoneCard[];
  doneTotal: number;
  newlyDone: string[];
  recentActivity: ActivityEntry[];
  prLog: PrLogEntry[];
}

// --- Local state (data/state.json) ---

export interface CardState {
  lastSeenPr: string | null;
  lastSeenJira: string | null;
  override: Bucket | null;
  overrideAt: string | null;
  // State-based attention reasons (STATE_REASONS in classify.ts) the user
  // acknowledged; classifyCard mutes and prunes these — see the comment
  // there. Optional: absent in pre-existing state files.
  ackedReasons?: string[] | null;
}

export interface CelebratedEntry {
  id: string;
  at: string | null;
}

export interface State {
  cards: Record<string, CardState>;
  // Legacy: PR-merge celebration ids from older state files. No longer written;
  // retained only so migratePrLog can backfill prLog history for pre-prLog
  // state files on load.
  celebrated: CelebratedEntry[];
  // Cards celebrated as complete, keyed by Jira card key, and the running
  // all-time total shown by the Done counter.
  doneCelebrated: CelebratedEntry[];
  doneTotal: number;
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
