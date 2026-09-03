import { test, expect } from 'vitest';
import { classifyCard, isTodo, isDone, isCanceled, isBlocked, sameStatus } from './classify.ts';
import type { Card, Pr, CardState, JiraStatuses } from './types.ts';

const statuses: JiraStatuses = { todo: 'To Do', inTest: 'In Test', done: 'Done', canceled: 'Canceled' };
const base = { username: 'john', statuses };
const card = (o: Partial<Card> = {}): Card => ({ key: 'P-1', status: 'In Progress', myAccountId: 'me', comments: [], summary: '', description: '', url: '', createdAt: null, updatedAt: null, ...o });
const pr = (o: Partial<Pr> = {}): Pr => ({ state: 'open', ciStatus: 'passing', reviewState: 'none', comments: [], repo: 'o/r', number: 1, url: '', title: '', body: '', branch: '', createdAt: '', updatedAt: '', mergedAt: null, closedAt: null, ...o });
const cs = (o: Partial<CardState> = {}): CardState => ({ lastSeenPr: '2026-07-01T00:00:00Z', lastSeenJira: '2026-07-01T00:00:00Z', override: null, overrideAt: null, ...o });

test('ci failing -> needs_attention', () => {
  const r = classifyCard({ ...base, card: card(), pr: pr({ ciStatus: 'failing' }), cs: cs() });
  expect(r.bucket).toBe('needs_attention');
  expect(r.attention).toContain('ci_failing');
});

// Comment reasons are badges, not routing: the card keeps the bucket its
// status/PR state earns and the UI renders a "N new comments" pill.
test('new PR comment by someone else -> attention reason without leaving its bucket', () => {
  const others = pr({ comments: [{ author: 'reviewer', body: 'x', createdAt: '2026-07-02T00:00:00Z' }] });
  const r = classifyCard({ ...base, card: card(), pr: others, cs: cs() });
  expect(r.bucket).toBe('self_review');
  expect(r.attention).toContain('new_pr_comments');
  expect(r.newComments).toHaveLength(1);
  const mine = pr({ comments: [{ author: 'john', body: 'x', createdAt: '2026-07-02T00:00:00Z' }] });
  expect(classifyCard({ ...base, card: card(), pr: mine, cs: cs() }).bucket).toBe('self_review');
});

test('merged but not In Test -> needs_attention; merged and In Test -> qa_ready', () => {
  const m = pr({ state: 'merged' });
  expect(classifyCard({ ...base, card: card(), pr: m, cs: cs() }).attention).toContain('merged_not_in_test');
  expect(classifyCard({ ...base, card: card({ status: 'In Test', description: 'QA instructions: click it' }), pr: m, cs: cs() }).bucket).toBe('qa_ready');
});

test('override wins when no attention; attention beats override', () => {
  expect(classifyCard({ ...base, card: card(), pr: pr(), cs: cs({ override: 'in_qa' }) }).bucket).toBe('in_qa');
  expect(classifyCard({ ...base, card: card(), pr: pr({ ciStatus: 'failing' }), cs: cs({ override: 'in_qa' }) }).bucket).toBe('needs_attention');
});

test('review_required -> waiting_review; no PR -> in_progress; todo helper', () => {
  expect(classifyCard({ ...base, card: card(), pr: pr({ reviewState: 'review_required' }), cs: cs() }).bucket).toBe('waiting_review');
  expect(classifyCard({ ...base, card: card(), pr: null, cs: cs() }).bucket).toBe('in_progress');
  expect(isTodo(card({ status: 'To Do' }), statuses)).toBe(true);
});

test('approved PR -> mergeable', () => {
  expect(classifyCard({ ...base, card: card(), pr: pr({ reviewState: 'approved' }), cs: cs() }).bucket).toBe('mergeable');
});

test('new jira comment by someone else since lastSeenJira', () => {
  const c = card({ comments: [{ authorId: 'other', author: '', body: 'x', createdAt: '2026-07-02T00:00:00Z' }] });
  const r = classifyCard({ ...base, card: c, pr: null, cs: cs() });
  expect(r.attention).toContain('new_jira_comments');
  expect(r.newComments[0]!.source).toBe('jira');
});

