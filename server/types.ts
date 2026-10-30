// Shared types for server/ and mcp/. Mirrors web/src/types.ts's payload
// shapes (Bucket, Item, DashboardData and friends) so the two sides agree,
// but is defined independently rather than imported across packages: web/
// is a separate Vite/tsc project with its own tsconfig (DOM lib, JSX), and
// server/mcp run under plain Node with native type stripping (no build
// step), so cross-project imports would drag in an incompatible toolchain.

// --- Config ---

// One status name, or several that mean the same thing to the board (e.g.
// ["Code Review", "PR Review"]). Every comparison goes through sameStatus,
// which accepts either form.
export type StatusNames = string | string[];

export interface JiraStatuses {
  todo: StatusNames;
  // When a list, the first entry is the transition target for
  // autoTransitionMerged.
  inTest: StatusNames;
  done: StatusNames;
  // Status name that means the work was abandoned (Jira puts it in the Done
  // category, but it is not a completion). Cards in this status are excluded
  // from the whole dashboard. Optional so existing { todo, inTest, done }
  // config/test fixtures keep working; defaults to 'Canceled' in loadConfig.
  canceled?: StatusNames;
  // Status name that means the work is out for review. Optional: the two
  // common Jira defaults ('Code Review', 'In Review') are always recognised,
  // so this only needs setting for a project that renamed it (#64).
  review?: StatusNames;
  // Status name that means the work is parked waiting on something outside
  // the developer. Optional so existing { todo, inTest, done } config/test
  // fixtures keep working; defaults to 'Blocked' in loadConfig.
  blocked?: StatusNames;
  // Status name for active development. Together with review it forms the
  // "pre-test" allowlist: the only statuses merged_not_in_test may flag and
  // auto-transition may move from (see isPreTest in classify.ts). Optional;
  // defaults to 'In Progress'.
  inProgress?: StatusNames;
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

// One GitHub credential set, covering a specific list of fully-qualified repos
// (owner/repo). Used when a developer has separate work and personal accounts.
// loadConfig resolves tokenEnv to a token at startup; github.ts never reads the
// env var itself.
export interface GithubIdentity {
  username: string;
  token: string; // resolved from tokenEnv at load time
  // Repos owned by this identity ("name" qualifies with github.org, or
  // "owner/name"). Empty marks the catch-all: it owns every configured repo
  // no other identity lists. With no catch-all, every repo must be listed
  // under exactly one identity. See resolveIdentity in github.ts.
  repos: string[];
}

export interface GithubConfig {
  token: string;
  org: string;
  repos: string[];
  username: string;
  // Multi-identity support (#108). loadConfig always populates both fields,
  // even for single-identity configs (normalised to a one-element array).
  // Test fixtures that construct GithubConfig directly may omit them; the
  // fallback in github.ts keeps single-identity behaviour in that case.
  identities?: GithubIdentity[];
  // All usernames across all identities, for the "self" check in classify.ts.
  usernames?: string[];
}

export interface Config {
  jira: JiraConfig;
  github: GithubConfig;
  port: number;
  demo: boolean;
  writeEnabled: boolean;
  // MCP write tools also need this (audit M4). Optional: defaults false.
  mcpWriteEnabled?: boolean;
  // Optional so test fixtures and older config.json files need no change;
  // the server applies DEFAULT_REFRESH_INTERVAL_SECONDS when absent.
  refreshIntervalSeconds?: number;
  // Comment authors (case-insensitive substring match) whose comments never
  // trigger Needs Attention triage and never enter the actionable New
  // Comments queue — e.g. the user themselves ('John') and the Rovo agent.
  // They remain visible in the full activity history. Defaults in loadConfig.
  ignoreAuthors?: string[];
  // When true, cards flagged merged_not_in_test (PR merged, card not yet In
  // Test or Done) are automatically transitioned to the In Test status after
  // each tick. Off by default so no existing deployment changes behavior.
  // Acked cards are never auto-transitioned; per-card errors are logged and
  // the batch continues. Requires writeEnabled: true. Skipped entirely on a
  // degraded refresh, only moves pre-test statuses (isPreTest), and fires at
  // most once per (card, merged PR) — see autoTransitionMergedCards.
  autoTransitionMerged?: boolean;
}

// --- Jira cards ---

export interface JiraComment {
  // Jira comment id. Optional: fixtures and pre-existing lastCards lack it.
  // Used to recognise comments the dashboard posted itself (State.postedCommentIds).
  id?: string;
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
  // Jira accountId of the card's assignee. Optional: fixtures and demo cards
  // omit it, and callers treat undefined as "unknown", not "not mine".
  assigneeId?: string;
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
  closedAt: string | null;
  ciStatus: CiStatus;
  // Only set while ciStatus is 'failing': the failed checks that are not also
  // failing on the base branch. [] = all pre-existing, so not this PR's fault
  // and not a Needs Attention reason; undefined = unknown, keep flagging (#79)
  // unless ciBasePending says why it is unknown.
  ciNewFailures?: string[];
  // Set while ciStatus is 'failing' and the base branch's CI is still running,
  // so ciNewFailures could not be computed this refresh. refresh() carries the
  // previous verdict over; with none to carry, classify does not flag (#86).
  ciBasePending?: boolean;
  reviewState: ReviewState;
  isDraft?: boolean;
  comments: PrComment[];
  // Set once enrichPr has filled comments/reviewState. refresh() reuses a
  // last-known PR's enrichment when its updatedAt is unchanged, and an
  // enriched PR with no comments is otherwise indistinguishable from one
  // that was never linked (#72).
  enriched?: boolean;
  // When enrichPr last ran for this PR. refresh() treats an enrichment
  // recorded within a couple of seconds of the updatedAt it saw as
  // unconfirmed and re-enriches it once, because GitHub's timestamps are
  // whole seconds and a comment landing in the same second leaves updatedAt
  // equal while the comment list is stale (#75).
  enrichedAt?: string;
  // Set by refresh() once an enrichment has been re-checked (or was never in
  // doubt) for this updatedAt. It is what makes the re-check one-shot: the
  // time comparison alone re-fires on every poll when this host's clock runs
  // behind GitHub's, and only a moved updatedAt clears the flag, because a
  // fresh enrichPr result never carries it.
  enrichConfirmed?: boolean;
}

// --- Board / snapshot payload (mirrors web/src/types.ts) ---

export type Bucket = 'needs_attention' | 'in_progress' | 'self_review' | 'waiting_review' | 'mergeable' | 'qa_ready' | 'in_qa';

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
  // Only set while ciStatus is 'failing': the failed checks that are not also
  // failing on the base branch. [] = all pre-existing, so not this PR's fault
  // and not a Needs Attention reason; undefined = unknown, keep flagging (#79)
  // unless ciBasePending is set (base CI still running, #86).
  ciNewFailures?: string[];
  ciBasePending?: boolean;
  reviewState: ReviewState;
  isDraft?: boolean;
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
  // Whether a manual pin (CardState.override) is currently holding this card
  // in its bucket, and when it was set. The client needs `pinned` to know
  // whether to offer Unpin at all; `pinnedAt` is the first reader `overrideAt`
  // has ever had — it was stamped on every move and read by nothing.
  pinned: boolean;
  pinnedAt: string | null;
}

