// Canned cards/PRs for demo mode (config.demo). Shapes match jira.js mapIssue
// and github.js mapPr post-enrichment, so refresh() runs the real pipeline.
const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

export function demoCards(cfg) {
  const url = (k) => `${cfg.baseUrl?.startsWith('http') ? cfg.baseUrl : 'https://example.atlassian.net'}/browse/${k}`;
  const card = (key, summary, status, age, comments = [], description = '') => ({
    key, summary, status, description, url: url(key),
    createdAt: iso(age + 10), updatedAt: iso(age),
    myAccountId: cfg.accountId, comments,
  });
  return [
    card('DEMO-101', 'Fix login redirect loop on SSO tenants', 'In Progress', 1, [
      { author: 'Priya N', authorId: 'priya', body: 'QA blocked on this, any ETA?', createdAt: iso(0.3) },
    ]),
    card('DEMO-97', 'Migrate billing webhooks to v2 signatures', 'In Review', 3),
    card('DEMO-104', 'Add rate limiting to public API', 'In Progress', 0),
    card('DEMO-108', 'Refactor notification queue consumer', 'In Progress', 1),
    card('DEMO-99', 'Support CSV export on reports page', 'In Review', 4),
    card('DEMO-95', 'New onboarding checklist flow', 'In Test', 6),
    card('DEMO-92', 'Dark mode for customer portal', 'Done', 2),
    card('DEMO-112', 'Spike: evaluate feature flag providers', 'To Do', 1),
    card('DEMO-113', 'Clean up deprecated user settings endpoints', 'To Do', 3),
    // Older Done cards behind the last 5 months of merged PRs (chart demo data).
    card('DEMO-80', 'Add retry backoff to job queue', 'Done', 20),
    card('DEMO-81', 'Switch mobile push provider', 'Done', 35),
    card('DEMO-82', 'API gateway rate-limit headers', 'Done', 42),
    card('DEMO-83', 'Webapp: lazy-load dashboard charts', 'Done', 55),
    card('DEMO-84', 'Mobile: offline draft sync', 'Done', 68),
    card('DEMO-85', 'API gateway auth token rotation', 'Done', 80),
    card('DEMO-86', 'Webapp: accessibility pass on nav', 'Done', 105),
    card('DEMO-87', 'Mobile: crash reporting integration', 'Done', 130),
  ];
}

export function demoPrs(cfg) {
  const org = cfg.org || 'acme';
  const pr = (repo, number, branch, o) => ({
    repo: `${org}/${repo}`, number, url: `https://github.com/${org}/${repo}/pull/${number}`,
    title: '', body: '', branch, state: 'open', createdAt: iso(9), updatedAt: iso(1), mergedAt: null,
    ciStatus: 'passing', reviewState: 'none', comments: [], ...o,
  });
  return [
    pr('webapp', 482, 'DEMO-101-sso-redirect', {
      ciStatus: 'failing', reviewState: 'changes_requested',
      comments: [{ author: 'sarah-dev', body: 'The retry logic swallows the original error, can you preserve the stack?', createdAt: iso(0.2) }],
    }),
    pr('webapp', 475, 'DEMO-97-webhooks-v2', { state: 'merged', mergedAt: iso(0.1), reviewState: 'approved', ciStatus: 'unknown' }),
    pr('api-gateway', 489, 'DEMO-104-rate-limit', { ciStatus: 'pending' }),
    pr('webapp', 478, 'DEMO-99-csv-export', { reviewState: 'review_required' }),
    pr('webapp', 470, 'DEMO-95-onboarding', { state: 'merged', mergedAt: iso(6), reviewState: 'approved', ciStatus: 'unknown' }),
    pr('webapp', 465, 'DEMO-92-dark-mode', { state: 'merged', mergedAt: iso(2), reviewState: 'approved', ciStatus: 'unknown' }),
    pr('webapp', 491, 'chore-bump-node-22', { title: 'chore: bump node to 22' }),
    // Older merges spread over the past ~5 months, varied repos, so the
    // charts panel (merged per month / merged by repo) has real spread.
    pr('api-gateway', 412, 'DEMO-80-job-retry-backoff', { state: 'merged', mergedAt: iso(19), reviewState: 'approved', ciStatus: 'unknown' }),
    pr('mobile', 220, 'DEMO-81-push-provider', { state: 'merged', mergedAt: iso(34), reviewState: 'approved', ciStatus: 'unknown' }),
    pr('api-gateway', 398, 'DEMO-82-ratelimit-headers', { state: 'merged', mergedAt: iso(41), reviewState: 'approved', ciStatus: 'unknown' }),
    pr('webapp', 458, 'DEMO-83-lazy-load-charts', { state: 'merged', mergedAt: iso(54), reviewState: 'approved', ciStatus: 'unknown' }),
    pr('mobile', 205, 'DEMO-84-offline-draft-sync', { state: 'merged', mergedAt: iso(67), reviewState: 'approved', ciStatus: 'unknown' }),
    pr('api-gateway', 371, 'DEMO-85-token-rotation', { state: 'merged', mergedAt: iso(79), reviewState: 'approved', ciStatus: 'unknown' }),
    pr('webapp', 431, 'DEMO-86-a11y-nav', { state: 'merged', mergedAt: iso(104), reviewState: 'approved', ciStatus: 'unknown' }),
    pr('mobile', 188, 'DEMO-87-crash-reporting', { state: 'merged', mergedAt: iso(129), reviewState: 'approved', ciStatus: 'unknown' }),
    // Closed-unmerged PRs, varied ages/repos, so the Closed series in the
    // Monthly Activity chart has real data.
    pr('webapp', 460, 'stale-experiment-toggle', { state: 'closed', mergedAt: null, createdAt: iso(50), updatedAt: iso(45), reviewState: 'changes_requested', ciStatus: 'failing' }),
    pr('api-gateway', 405, 'abandoned-cache-layer', { state: 'closed', mergedAt: null, createdAt: iso(75), updatedAt: iso(70), reviewState: 'none', ciStatus: 'unknown' }),
    pr('mobile', 210, 'rejected-push-redesign', { state: 'closed', mergedAt: null, createdAt: iso(20), updatedAt: iso(15), reviewState: 'changes_requested', ciStatus: 'unknown' }),
    // Recent closed-unmerged PR (within the 7-day Recent Activity window).
    pr('webapp', 495, 'wont-fix-legacy-toggle', { state: 'closed', mergedAt: null, createdAt: iso(5), updatedAt: iso(2), reviewState: 'none', ciStatus: 'unknown' }),
  ];
}