test('multi-comment sort: jira and github comments sorted descending by createdAt', () => {
  const c = card({ comments: [{ authorId: 'other', author: '', body: 'jira comment', createdAt: '2026-07-02T00:00:00Z' }] });
  const p = pr({ comments: [{ author: 'reviewer', body: 'github comment', createdAt: '2026-07-03T00:00:00Z' }] });
  const r = classifyCard({ ...base, card: c, pr: p, cs: cs() });
  expect(r.newComments).toHaveLength(2);
  expect(r.newComments[0]!.source).toBe('github');
  expect(r.newComments[0]!.createdAt).toBe('2026-07-03T00:00:00Z');
  expect(r.newComments[1]!.source).toBe('jira');
  expect(r.newComments[1]!.createdAt).toBe('2026-07-02T00:00:00Z');
});

test('merged with Done status excludes merged_not_in_test', () => {
  const m = pr({ state: 'merged' });
  const r = classifyCard({ ...base, card: card({ status: 'Done' }), pr: m, cs: cs() });
  expect(r.attention).not.toContain('merged_not_in_test');
});

test('isTodo/isDone follow the status category, not just the exact name', () => {
  // 'Assigned' in the To Do category is a Todo even though it isn't the todo name.
  expect(isTodo(card({ status: 'Assigned', statusCategory: 'new' }), statuses)).toBe(true);
  // A Done-category status that isn't the done name still counts as done.
  expect(isDone(card({ status: 'Closed', statusCategory: 'done' }), statuses)).toBe(true);
  // Exact-name fallback still works when no category is present.
  expect(isTodo(card({ status: 'To Do' }), statuses)).toBe(true);
  expect(isDone(card({ status: 'Done' }), statuses)).toBe(true);
});

test('Canceled (Done category) is canceled, not done', () => {
  const c = card({ status: 'Canceled', statusCategory: 'done' });
  expect(isCanceled(c, statuses)).toBe(true);
  expect(isDone(c, statuses)).toBe(false); // excluded from Done despite the category
});

test('comments from ignored authors (John/Rovo) do not trigger needs_attention', () => {
  const c = card({ comments: [{ authorId: 'rovo', author: 'Rovo', body: 'auto', createdAt: '2026-07-02T00:00:00Z' }] });
  const r = classifyCard({ ...base, card: c, pr: null, cs: cs(), ignoreAuthors: ['John', 'Rovo'] });
  expect(r.attention).not.toContain('new_jira_comments');
  expect(r.newComments).toHaveLength(0);
  expect(r.bucket).toBe('in_progress');
  // A PR comment from John (matches the ignore list) is likewise skipped.
  const p = pr({ comments: [{ author: 'John Costa', body: 'note', createdAt: '2026-07-02T00:00:00Z' }] });
  const r2 = classifyCard({ ...base, card: card(), pr: p, cs: cs(), ignoreAuthors: ['John', 'Rovo'] });
  expect(r2.attention).not.toContain('new_pr_comments');
});

test('acked state-based reason stays muted while true, re-triggers after clearing and recurring', () => {
  const m = pr({ state: 'merged' });
  const c = cs({ ackedReasons: ['merged_not_in_test'] });
  const r = classifyCard({ ...base, card: card(), pr: m, cs: c });
  expect(r.attention).toEqual([]);
  expect(r.bucket).toBe('in_progress');
  // reason clears (no merged PR any more) -> the ack is forgotten
  classifyCard({ ...base, card: card(), pr: null, cs: c });
  expect(c.ackedReasons).toBeNull();
  // recurrence is a new event -> re-triggers
  expect(classifyCard({ ...base, card: card(), pr: m, cs: c }).bucket).toBe('needs_attention');
});

