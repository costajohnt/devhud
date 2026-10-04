import type { Pr, PrComment, GithubConfig, CiStatus, ReviewState } from './types.ts';

// Minimal shapes for the slices of the GitHub responses this file actually
// reads — not full API types, just what's used below. PR discovery is one
// GraphQL search per repo (#72); comments and reviews still come from REST.
interface GqlPr {
  number: number;
  url: string;
  title?: string | null;
  body?: string | null;
  headRefName?: string | null;
  state: string; // OPEN | CLOSED | MERGED
  isDraft?: boolean | null;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  labels?: { nodes?: ({ name?: string | null } | null)[] | null } | null;
  reviewRequests?: { totalCount?: number | null } | null;
  commits?: { nodes?: ({ commit?: { statusCheckRollup?: GqlRollup | null } | null } | null)[] | null } | null;
  // Tip of the base branch; null once that branch is deleted.
  baseRef?: { target?: { statusCheckRollup?: GqlRollup | null } | null } | null;
}

// A check run reports name + conclusion, a legacy commit status reports
// context + state; both live in the same rollup.
interface GqlCheck { name?: string | null; conclusion?: string | null; context?: string | null; state?: string | null }
interface GqlRollup { state?: string | null; contexts?: { nodes?: (GqlCheck | null)[] | null } | null }

interface RawReview {
  state: string;
  user?: { login?: string };
  submitted_at?: string;
  body?: string;
}

interface RawComment {
  user?: { login?: string };
  body?: string;
  created_at?: string;
  submitted_at?: string;
}

// The head commit's combined status as GitHub itself rolls it up (check runs
// and commit statuses, latest attempt per check). Replaces the per-PR
// check-runs fetch: the rollup rides along on the discovery query, so CI
// changes cost no extra request (#72).
export function ciFromRollup(state: string | null | undefined): CiStatus {
  switch (state) {
    case 'SUCCESS': return 'passing';
    case 'FAILURE':
    case 'ERROR': return 'failing';
    case 'PENDING':
    case 'EXPECTED': return 'pending';
    default: return 'unknown';
  }
}

const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE'];

// Names of the failed checks in a rollup; undefined when the rollup (or its
// contexts) did not come back, which is not the same as "nothing failed".
function failedChecks(rollup: GqlRollup | null | undefined): string[] | undefined {
  const nodes = rollup?.contexts?.nodes;
  if (!nodes) return undefined;
  return nodes.flatMap(c => {
    const name = c?.name ?? c?.context;
    return name && FAILED.includes(c?.conclusion ?? c?.state ?? '') ? [name] : [];
  });
}

// Returns true if the rollup contains any check that has not yet produced a
// verdict: a CheckRun whose conclusion is null (running/queued/waiting), or a
// commit status still in the pending state. An incomplete rollup cannot be
// treated as "green" because zero failures just means "not done yet".
function rollupHasPending(rollup: GqlRollup | null | undefined): boolean {
  const nodes = rollup?.contexts?.nodes;
  if (!nodes) return false;
  return nodes.some(c => {
    if (!c) return false;
    // CheckRun: conclusion is null while the run is in progress or queued.
    if (c.name != null && c.conclusion == null) return true;
    // StatusContext: pending state.
    if (c.context != null && (c.state === 'pending' || c.state === 'PENDING')) return true;
    return false;
  });
}