// Someone else's open PR waiting on this user's review. id is the PR ref
// "owner/repo#n", which is also the key a dismissal (ack) uses.
export interface ReviewRequest {
  id: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  // When the review was requested (latest request event), else null.
  requestedAt: string | null;
  updatedAt: string;
  // Dismissed from the queue until the PR changes again (State.prs).
  dismissed: boolean;
}

// One entry in the TODO queue (server/queue.ts): a single pending thing on
// one card, e.g. CI failing or unread PR comments. id is `${key}:${reason}`.
export interface QueueEntry {
  id: string;
  // 'card': key is a Jira key on the board. 'pr': key is a PR ref
  // ("owner/repo#n") with no card, e.g. a review request.
  kind: 'card' | 'pr';
  key: string;
  summary: string;
  reason: string;
  // 1 = blocking someone or broken, 2 = waiting on a reply, 3 = housekeeping.
  priority: 1 | 2 | 3;
  title: string;
  // Extra context: the failing checks, or the newest unread comment.
  detail: string | null;
  // Where to go to address it (the PR or the Jira card).
  url: string;
  // How long it has been waiting: the oldest unread comment, else the card's
  // last update.
  at: string | null;
}

export interface TodoItem {
  key: string;
  summary: string;
  jiraUrl: string;
  createdAt: string | null;
}