test('new comment still surfaces while a state-based reason is acked', () => {
  const m = pr({ state: 'merged', comments: [{ author: 'reviewer', body: 'x', createdAt: '2026-07-02T00:00:00Z' }] });
  const r = classifyCard({ ...base, card: card(), pr: m, cs: cs({ ackedReasons: ['merged_not_in_test'] }) });
  // Acking merged_not_in_test drops the only routing reason, so the card falls
  // back to its status bucket; the unread comment still rides along as a badge.
  expect(r.bucket).toBe('in_progress');
  expect(r.attention).toEqual(['new_pr_comments']);
});

test('degraded PR data mutes acked reasons without pruning them', () => {
  const c = cs({ ackedReasons: ['ci_failing'] });
  // GitHub down, no last-known-good: pr is null, so ci_failing is absent this
  // refresh — the ack must survive rather than be mistaken for "cleared".
  const r = classifyCard({ ...base, card: card(), pr: null, cs: c, prDegraded: true });
  expect(c.ackedReasons).toEqual(['ci_failing']);
  expect(r.bucket).toBe('in_progress');
  // healthy refresh, CI still failing: still muted
  const r2 = classifyCard({ ...base, card: card(), pr: pr({ ciStatus: 'failing' }), cs: c });
  expect(r2.bucket).toBe('self_review');
  expect(c.ackedReasons).toEqual(['ci_failing']);
});

test('override auto-cleared when card reaches In Test or Done', () => {
  const s = cs({ override: 'waiting_review', overrideAt: '2026-07-01T00:00:00Z' });
  // In Test: override cleared, routes to qa_ready
  const r = classifyCard({ ...base, card: card({ status: 'In Test', description: 'QA instructions: click it' }), pr: pr({ state: 'merged' }), cs: s });
  expect(r.bucket).toBe('qa_ready');
  expect(s.override).toBeNull();
  expect(s.overrideAt).toBeNull();
  // Done: override cleared, routes to in_progress (Done cards are filtered upstream, but classify still works)
  const s2 = cs({ override: 'self_review', overrideAt: '2026-07-01T00:00:00Z' });
  classifyCard({ ...base, card: card({ status: 'Done' }), pr: null, cs: s2 });
  expect(s2.override).toBeNull();
  // In Progress: override preserved
  const s3 = cs({ override: 'waiting_review', overrideAt: '2026-07-01T00:00:00Z' });
  const r3 = classifyCard({ ...base, card: card(), pr: pr(), cs: s3 });
  expect(r3.bucket).toBe('waiting_review');
  expect(s3.override).toBe('waiting_review');
});

test('pin released on Jira status transition; card falls to classifier bucket (#53)', () => {
  // Pinned to In Progress while addressing review feedback; card then
  // transitions In Progress -> Code Review in Jira.
  const s = cs({ override: 'in_progress', overrideAt: '2026-07-01T00:00:00Z', lastStatus: 'In Progress' });
  const r = classifyCard({ ...base, card: card({ status: 'Code Review' }), pr: pr(), cs: s });
  expect(s.override).toBeNull();
  expect(s.overrideAt).toBeNull();
  expect(r.bucket).toBe('waiting_review');
  expect(s.lastStatus).toBe('Code Review');

  // Same status as last refresh: pin holds.
  const s2 = cs({ override: 'in_qa', overrideAt: '2026-07-01T00:00:00Z', lastStatus: 'In Progress' });
  expect(classifyCard({ ...base, card: card(), pr: pr(), cs: s2 }).bucket).toBe('in_qa');
  expect(s2.override).toBe('in_qa');

  // Pre-existing state file (no lastStatus yet): first refresh only records it.
  const s3 = cs({ override: 'in_qa', overrideAt: '2026-07-01T00:00:00Z' });
  expect(classifyCard({ ...base, card: card(), pr: pr(), cs: s3 }).bucket).toBe('in_qa');
  expect(s3.override).toBe('in_qa');
  expect(s3.lastStatus).toBe('In Progress');
});

