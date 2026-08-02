import { test, expect } from 'vitest';
import { classifyCard, isTodo } from './classify.js';

const statuses = { todo: 'To Do', inTest: 'In Test', done: 'Done' };
const base = { username: 'john', statuses };
const card = (o) => ({ key: 'P-1', status: 'In Progress', myAccountId: 'me', comments: [], ...o });
const pr = (o) => ({ state: 'open', ciStatus: 'passing', reviewState: 'none', comments: [], ...o });
const cs = (o) => ({ lastSeenPr: '2026-07-01T00:00:00Z', lastSeenJira: '2026-07-01T00:00:00Z', override: null, ...o });

test('ci failing -> needs_attention', () => {
  const r = classifyCard({ ...base, card: card(), pr: pr({ ciStatus: 'failing' }), cs: cs() });
  expect(r.bucket).toBe('needs_attention');
  expect(r.attention).toContain('ci_failing');
});

test('new PR comment by someone else -> needs_attention, own comment ignored', () => {
  const others = pr({ comments: [{ author: 'reviewer', body: 'x', createdAt: '2026-07-02T00:00:00Z' }] });
  expect(classifyCard({ ...base, card: card(), pr: others, cs: cs() }).bucket).toBe('needs_attention');
  const mine = pr({ comments: [{ author: 'john', body: 'x', createdAt: '2026-07-02T00:00:00Z' }] });
  expect(classifyCard({ ...base, card: card(), pr: mine, cs: cs() }).bucket).toBe('in_progress');
});

test('merged but not In Test -> needs_attention; merged and In Test -> in_qa', () => {
  const m = pr({ state: 'merged' });
  expect(classifyCard({ ...base, card: card(), pr: m, cs: cs() }).attention).toContain('merged_not_in_test');
  expect(classifyCard({ ...base, card: card({ status: 'In Test' }), pr: m, cs: cs() }).bucket).toBe('in_qa');
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

test('new jira comment by someone else since lastSeenJira', () => {
  const c = card({ comments: [{ authorId: 'other', body: 'x', createdAt: '2026-07-02T00:00:00Z' }] });
  const r = classifyCard({ ...base, card: c, pr: null, cs: cs() });
  expect(r.attention).toContain('new_jira_comments');
  expect(r.newComments[0].source).toBe('jira');
});
