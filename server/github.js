export function mapPr(raw, repo) {
  return {
    repo,
    number: raw.number,
    url: raw.html_url,
    title: raw.title ?? '',
    body: raw.body ?? '',
    branch: raw.head?.ref ?? '',
    state: raw.merged_at ? 'merged' : raw.state, // 'open' | 'merged' | 'closed'
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    mergedAt: raw.merged_at ?? null,
    ciStatus: 'unknown',
    reviewState: 'none',
    comments: [],
  };
}

const OK = new Set(['success', 'neutral', 'skipped']);

export function ciFromCheckRuns(runs) {
  if (!runs?.length) return 'unknown';
  if (runs.some(r => r.status !== 'completed')) return 'pending';
  return runs.every(r => OK.has(r.conclusion)) ? 'passing' : 'failing';
}

export function reviewStateFrom(pr, reviews) {
  if (pr.requested_reviewers?.length || pr.requested_teams?.length) return 'review_required';
  // latest review per reviewer wins
  const latest = new Map();
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

async function gh(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Fetches PRs across repos. Returns { prs, errors } to isolate per-repo failures.
export async function fetchPrs(cfg) {
  const prs = [];
  const errors = [];
  for (const repo of cfg.repos) {
    const full = `${cfg.org}/${repo}`;
    try {
      const list = await gh(`/repos/${full}/pulls?state=all&sort=updated&direction=desc&per_page=50`, cfg.token);
      prs.push(...list.filter(r => r.user?.login === cfg.username).map(r => ({ ...mapPr(r, full), _raw: { head: { sha: r.head?.sha }, requested_reviewers: r.requested_reviewers, requested_teams: r.requested_teams } })));
    } catch (e) {
      errors.push(`${full}: ${e.message}`);
    }
  }
  return { prs, errors };
}

// Detail-fetch only PRs that got linked to a card (keeps API calls bounded).
export async function enrichPr(pr, cfg) {
  const [owner, repo] = pr.repo.split('/');
  const base = `/repos/${owner}/${repo}`;
  const [issueComments, reviewComments, reviews, checks] = await Promise.all([
    gh(`${base}/issues/${pr.number}/comments?per_page=100`, cfg.token),
    gh(`${base}/pulls/${pr.number}/comments?per_page=100`, cfg.token),
    gh(`${base}/pulls/${pr.number}/reviews?per_page=100`, cfg.token),
    pr.state === 'open'
      ? gh(`${base}/commits/${pr._raw.head.sha}/check-runs?per_page=100`, cfg.token).then(d => d.check_runs)
      : Promise.resolve([]),
  ]);
  const comment = (c) => ({ author: c.user?.login ?? '', body: c.body ?? '', createdAt: c.created_at ?? c.submitted_at });
  pr.comments = [
    ...issueComments.map(comment),
    ...reviewComments.map(comment),
    ...reviews.filter(r => r.body).map(r => ({ author: r.user?.login ?? '', body: r.body, createdAt: r.submitted_at })),
  ].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  pr.ciStatus = pr.state === 'open' ? ciFromCheckRuns(checks) : 'unknown';
  pr.reviewState = reviewStateFrom(pr._raw, reviews);
  delete pr._raw;
  return pr;
}