test('junk (comment-reason) entries in ackedReasons are dropped, never muting comment attention', () => {
  const c = cs({ ackedReasons: ['new_pr_comments'] });
  const p = pr({ comments: [{ author: 'reviewer', body: 'x', createdAt: '2026-07-02T00:00:00Z' }] });
  const r = classifyCard({ ...base, card: card(), pr: p, cs: c });
  expect(r.attention).toContain('new_pr_comments');
  expect(c.ackedReasons).toBeNull();
});

// The card stays in QA Ready and wears the badge. Routing it to Needs
// Attention emptied the QA column the day the rule shipped, because the rule
// is retroactive: every In Test card ever, not just the fresh ones.
test('In Test card without QA instructions -> reason, but stays in qa_ready', () => {
  const r = classifyCard({ ...base, card: card({ status: 'In Test', description: 'just a fix' }), pr: null, cs: cs() });
  expect(r.bucket).toBe('qa_ready');
  expect(r.attention).toContain('missing_qa_instructions');
});

// The whole point of the split: a blocked/broken reason still evicts.
test('only blocked/broken reasons route to needs_attention', () => {
  const comments = [{ author: 'reviewer', body: 'x', createdAt: '2026-07-02T00:00:00Z' }];
  const r = classifyCard({ ...base, card: card(), pr: pr({ ciStatus: 'failing', comments }), cs: cs() });
  expect(r.bucket).toBe('needs_attention');
  expect(r.attention).toEqual(['ci_failing', 'new_pr_comments']);
});

test('In Test card with QA instructions routes to qa_ready; reason is ackable', () => {
  const desc = 'Fix the thing.\n----\n**QA test instructions**\n1. open the page';
  // fixVersions set so this stays a test of the QA rule alone.
  const ok = classifyCard({ ...base, card: card({ status: 'In Test', description: desc, fixVersions: ['1.0'] }), pr: null, cs: cs() });
  expect(ok.bucket).toBe('qa_ready');
  expect(ok.attention).toEqual([]);
  // Acked: stays out of Needs Attention while the reason persists.
  const s = cs({ ackedReasons: ['missing_qa_instructions'] });
  const acked = classifyCard({ ...base, card: card({ status: 'In Test', description: '' }), pr: null, cs: s });
  expect(acked.bucket).toBe('qa_ready');
  expect(s.ackedReasons).toEqual(['missing_qa_instructions']);
});

test('missing_qa_instructions only fires for In Test cards', () => {
  const r = classifyCard({ ...base, card: card({ status: 'In Progress', description: '' }), pr: null, cs: cs() });
  expect(r.attention).not.toContain('missing_qa_instructions');
});

// The other half of the hand-off gap. Same shape as the QA rule: a badge that
// leaves the card in QA Ready, and it is ackable.
test('In Test card without a fix version -> reason, but stays in qa_ready', () => {
  const desc = '**QA test instructions**\n1. open the page';
  const r = classifyCard({ ...base, card: card({ status: 'In Test', description: desc }), pr: null, cs: cs() });
  expect(r.bucket).toBe('qa_ready');
  expect(r.attention).toEqual(['missing_fix_version']);
});

test('In Test card with a fix version does not fire missing_fix_version', () => {
  const desc = '**QA test instructions**\n1. open the page';
  const c = card({ status: 'In Test', description: desc, fixVersions: ['1.2.3'] });
  expect(classifyCard({ ...base, card: c, pr: null, cs: cs() }).attention).toEqual([]);
});

// An empty array is the shape Jira returns for an unset field, so it must read
// as missing rather than as "present but empty".
test('missing_fix_version treats an empty fixVersions array as unset', () => {
  const c = card({ status: 'In Test', description: 'QA instructions: click it', fixVersions: [] });
  expect(classifyCard({ ...base, card: c, pr: null, cs: cs() }).attention).toContain('missing_fix_version');
});

test('missing_fix_version only fires for In Test cards', () => {
  const r = classifyCard({ ...base, card: card({ status: 'In Progress' }), pr: null, cs: cs() });
  expect(r.attention).not.toContain('missing_fix_version');
});

