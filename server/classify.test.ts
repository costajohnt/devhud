import { test, expect } from 'vitest';
import { classifyCard, isTodo, isDone, isCanceled } from './classify.ts';
import type { Card, Pr, CardState, JiraStatuses } from './types.ts';

const statuses: JiraStatuses = { todo: 'To Do', inTest: 'In Test', done: 'Done', canceled: 'Canceled' };
const base = { username: 'john', statuses };
const card = (o: Partial<Card> = {}): Card => ({ key: 'P-1', status: 'In Progress', myAccountId: 'me', comments: [], summary: '', description: '', url: '', createdAt: null, updatedAt: null, ...o });
const pr = (o: Partial<Pr> = {}): Pr => ({ state: 'open', ciStatus: 'passing', reviewState: 'none', comments: [], repo: 'o/r', number: 1, url: '', title: '', body: '', branch: '', createdAt: '', updatedAt: '', mergedAt: null, ...o });
const cs = (o: Partial<CardState> = {}): CardState => ({ lastSeenPr: '2026-07-01T00:00:00Z', lastSeenJira: '2026-07-01T00:00:00Z', override: null, overrideAt: null, ...o });

test('ci failing -> needs_attention', () => {
  const r = classifyCard({ ...base, card: card(), pr: pr({ ciStatus: 'failing' }), cs: cs() });
  expect(r.bucket).toBe('needs_attention');
  expect(r.attention).toContain('ci_failing');
});

test('new PR comment by someone else -> needs_attention, own comment ignored', () => {
  const others = pr({ comments: [{ author: 'reviewer', body: 'x', createdAt: '2026-07-02T00:00:00Z' }] });
  expect(classifyCard({ ...base, card: card(), pr: others, cs: cs() }).bucket).toBe('needs_attention');
  const mine = pr({ comments: [{ author: 'john', body: 'x', createdAt: '2026-07-02T00:00:00Z' }] });
  expect(classifyCard({ ...base, card: card(), pr: mine, cs: cs() }).bucket).toBe('self_review');
});

test('merged but not In Test -> needs_attention; merged and In Test -> qa_ready', () => {
  const m = pr({ state: 'merged' });
  expect(classifyCard({ ...base, card: card(), pr: m, cs: cs() }).attention).toContain('merged_not_in_test');
  expect(classifyCard({ ...base, card: card({ status: 'In Test' }), pr: m, cs: cs() }).bucket).toBe('qa_ready');
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

test('new comment still triggers attention while a state-based reason is acked', () => {
  const m = pr({ state: 'merged', comments: [{ author: 'reviewer', body: 'x', createdAt: '2026-07-02T00:00:00Z' }] });
  const r = classifyCard({ ...base, card: card(), pr: m, cs: cs({ ackedReasons: ['merged_not_in_test'] }) });
  expect(r.bucket).toBe('needs_attention');
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
  const r = classifyCard({ ...base, card: card({ status: 'In Test' }), pr: pr({ state: 'merged' }), cs: s });
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

test('junk (comment-reason) entries in ackedReasons are dropped, never muting comment attention', () => {
  const c = cs({ ackedReasons: ['new_pr_comments'] });
  const p = pr({ comments: [{ author: 'reviewer', body: 'x', createdAt: '2026-07-02T00:00:00Z' }] });
  const r = classifyCard({ ...base, card: card(), pr: p, cs: c });
  expect(r.bucket).toBe('needs_attention');
  expect(c.ackedReasons).toBeNull();
});