// What the base branch says about the PR's failed checks (#79, #86).
// newFailures: the PR's failed checks minus the ones already failing on its
// base branch; [] means every failure is pre-existing, so the PR did not
// break CI. undefined means "cannot tell". basePending separates the two
// kinds of "cannot tell":
// - basePending: the base rollup is still running, so its verdict is not in
//   yet. Callers must not flag on this (#86): refresh carries the previous
//   verdict over, and classify suppresses when there is none.
// - otherwise: base data is missing (branch deleted, contexts not returned)
//   or a failing head check never ran on a finished base. Callers keep
//   flagging, as before #89.
// ponytail: compares against the base branch tip, not the merge-base commit;
// fetch the merge-base's checks if a since-fixed base keeps hiding nothing.
export function ciBaseVerdict(head: GqlRollup | null | undefined, base: GqlRollup | null | undefined): { newFailures?: string[]; basePending: boolean } {
  const headFailed = failedChecks(head);
  const baseFailed = failedChecks(base);
  if (!headFailed?.length || !baseFailed) return { basePending: false };

  // Base is still running: rollup is incomplete, so zero base failures does
  // not mean the base is green. Suppress rather than assert (#86). The
  // rollup's own state counts too: a check queued on base may not have a
  // context node yet.
  if (rollupHasPending(base) || ciFromRollup(base?.state) === 'pending') return { basePending: true };

  // If a failing head check is absent from a finished base rollup, there is
  // no base verdict for it to compare against: unknown, keep flagging.
  const baseNodes = base?.contexts?.nodes;
  const baseNames = new Set(
    (baseNodes ?? []).flatMap(c => {
      const n = c?.name ?? c?.context;
      return n ? [n] : [];
    })
  );
  if (headFailed.some(n => !baseNames.has(n))) return { basePending: false };

  return { newFailures: headFailed.filter(n => !baseFailed.includes(n)), basePending: false };
}

export function newCiFailures(head: GqlRollup | null | undefined, base: GqlRollup | null | undefined): string[] | undefined {
  return ciBaseVerdict(head, base).newFailures;
}

export function mapPr(node: GqlPr, repo: string): Pr {
  const hasDraftLabel = (node.labels?.nodes ?? []).some(l => l?.name?.toLowerCase() === 'draft');
  const state: Pr['state'] = node.state === 'MERGED' ? 'merged' : node.state === 'OPEN' ? 'open' : 'closed';
  const headRollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const rollup = headRollup?.state;
  const ciStatus = state === 'open' ? ciFromRollup(rollup) : 'unknown';
  const verdict = ciStatus === 'failing' ? ciBaseVerdict(headRollup, node.baseRef?.target?.statusCheckRollup) : null;
  return {
    repo,
    number: node.number,
    url: node.url,
    title: node.title ?? '',
    body: node.body ?? '',
    branch: node.headRefName ?? '',
    state,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    mergedAt: node.mergedAt ?? null,
    closedAt: node.closedAt ?? null,
    // A closed PR's checks are history, not status: keep the pre-#72 'unknown'.
    ciStatus,
    ...(verdict ? { ciNewFailures: verdict.newFailures } : {}),
    ...(verdict?.basePending ? { ciBasePending: true } : {}),
    // Pending review requests are visible at discovery; approvals and change
    // requests need the reviews list, which enrichPr fetches for linked PRs.
    reviewState: (node.reviewRequests?.totalCount ?? 0) > 0 ? 'review_required' : 'none',
    isDraft: (node.isDraft ?? false) || hasDraftLabel,
    comments: [],
  };
}

export function reviewStateFrom(reviewRequested: boolean, reviews: RawReview[] | undefined): ReviewState {
  if (reviewRequested) return 'review_required';
  // latest review per reviewer wins
  const latest = new Map<string | undefined, RawReview>();
  for (const r of reviews ?? []) {
    if (!['APPROVED', 'CHANGES_REQUESTED'].includes(r.state)) continue;
    const prev = latest.get(r.user?.login);
    if (!prev || (r.submitted_at ?? '') > (prev.submitted_at ?? '')) latest.set(r.user?.login, r);
  }
  const states = [...latest.values()].map(r => r.state);
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  return 'none';
}