test('missing_fix_version is ackable and survives as a state reason', () => {
  const s = cs({ ackedReasons: ['missing_fix_version'] });
  const r = classifyCard({ ...base, card: card({ status: 'In Test', description: 'QA instructions: go' }), pr: null, cs: s });
  expect(r.attention).toEqual([]);
  expect(s.ackedReasons).toEqual(['missing_fix_version']);
});

// Both gaps are typical on the same card; neither may mask the other.
test('both hand-off reasons fire together without routing the card away', () => {
  const r = classifyCard({ ...base, card: card({ status: 'In Test', description: 'just a fix' }), pr: null, cs: cs() });
  expect(r.bucket).toBe('qa_ready');
  expect(r.attention).toEqual(['missing_qa_instructions', 'missing_fix_version']);
});

// --- issue #57: a QA comment on an In Test card is routing -----------------

test('In Test card with a new jira comment -> needs_attention', () => {
  const c = card({
    status: 'In Test',
    description: 'QA instructions: click it',
    comments: [{ authorId: 'other', author: 'qa', body: 'this still repros', createdAt: '2026-07-02T00:00:00Z' }],
  });
  const r = classifyCard({ ...base, card: c, pr: null, cs: cs() });
  expect(r.bucket).toBe('needs_attention');
  expect(r.attention).toContain('new_jira_comments');
});

// The watermark is what makes this safe to route on: once the developer reads
// the comment the reason clears by itself and the card returns to QA Ready. The
// missing-QA rule that once emptied QA Ready was persistently true, which is
// the difference.
test('In Test card whose jira comment has been seen -> back to qa_ready', () => {
  const c = card({
    status: 'In Test',
    description: 'QA instructions: click it',
    comments: [{ authorId: 'other', author: 'qa', body: 'this still repros', createdAt: '2026-07-02T00:00:00Z' }],
  });
  const seen = cs({ lastSeenJira: '2026-07-03T00:00:00Z' });
  const r = classifyCard({ ...base, card: c, pr: null, cs: seen });
  expect(r.attention).not.toContain('new_jira_comments');
  expect(r.bucket).toBe('qa_ready');
});

// Scoped to In Test on purpose: ROUTING_REASONS is unchanged, so a comment on
// an In Progress card is still a badge and does not evict it from its column.
test('a new jira comment on a non-In-Test card still does not route', () => {
  const c = card({
    status: 'In Progress',
    comments: [{ authorId: 'other', author: 'someone', body: 'a thought', createdAt: '2026-07-02T00:00:00Z' }],
  });
  const r = classifyCard({ ...base, card: c, pr: null, cs: cs() });
  expect(r.attention).toContain('new_jira_comments');
  expect(r.bucket).toBe('in_progress');
});

// An ignored author (John's own reply, Rovo automation) is not QA waiting.
test('In Test card whose only comment is from an ignored author stays in qa_ready', () => {
  const c = card({
    status: 'In Test',
    description: 'QA instructions: click it',
    comments: [{ authorId: 'rovo', author: 'Rovo', body: 'auto', createdAt: '2026-07-02T00:00:00Z' }],
  });
  const r = classifyCard({ ...base, card: c, pr: null, cs: cs(), ignoreAuthors: ['John', 'Rovo'] });
  expect(r.attention).not.toContain('new_jira_comments');
  expect(r.bucket).toBe('qa_ready');
});

// #64: a card moved to Code Review in Jira sat in In Progress forever, because
// the Code Review check lived inside the `pr?.state === 'open'` branch — so the
// developer's own statement about the work only counted if the board had
// already linked an open PR.
test('Code Review with no PR at all -> waiting_review, not in_progress', () => {
  expect(classifyCard({ ...base, card: card({ status: 'Code Review' }), pr: null, cs: cs() }).bucket).toBe('waiting_review');
});

test('Code Review still routes to waiting_review with an open unreviewed PR', () => {
  expect(classifyCard({ ...base, card: card({ status: 'Code Review' }), pr: pr(), cs: cs() }).bucket).toBe('waiting_review');
});