// One of the user's open PRs that no card links to. It still feeds the
// TODO queue (kind 'pr', key "owner/repo#n") from its own PR reasons.
export interface UnlinkedPr {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: string;
  // Optional: absent in snapshots persisted before the queue covered them.
  attention?: string[];
  newComments?: NewComment[];
  pr?: PrRef;
  updatedAt?: string | null;
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

// A card this user reported (Jira reporter), any project, any status. Drives
// the Filed page and its stat card; never enters the board buckets.
export interface FiledCard {
  key: string;
  summary: string;
  jiraStatus: string;
  jiraUrl: string;
  createdAt: string | null;
  // Feeds the next fetch's watermark (jira.ts fetchFiledCards). Optional:
  // snapshots persisted before #81 lack it, which just forces one full fetch.
  updatedAt?: string | null;
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
  // When this snapshot's data was read: taken before the first fetch, and
  // never later than an earlier read a source fell back to. It is the "seen"
  // horizon for acks, so a comment that lands while a refresh is running is
  // still new afterwards. updatedAt (build completion) is for display only.
  // Optional: absent in snapshots persisted before it existed.
  dataAsOf?: string | null;
  errors: { jira: string | null; github: string | null };
  buckets: Record<Bucket, Item[]>;
  // Ranked TODO queue derived from buckets (server/queue.ts). Absent in
  // snapshots persisted before it existed; migrateSnapshot backfills [].
  queue: QueueEntry[];
  // Open PRs requesting this user's review. Absent in older snapshots;
  // migrateSnapshot backfills [].
  reviewRequests: ReviewRequest[];
  todo: TodoItem[];
  // Jira "Blocked" cards, split out of the board the same way as todo.
  // Not a Bucket: the classifier never sees them, and they are not a
  // drag-and-drop destination.
  blocked: TodoItem[];
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
  // Cards this user reported, newest first. Absent in snapshots persisted
  // before the field existed; migrateSnapshot in state.ts backfills it.
  filed: FiledCard[];
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
  // Jira status as of the last refresh. classifyCard compares against it to
  // spot a status transition and release a stale pin (#53). Optional: absent
  // in pre-existing state files.
  lastStatus?: string | null;
  // Last refresh at which the card was seen In Test or in Done (ISO time).
  // merged_not_in_test is suppressed when this is at or after the PR's
  // mergedAt: the card already went through QA for that merge, so being back
  // in In Progress means QA rejected it, not that it was never moved (H1).
  // Optional: absent in pre-existing state files.
  reachedTestAt?: string | null;
}

// One auto-transition attempt, keyed in State.autoTransitioned by
// `${cardKey}@${repo}#${number}` so a given merged PR fires at most once per
// card, success or failure (failures are not retried). `skipped` marks an
// attempt abandoned before any POST because the live Jira status no longer
// matched the snapshot (ok is false; error reads "status changed: X -> Y").
export interface AutoTransitionRecord {
  at: string;
  ok: boolean;
  error?: string;
  skipped?: boolean;
}

export interface CelebratedEntry {
  id: string;
  at: string | null;
}

export interface FiledMeta {
  fullFetchAt: string;
  accountId: string;
  baseUrl: string | null;
}

export interface State {
  cards: Record<string, CardState>;
  // Legacy: PR-merge celebration ids from older state files. No longer written;
  // retained only so migratePrLog can backfill prLog history for pre-prLog
  // state files on load.
  celebrated: CelebratedEntry[];
  // Cards celebrated as complete, keyed by Jira card key, so the completion
  // confetti fires once per card. The Done counter is not derived from this —
  // it's the length of the current Done list (see buildSnapshot).
  doneCelebrated: CelebratedEntry[];
  // Lifetime ledger of completed cards, newest first, deduped by key. This is
  // the Done page and the Done counter: Done cards are fetched incrementally
  // against a watermark (jira.ts doneWatermark) rather than re-listed every
  // refresh, so the count is all-time and does not shrink as cards age out of
  // a fetch window. Optional: absent in pre-existing state files, which seed
  // it on the next refresh.
  doneLedger?: DoneCard[];
  // Provenance of snapshot.filed (refresh.ts filedFetchPlan): when the last
  // full reporter fetch ran and for which Jira account and site. The list is
  // otherwise fetched incrementally, which can never drop a deleted, moved or
  // re-reported card, so a stale stamp or a changed account/site forces a
  // full refetch. Optional: absent in older state files (forces one).
  filedMeta?: FiledMeta;
  lastRefreshAt: string | null;
  snapshot: Snapshot | null;
  lastCards: Card[] | null;
  lastPrs: Pr[] | null;
  prLog: Record<string, PrLogEntry>;
  // Auto-transition ledger (see AutoTransitionRecord). Optional: absent in
  // pre-existing state files; loadState defaults it to {}.
  autoTransitioned?: Record<string, AutoTransitionRecord>;
  // Ids of Jira comments posted through write-back (performWrite), newest
  // last, capped at POSTED_COMMENT_IDS_MAX. classify excludes them from the
  // own-reply watermark so an automated post does not read as the user
  // answering a question (L3). Optional; loadState defaults it to [].
  postedCommentIds?: string[];
  // Per-PR local state for PRs with no card, keyed by "owner/repo#n".
  // dismissedAt: the PR's updatedAt when its review request was dismissed;
  // the entry comes back once the PR changes. Optional; pruned to the PRs
  // still requesting review on each successful fetch.
  prs?: Record<string, { dismissedAt: string | null }>;
  // Seen-comment horizon and acked reasons for the user's own card-less
  // PRs, keyed by "owner/repo#n" (the card equivalent is CardState). Pruned
  // to the open card-less PRs on each refresh that fetched their repo.
  ownPrs?: Record<string, { lastSeenPr: string | null; ackedReasons?: string[] | null }>;
}

// --- Action / write-back results ---

export type ActionResult =
  // wasPinned is unpin-only: it distinguishes "released a pin" from "there
  // was nothing pinned", so callers can report the no-op honestly instead of
  // claiming an unpin that didn't change anything.
  | { ok: true; bucket: Bucket | null; wasPinned?: boolean }
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