// Per-refresh request instrumentation (#72): refresh() resets this at entry
// and logs it at exit, so a change in request volume is visible in the server
// log rather than inferred from a throttle banner. Refreshes are serialized
// (refresh.ts), so one process-wide counter is one refresh's counter.
export type GithubRequestFamily = 'graphql' | 'issue_comments' | 'review_comments' | 'reviews';
export interface GithubRequestStats {
  requests: number;
  byFamily: Partial<Record<GithubRequestFamily, number>>;
  notModified: number;
  retries: number;
  // Last x-ratelimit-remaining seen on each API; REST and GraphQL have
  // separate budgets. null until a response carried the header.
  rateLimitRemaining: { rest: number | null; graphql: number | null };
}
const freshStats = (): GithubRequestStats =>
  ({ requests: 0, byFamily: {}, notModified: 0, retries: 0, rateLimitRemaining: { rest: null, graphql: null } });
let stats = freshStats();
// refresh() calls this at entry, so it also opens a fresh throttle wait budget
// for the sweep (see THROTTLE_BUDGET_MS).
export function resetGithubStats(): void { stats = freshStats(); throttleBudgetMs = THROTTLE_BUDGET_MS; }
export function githubStats(): GithubRequestStats {
  return { ...stats, byFamily: { ...stats.byFamily }, rateLimitRemaining: { ...stats.rateLimitRemaining } };
}
export function formatGithubStats(s: GithubRequestStats = githubStats()): string {
  const families = Object.entries(s.byFamily).map(([k, v]) => `${k} ${v}`).join(', ');
  const remaining = [s.rateLimitRemaining.rest, s.rateLimitRemaining.graphql]
    .map(n => n ?? '?').join('/');
  return `${s.requests} requests (${families || 'none'}), ${s.notModified} not-modified, ${s.retries} retries, remaining rest/graphql ${remaining}`;
}

// Conditional-request cache: GitHub 304s don't count against the rate
// limit, and between refresh ticks most responses are byte-identical — with
// the server polling every couple of minutes this turns almost the whole
// sweep free. Keyed by path (token never varies within a process). Keys are
// comments/reviews per PR, so the cache grows with the number of PRs ever
// linked; a long-lived server needs the size cap below.
// ponytail: bulk-drop at the cap (one re-paid sweep), LRU if it ever matters.
const ETAG_CACHE_MAX = 500;
const etagCache = new Map<string, { etag: string; body: unknown; link: string | null }>();

// GitHub's *secondary* rate limit is rate-shaped, not quota-shaped: it fires on
// bursts and on many requests against one endpoint family in a short window, and
// 304s from the ETag cache above still count against it. Capping concurrency (the
// BATCH loop in refresh.ts) is therefore a guess, not a fix — a large enrich set
// trips it anyway and the raw 403 used to land in the dashboard's error banner
// (#69). GitHub's documented contract is to honor Retry-After / x-ratelimit-reset
// and back off, which is what this does; only an exhausted retry budget throws.
const THROTTLE_RETRIES = 3;
// A ceiling on any server-supplied wait. A primary-limit reset can be most of an
// hour away, and a refresh that blocks that long is worse than a degraded one
// that falls back to last-known-good data and retries on the next tick.
const MAX_THROTTLE_WAIT_MS = 60_000;
// The per-wait cap alone still let one sweep block for minutes: every request
// could wait the cap three times over. This is the total backoff one refresh
// (one resetGithubStats) may spend across all its requests, parallel waits
// counted separately; past it, a throttled request fails at once and the
// refresh degrades to last-known-good data.
const THROTTLE_BUDGET_MS = 90_000;
let throttleBudgetMs = THROTTLE_BUDGET_MS;
// When a response shows the primary limit exhausted with its reset further
// off than one capped wait, no backoff can help: until that reset, every
// request against the same budget (REST and GraphQL are separate) fails
// without touching the network. Module-level, so it spans refreshes.
const rateLimitedUntil: Record<'rest' | 'graphql', number> = { rest: 0, graphql: 0 };
export function resetGithubRateLimit(): void { rateLimitedUntil.rest = 0; rateLimitedUntil.graphql = 0; }