// The PR state is more specific than the Jira status where they disagree, so
// these two must not regress into waiting_review.
test('an approved PR still beats a Code Review status', () => {
  expect(classifyCard({ ...base, card: card({ status: 'Code Review' }), pr: pr({ reviewState: 'approved' }), cs: cs() }).bucket).toBe('mergeable');
});

// The draft PR is the one exception, reversed by #53: Simon labels every PR it
// opens `Draft`, so "PR state is more specific" left every executor-shipped card
// stuck in Self Review Needed. Moving the card to a review status is the
// operator overriding that. An approved PR (above) still wins.
test('a draft PR yields to a Code Review status (#53)', () => {
  expect(classifyCard({ ...base, card: card({ status: 'Code Review' }), pr: pr({ isDraft: true }), cs: cs() }).bucket).toBe('waiting_review');
  expect(classifyCard({ ...base, card: card({ status: 'In Progress' }), pr: pr({ isDraft: true }), cs: cs() }).bucket).toBe('self_review');
});

// A Jira status name is free text an admin can edit or re-case.
test('the review status matches case-insensitively and ignores surrounding space', () => {
  for (const status of ['code review', 'CODE REVIEW', '  In Review  ', 'in review']) {
    expect(classifyCard({ ...base, card: card({ status }), pr: null, cs: cs() }).bucket).toBe('waiting_review');
  }
});

test('a project that renamed the status configures it, and the stock names keep working', () => {
  const renamed: JiraStatuses = { ...statuses, review: 'Peer Review' };
  expect(classifyCard({ ...base, statuses: renamed, card: card({ status: 'Peer Review' }), pr: null, cs: cs() }).bucket).toBe('waiting_review');
  expect(classifyCard({ ...base, statuses: renamed, card: card({ status: 'Code Review' }), pr: null, cs: cs() }).bucket).toBe('waiting_review');
});

test('an unrelated in-flight status with no PR is still in_progress', () => {
  for (const status of ['In Progress', 'Reviewing the docs']) {
    expect(classifyCard({ ...base, card: card({ status }), pr: null, cs: cs() }).bucket).toBe('in_progress');
  }
});

test('isBlocked matches the status name case-insensitively, not the category', () => {
  expect(isBlocked(card({ status: 'Blocked', statusCategory: 'indeterminate' }), statuses)).toBe(true);
  for (const status of ['blocked', 'BLOCKED', '  Blocked  ']) {
    expect(isBlocked(card({ status }), statuses)).toBe(true);
  }
  expect(isBlocked(card({ status: 'In Progress' }), statuses)).toBe(false);
  expect(isBlocked(card({ status: 'On Hold' }), statuses)).toBe(false);
});

test('a project that renamed Blocked configures it, and the stock name keeps working', () => {
  const renamed: JiraStatuses = { ...statuses, blocked: 'On Hold' };
  expect(isBlocked(card({ status: 'On Hold' }), renamed)).toBe(true);
  expect(isBlocked(card({ status: 'Blocked' }), renamed)).toBe(false);
  expect(isBlocked(card({ status: 'Blocked' }), { todo: 'To Do', inTest: 'In Test', done: 'Done' })).toBe(true);
});

// #67: only isInReview normalized, so a project whose column read "in test"
// routed review case-insensitively and In Test not at all. Every status
// comparison now goes through sameStatus, so each gets its own re-cased case.
test('In Test matches case-insensitively and ignores surrounding space', () => {
  for (const status of ['in test', 'IN TEST', '  In Test  ']) {
    const c = card({ status, description: 'QA instructions: click it', fixVersions: ['1.0'] });
    expect(classifyCard({ ...base, card: c, pr: null, cs: cs() }).bucket).toBe('qa_ready');
    // The same comparison gates the merged-not-in-test attention reason and
    // the auto-clear of a stale override.
    expect(classifyCard({ ...base, card: c, pr: pr({ state: 'merged' }), cs: cs() }).attention).not.toContain('merged_not_in_test');
    const pinned = cs({ override: 'in_progress', lastStatus: status });
    classifyCard({ ...base, card: c, pr: null, cs: pinned });
    expect(pinned.override).toBeNull();
  }
});

