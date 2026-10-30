import { test, expect } from 'vitest';
import { REASONS, QUEUE_REASONS, ROUTING_REASONS, STATE_REASONS, PR_ACK_REASONS } from './reasons.ts';
import { classifyCard, routeBucket } from './classify.ts';
import { applyAction } from './actions.ts';
import { emptyState, emptySnapshot, cardState } from './state.ts';
import type { Card, Config, Item, Pr } from './types.ts';

// The derived lists must equal what the hand-kept ones were (audit M19
// refactor): a change here is a behavior change, not a cleanup.
test('the reason table derives the same lists the code used before', () => {
  expect(QUEUE_REASONS).toEqual(['ci_failing', 'changes_requested', 'review_requested', 'new_pr_comments', 'new_jira_comments', 'merged_not_in_test', 'ready_to_merge', 'missing_qa_instructions', 'missing_fix_version']);
  expect(ROUTING_REASONS).toEqual(['ci_failing', 'merged_not_in_test']);
  expect([...STATE_REASONS].sort()).toEqual(['changes_requested', 'ci_failing', 'merged_not_in_test', 'missing_fix_version', 'missing_qa_instructions', 'ready_to_merge']);
  expect(PR_ACK_REASONS).toEqual(['ci_failing', 'changes_requested', 'ready_to_merge']);
  expect(Object.fromEntries(Object.entries(REASONS).map(([k, v]) => [k, v.priority]))).toEqual({
    ci_failing: 1, changes_requested: 1, review_requested: 2, new_pr_comments: 2, new_jira_comments: 2,
    merged_not_in_test: 2, ready_to_merge: 3, missing_qa_instructions: 3, missing_fix_version: 3,
  });
});

// Audit M16: actions.ts used to hand-copy the classifier's ladder and apply
// a pin with `override ?? dest`, so a pinned card with an open draft PR
// went to its pin after an ack while the next refresh put it in self_review.
test('an ack routes a card exactly where the next refresh would (draft PR outranks a pin)', () => {
  const statuses = { todo: 'To Do', inTest: 'In Test', done: 'Done' };
  const config: Config = { jira: { projectKey: 'P', accountId: 'me', statuses }, github: { username: 'u', org: 'o', token: '', repos: [] }, port: 0, demo: false, writeEnabled: false };
  const draft = { repo: 'o/r', number: 1, url: '', branch: 'b', state: 'open' as const, ciStatus: 'failing' as const, reviewState: 'none' as const, isDraft: true };
  const item: Item = { key: 'P-1', summary: '', jiraStatus: 'In Progress', jiraUrl: '', bucket: 'needs_attention', attention: ['ci_failing'], newComments: [], comments: [], pr: draft, createdAt: null, updatedAt: null, daysSinceActivity: null, pinned: true, pinnedAt: null };
  const state = emptyState();
  state.snapshot = { ...emptySnapshot(), updatedAt: '2026-07-10T00:00:00Z' };
  state.snapshot.buckets.needs_attention.push(item);
  cardState(state, 'P-1').override = 'in_qa';
  const acked = applyAction({ state, config, type: 'ack', key: 'P-1' });

  const card: Card = { key: 'P-1', summary: '', status: 'In Progress', description: '', url: '', createdAt: null, updatedAt: null, myAccountId: 'me', comments: [] };
  const pr: Pr = { ...draft, title: '', body: '', createdAt: '', updatedAt: '', mergedAt: null, closedAt: null, comments: [] };
  const next = classifyCard({ card, pr, cs: cardState(state, 'P-1'), statuses, username: 'u' });
  expect(acked).toEqual({ ok: true, bucket: next.bucket });
  expect(next.bucket).toBe('self_review');
  expect(routeBucket({ status: 'In Progress', pr: draft, visible: [], override: 'in_qa', statuses })).toBe('self_review');
});