// The x-ratelimit-reset (epoch ms) of a primary-limit-exhausted throttle
// whose reset is too far away to wait for, else null.
function exhaustedUntil(res: { status: number; headers?: { get(name: string): string | null } }, now: number): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  if (res.headers?.get('x-ratelimit-remaining') !== '0') return null;
  const reset = Number(res.headers?.get('x-ratelimit-reset'));
  if (!Number.isFinite(reset)) return null;
  return reset * 1000 - now > MAX_THROTTLE_WAIT_MS ? reset * 1000 : null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Returns how long to wait before retrying, or null if this failure isn't a
// throttle. Detects the secondary limit by body text, and both limits by the
// presence of Retry-After / an exhausted x-ratelimit-remaining, so a 429 or a
// 403 carrying only headers is still recognised.
export function throttleWaitMs(
  res: { status: number; headers?: { get(name: string): string | null } },
  body: string,
  attempt: number,
  now = Date.now(),
): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const num = (name: string) => {
    const raw = res.headers?.get(name);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const retryAfter = num('retry-after');
  const reset = num('x-ratelimit-reset');
  const exhausted = res.headers?.get('x-ratelimit-remaining') === '0';
  const secondary = /secondary rate limit/i.test(body);
  // A 403 that is not a throttle (a bad token, a repo the token can't see)
  // must still fail fast — retrying it just delays the banner.
  if (!secondary && retryAfter == null && !exhausted) return null;
  // Exponential backoff is the floor: GitHub often answers a secondary limit
  // with no Retry-After at all.
  let wait = 1000 * 2 ** attempt;
  if (retryAfter != null && retryAfter > 0) wait = Math.max(wait, retryAfter * 1000);
  else if (exhausted && reset != null) wait = Math.max(wait, reset * 1000 - now);
  return Math.min(Math.max(wait, 0), MAX_THROTTLE_WAIT_MS);
}

// True for an error message produced by an exhausted throttle retry budget, so
// callers can say "GitHub throttled us" instead of pasting a URL and a JSON blob
// into the UI. Matches on the message because per-repo failures are flattened to
// strings before they reach the banner (fetchPrs).
export const isThrottleMessage = (msg: string | undefined): boolean =>
  /secondary rate limit|rate limit exceeded|api rate limit/i.test(msg ?? '');