test('Done, To Do and Canceled match case-insensitively and ignore surrounding space', () => {
  for (const status of ['done', 'DONE', '  Done  ']) expect(isDone(card({ status }), statuses)).toBe(true);
  for (const status of ['to do', 'TO DO', '  To Do  ']) expect(isTodo(card({ status }), statuses)).toBe(true);
  for (const status of ['canceled', 'CANCELED', '  Canceled  ']) {
    expect(isCanceled(card({ status }), statuses)).toBe(true);
    // Canceled sits in the Done category but is an abandonment, not a
    // completion — normalizing must not blur that.
    expect(isDone(card({ status }), statuses)).toBe(false);
  }
});

test('a project that re-cased its statuses in Jira still routes Done and merged-not-in-test', () => {
  const recased: JiraStatuses = { todo: 'to do', inTest: 'in test', done: 'done', canceled: 'canceled' };
  expect(isDone(card({ status: 'Done' }), recased)).toBe(true);
  expect(classifyCard({ ...base, statuses: recased, card: card({ status: 'In Progress' }), pr: pr({ state: 'merged' }), cs: cs() }).attention)
    .toContain('merged_not_in_test');
});

// sameStatus must not treat "both missing" as a match: a card with no status
// and a config with no canceled name are not the same status.
test('sameStatus never matches a blank or missing status', () => {
  expect(sameStatus(undefined, undefined)).toBe(false);
  expect(sameStatus('   ', '')).toBe(false);
  expect(sameStatus('Done', undefined)).toBe(false);
  expect(sameStatus(' Done ', 'done')).toBe(true);
});

// #53. Simon labels every PR it opens "Draft" (github.ts maps that label to
// isDraft), so its cards sit in Self Review Needed until the label comes off.
// Moving the Jira card to Code Review is the operator saying "I have reviewed
// this, it is out for peer review" — an explicit lifecycle statement that the
// draft rule used to outrank, leaving the card in Self Review Needed forever.
test('a draft PR whose card is in a review status -> waiting_review (#53)', () => {
  const draft = pr({ isDraft: true });
  expect(classifyCard({ ...base, card: card(), pr: draft, cs: cs() }).bucket).toBe('self_review');
  for (const status of ['Code Review', 'In Review', 'code review']) {
    expect(classifyCard({ ...base, card: card({ status }), pr: draft, cs: cs() }).bucket).toBe('waiting_review');
  }
});

// The review status is a lifecycle statement, not an override of blocked-or-
// broken: ROUTING_REASONS still evict the card (#42/#46), a pin still wins,
// and a draft never claims Mergeable — it cannot be merged as it stands.
test('a draft PR in a review status yields to routing reasons and pins, and never reads as mergeable', () => {
  const inReview = card({ status: 'Code Review' });
  expect(classifyCard({ ...base, card: inReview, pr: pr({ isDraft: true, ciStatus: 'failing' }), cs: cs() }).bucket).toBe('needs_attention');
  expect(classifyCard({ ...base, card: inReview, pr: pr({ isDraft: true }), cs: cs({ override: 'in_qa' }) }).bucket).toBe('in_qa');
  expect(classifyCard({ ...base, card: inReview, pr: pr({ isDraft: true, reviewState: 'approved' }), cs: cs() }).bucket).toBe('waiting_review');
});

// The exception is scoped to review statuses and nothing else: a draft PR on a
// card in any other status still routes to Self Review Needed exactly as before.
test('the #53 draft exception does not fire on a non-review status', () => {
  const c = card({ status: 'In Test', description: 'QA instructions: click it', fixVersions: ['1.0'] });
  expect(classifyCard({ ...base, card: c, pr: pr({ isDraft: true }), cs: cs() }).bucket).toBe('self_review');
});
