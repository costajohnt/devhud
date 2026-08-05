import type { Pr, PrComment, GithubConfig, CiStatus, ReviewState } from './types.ts';

// Minimal shapes for the slices of the raw GitHub REST API responses this
// file actually reads — not full API types, just what's used below.
interface RawPr {
  number: number;
  html_url: string;
  title?: string;
  body?: string;
  head?: { ref?: string; sha?: string };
  merged_at?: string | null;
  state: string;
  draft?: boolean;
  created_at: string;
  updated_at: string;
  user?: { login?: string };
  requested_reviewers?: unknown[];
  requested_teams?: unknown[];
}

interface RawCheckRun {
  name?: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

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

export function mapPr(raw: RawPr, repo: string): Pr {
  return {
    repo,
    number: raw.number,
    url: raw.html_url,
    title: raw.title ?? '',
    body: raw.body ?? '',
    branch: raw.head?.ref ?? '',
    state: (raw.merged_at ? 'merged' : raw.state) as Pr['state'], // 'open' | 'merged' | 'closed'
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    mergedAt: raw.merged_at ?? null,
    ciStatus: 'unknown',
    reviewState: 'none',
    isDraft: raw.draft ?? false,
    comments: [],
  };
}

const OK = new Set(['success', 'neutral', 'skipped']);

// A rerun creates a new check run with the same name; dedup by name keeping
// only the latest (by started_at, falling back to completed_at) so an old
// failing attempt doesn't shadow a newer passing rerun.
function latestByName(runs: RawCheckRun[]): RawCheckRun[] {
  const latest = new Map<string, RawCheckRun>();
  runs.forEach((r, i) => {
    // Runs without a name can't be meaningfully deduped against each other;
    // give each an index-scoped key so they're all kept.
    const key = r.name ?? `__unnamed_${i}`;
    const prev = latest.get(key);
    const at = r.started_at ?? r.completed_at ?? '';
    const prevAt = prev ? (prev.started_at ?? prev.completed_at ?? '') : '';
    if (!prev || at > prevAt) latest.set(key, r);
  });
  return [...latest.values()];
}

export function ciFromCheckRuns(runs: RawCheckRun[] | undefined | null): CiStatus {
  if (!runs?.length) return 'unknown';
  const deduped = latestByName(runs);
  if (deduped.some(r => r.status !== 'completed')) return 'pending';
  return deduped.every(r => OK.has(r.conclusion ?? '')) ? 'passing' : 'failing';
}

export function reviewStateFrom(pr: { requested_reviewers?: unknown[]; requested_teams?: unknown[] } | undefined, reviews: RawReview[] | undefined): ReviewState {
  if (pr?.requested_reviewers?.length || pr?.requested_teams?.length) return 'review_required';
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

async function gh<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

interface RawSearchResult {
  items?: { number: number }[];
}

// Fetches PRs across repos. Returns { prs, errors } to isolate per-repo failures.
//
// Author filtering happens server-side. The old approach asked /pulls for the
// repo's 50 most-recently-updated PRs and then filtered by author locally, but
// on a busy repo the author's PRs are almost never inside that window — ~95% of
// them were dropped before any dashboard logic ran, starving the board, the
// Merged page, and the charts. The Search API applies the per_page window to
// *the user's* PRs instead of the repo's, so it returns the author's 50 newest.
export async function fetchPrs(cfg: GithubConfig): Promise<{ prs: Pr[]; errors: string[] }> {
  const prs: Pr[] = [];
  const errors: string[] = [];
  for (const repo of cfg.repos) {
    const full = repo.includes('/') ? repo : `${cfg.org}/${repo}`;
    try {
      // Search only returns the issue shape (no head.ref / merged_at), so it
      // gives us the author's PR numbers; each still needs a /pulls/{number}
      // detail fetch to get the branch and merge state mapPr depends on.
      const q = encodeURIComponent(`is:pr author:${cfg.username} repo:${full}`);
      const found = await gh<RawSearchResult>(`/search/issues?q=${q}&sort=updated&order=desc&per_page=50`, cfg.token);
      const numbers = (found.items ?? []).map(i => i.number);
      const details = await Promise.all(numbers.map(n => gh<RawPr>(`/repos/${full}/pulls/${n}`, cfg.token)));
      prs.push(...details.map(r => ({
        ...mapPr(r, full),
        _raw: { head: { sha: r.head?.sha }, requested_reviewers: r.requested_reviewers, requested_teams: r.requested_teams },
      })));
    } catch (e) {
      errors.push(`${full}: ${(e as Error).message}`);
    }
  }
  return { prs, errors };
}

// Detail-fetch only PRs that got linked to a card (keeps API calls bounded).
export async function enrichPr(pr: Pr, cfg: GithubConfig): Promise<Pr> {
  const [owner, repo] = pr.repo.split('/');
  const base = `/repos/${owner}/${repo}`;
  // sort=created&direction=desc so a >100-comment thread keeps the newest
  // comments (the ones that matter for attention) instead of silently
  // truncating to the oldest page. The reviews endpoint is left as-is.
  const [issueComments, reviewComments, reviews, checks] = await Promise.all([
    gh<RawComment[]>(`${base}/issues/${pr.number}/comments?per_page=100&sort=created&direction=desc`, cfg.token),
    gh<RawComment[]>(`${base}/pulls/${pr.number}/comments?per_page=100&sort=created&direction=desc`, cfg.token),
    gh<RawReview[]>(`${base}/pulls/${pr.number}/reviews?per_page=100`, cfg.token),
    pr.state === 'open'
      ? gh<{ check_runs: RawCheckRun[] }>(`${base}/commits/${pr._raw?.head.sha}/check-runs?per_page=100`, cfg.token).then(d => d.check_runs)
      : Promise.resolve([] as RawCheckRun[]),
  ]);
  const comment = (c: RawComment): PrComment => ({ author: c.user?.login ?? '', body: c.body ?? '', createdAt: c.created_at ?? c.submitted_at });
  pr.comments = [
    ...issueComments.map(comment),
    ...reviewComments.map(comment),
    ...reviews.filter(r => r.body).map(r => ({ author: r.user?.login ?? '', body: r.body ?? '', createdAt: r.submitted_at })),
  ].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  pr.ciStatus = pr.state === 'open' ? ciFromCheckRuns(checks) : 'unknown';
  pr.reviewState = reviewStateFrom(pr._raw, reviews);
  delete pr._raw;
  return pr;
}