// One fetch with the throttle contract above, counted into the stats. Returns
// the response for the caller to read (a 304 is a success here, not an error).
async function send(family: GithubRequestFamily, path: string, token: string,
  init: { method?: 'POST'; body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const bucket = family === 'graphql' ? 'graphql' : 'rest';
  for (let attempt = 0; ; attempt++) {
    // Message names the rate limit, so isThrottleMessage still recognises it.
    if (Date.now() < rateLimitedUntil[bucket]) {
      throw new Error(`GitHub API rate limit exceeded until ${new Date(rateLimitedUntil[bucket]).toISOString()} (${bucket}); not sent: ${path}`);
    }
    stats.requests++;
    stats.byFamily[family] = (stats.byFamily[family] ?? 0) + 1;
    if (attempt > 0) stats.retries++;
    const res = await fetch(`https://api.github.com${path}`, {
      method: init.method ?? 'GET',
      body: init.body,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...init.headers },
      signal: AbortSignal.timeout(30_000),
    });
    // Optional chain: test stubs (and any minimal fetch shim) may return a
    // response without a headers object.
    const remaining = Number(res.headers?.get('x-ratelimit-remaining'));
    if (Number.isFinite(remaining)) stats.rateLimitRemaining[bucket] = remaining;
    if (res.ok || res.status === 304) return res;
    const text = await res.text();
    const until = exhaustedUntil(res, Date.now());
    if (until !== null) rateLimitedUntil[bucket] = Math.max(rateLimitedUntil[bucket], until);
    const wait = attempt < THROTTLE_RETRIES && until === null ? throttleWaitMs(res, text, attempt) : null;
    if (wait !== null && wait <= throttleBudgetMs) {
      throttleBudgetMs -= wait;
      await sleep(wait);
      continue;
    }
    throw new Error(`GitHub ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
}

// REST GET through the ETag cache, with the response's Link header (cached
// alongside the body, since a 304 carries no pagination of its own).
async function ghPage<T>(family: GithubRequestFamily, path: string, token: string): Promise<{ body: T; link: string | null }> {
  const cached = etagCache.get(path);
  const res = await send(family, path, token, cached ? { headers: { 'If-None-Match': cached.etag } } : {});
  if (res.status === 304) {
    if (!cached) throw new Error(`GitHub 304 ${path}: no cached body`);
    stats.notModified++;
    return { body: cached.body as T, link: cached.link };
  }
  const body = await res.json() as T;
  const link = res.headers?.get('link') ?? null;
  const etag = res.headers?.get('etag');
  if (etag) {
    if (etagCache.size >= ETAG_CACHE_MAX) etagCache.clear();
    etagCache.set(path, { etag, body, link });
  }
  return { body, link };
}

async function gh<T>(family: GithubRequestFamily, path: string, token: string): Promise<T> {
  return (await ghPage<T>(family, path, token)).body;
}

// The page number of a Link header's rel="last" entry, or null when there is
// only one page (GitHub omits rel="last" on the last page itself).
export function lastPageFromLink(link: string | null | undefined): number | null {
  for (const part of (link ?? '').split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="last"/);
    if (!m) continue;
    const page = Number(new URL(m[1]!, 'https://api.github.com').searchParams.get('page'));
    return Number.isInteger(page) && page > 0 ? page : null;
  }
  return null;
}

// The issue-comments endpoint lists oldest first and ignores sort/direction,
// so a thread over 100 comments (bot-heavy PRs) would hand back only the
// oldest page and miss the newest human comments. Fetch page 1 (which says
// how many pages there are), then the last page and the one before it, so
// the newest 100-200 comments are always in hand. Costs one request up to
// 100 comments, two up to 200, three beyond.
async function newestIssueComments(path: string, token: string): Promise<RawComment[]> {
  const first = await ghPage<RawComment[]>('issue_comments', `${path}?per_page=100`, token);
  const last = lastPageFromLink(first.link);
  if (!last || last < 2) return first.body;
  const pages = last === 2 ? [2] : [last - 1, last];
  const rest = await Promise.all(pages.map(n => gh<RawComment[]>('issue_comments', `${path}?per_page=100&page=${n}`, token)));
  return [...(last === 2 ? first.body : []), ...rest.flat()];
}

interface GqlResponse<T> { data?: T | null; errors?: { message?: string }[] }

// GraphQL POST. No ETag (POSTs aren't conditional) and its own rate-limit
// budget. A rate-limit error can arrive as a 200 with an errors array; its
// message names the rate limit, so isThrottleMessage still recognises it.
async function graphql<T>(query: string, variables: Record<string, unknown>, token: string): Promise<T> {
  const res = await send('graphql', '/graphql', token,
    { method: 'POST', body: JSON.stringify({ query, variables }), headers: { 'Content-Type': 'application/json' } });
  const body = await res.json() as GqlResponse<T>;
  if (body.errors?.length) {
    throw new Error(`GitHub graphql: ${body.errors.map(e => e.message ?? 'error').join('; ').slice(0, 200)}`);
  }
  if (!body.data) throw new Error('GitHub graphql: empty response');
  return body.data;
}

// One request per repo: the author's 50 most recently updated PRs with every
// field mapPr needs. The old shape was Search (issue shape only, no branch or
// merge state) plus one /pulls/{n} detail request per hit — 51 requests per
// repo, most of them 304s that still counted against the secondary limit (#72).
const PR_SEARCH = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number url title body headRefName state isDraft createdAt updatedAt mergedAt closedAt
        labels(first: 10) { nodes { name } }
        reviewRequests(first: 1) { totalCount }
        commits(last: 1) { nodes { commit { statusCheckRollup { state ...Checks } } } }
        baseRef { target { ... on Commit { statusCheckRollup { state ...Checks } } } }
      }
    }
  }
}`;

// Per-check results ride along on the discovery query (one more connection
// per PR, no extra request), so base-branch failures need no cache (#79).
const PR_SEARCH_QUERY = `${PR_SEARCH}
fragment Checks on StatusCheckRollup {
  contexts(first: 50) { nodes { ... on CheckRun { name conclusion } ... on StatusContext { context state } } }
}`;

interface PrSearchData { search?: { nodes?: (Partial<GqlPr> | null)[] | null } | null }

// Fetches PRs across repos. Returns { prs, errors } to isolate per-repo failures.
//
// Author filtering happens server-side. Asking /pulls for the repo's 50
// most-recently-updated PRs and filtering by author locally dropped ~95% of
// the author's PRs on a busy repo; a search applies the window to *the user's*
// PRs instead, so it returns the author's 50 newest.
export async function fetchPrs(cfg: GithubConfig): Promise<{ prs: Pr[]; errors: string[] }> {
  const prs: Pr[] = [];
  const errors: string[] = [];
  for (const repo of cfg.repos) {
    const full = repo.includes('/') ? repo : `${cfg.org}/${repo}`;
    try {
      // sort:updated-desc in the query string: GraphQL search has no sort
      // argument and defaults to best match, which would break the "author's
      // 50 most recently updated" window once the author has more PRs than fit.
      const data = await graphql<PrSearchData>(PR_SEARCH_QUERY, { q: `is:pr author:${cfg.username} repo:${full} sort:updated-desc` }, cfg.token);
      for (const node of data.search?.nodes ?? []) {
        // A search typed ISSUE can hand back an Issue node, which the
        // PullRequest fragment leaves empty.
        if (node && typeof node.number === 'number') prs.push(mapPr(node as GqlPr, full));
      }
    } catch (e) {
      errors.push(`${full}: ${(e as Error).message}`);
    }
  }
  return { prs, errors };
}

// Detail-fetch only PRs that got linked to a card (keeps API calls bounded),
// and only when the PR changed since the last refresh: refresh.ts reuses the
// last-known enrichment for a linked PR whose updatedAt is unchanged (#72).
// CI is not fetched here — it arrives with discovery (mapPr).
export async function enrichPr(pr: Pr, cfg: GithubConfig): Promise<Pr> {
  const [owner, repo] = pr.repo.split('/');
  const base = `/repos/${owner}/${repo}`;
  // Review comments take sort=created&direction=desc so a >100-comment thread
  // keeps the newest comments (the ones that matter for attention) instead of
  // silently truncating to the oldest page. Issue comments ignore those
  // parameters, so newestIssueComments pages to the end instead. The reviews
  // endpoint is left as-is.
  const [issueComments, reviewComments, reviews] = await Promise.all([
    newestIssueComments(`${base}/issues/${pr.number}/comments`, cfg.token),
    gh<RawComment[]>('review_comments', `${base}/pulls/${pr.number}/comments?per_page=100&sort=created&direction=desc`, cfg.token),
    gh<RawReview[]>('reviews', `${base}/pulls/${pr.number}/reviews?per_page=100`, cfg.token),
  ]);
  const comment = (c: RawComment): PrComment => ({ author: c.user?.login ?? '', body: c.body ?? '', createdAt: c.created_at ?? c.submitted_at });
  pr.comments = [
    ...issueComments.map(comment),
    ...reviewComments.map(comment),
    ...reviews.filter(r => r.body).map(r => ({ author: r.user?.login ?? '', body: r.body ?? '', createdAt: r.submitted_at })),
  ].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  // A pending review request (seen at discovery) outranks any earlier review.
  pr.reviewState = reviewStateFrom(pr.reviewState === 'review_required', reviews);
  pr.enriched = true;
  pr.enrichedAt = new Date().toISOString();
  return pr;
}
