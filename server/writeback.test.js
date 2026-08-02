import { test, expect } from 'vitest';
import { buildAdfDoc, findTransition, checkWriteGate, performWrite } from './writeback.js';
import { emptyState } from './state.js';

test('buildAdfDoc wraps plain text in a minimal single-paragraph ADF doc', () => {
  expect(buildAdfDoc('hello world')).toEqual({
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
  });
});

test('findTransition matches to.name case-insensitively', () => {
  const transitions = [
    { id: '11', to: { name: 'In Progress' } },
    { id: '31', to: { name: 'Done' } },
  ];
  expect(findTransition(transitions, 'done')).toEqual({ id: '31', to: { name: 'Done' } });
  expect(findTransition(transitions, 'DONE')).toEqual({ id: '31', to: { name: 'Done' } });
});

test('findTransition throws and lists available names when there is no match', () => {
  const transitions = [{ id: '11', to: { name: 'In Progress' } }, { id: '21', to: { name: 'In Review' } }];
  expect(() => findTransition(transitions, 'Done')).toThrow(/no transition to "Done"/);
  expect(() => findTransition(transitions, 'Done')).toThrow(/In Progress, In Review/);
});

test('findTransition lists "(none)" when there are no transitions at all', () => {
  expect(() => findTransition([], 'Done')).toThrow(/\(none\)/);
});

test('checkWriteGate: demo mode always blocks with a demo-shaped (non-error) refusal', () => {
  expect(checkWriteGate({ demo: true, writeEnabled: true })).toEqual({
    blocked: true, demo: true, message: 'demo mode: write-back is a no-op (nothing real to write to)',
  });
  // Even with writeEnabled: false too — demo wins regardless of the flag.
  expect(checkWriteGate({ demo: true, writeEnabled: false }).demo).toBe(true);
});

test('checkWriteGate: writeEnabled false (non-demo) blocks with a real refusal', () => {
  expect(checkWriteGate({ demo: false, writeEnabled: false })).toEqual({
    blocked: true, demo: false, message: 'write-back disabled; set writeEnabled: true in config.json',
  });
});

test('checkWriteGate: writeEnabled true and not demo is unblocked', () => {
  expect(checkWriteGate({ demo: false, writeEnabled: true })).toEqual({ blocked: false });
});

test('performWrite rejects an unknown type before touching the gate', async () => {
  const result = await performWrite({ config: { demo: false, writeEnabled: false }, state: emptyState(), type: 'delete' });
  expect(result).toEqual({ error: 'unknown write type "delete"', status: 400 });
});

test('performWrite validates required fields per type', async () => {
  const config = { demo: false, writeEnabled: true };
  const state = emptyState();
  expect(await performWrite({ config, state, type: 'transition', key: 'P-1' })).toEqual({ error: 'transition requires key and status', status: 400 });
  expect(await performWrite({ config, state, type: 'comment', key: 'P-1' })).toEqual({ error: 'comment requires key and body', status: 400 });
  expect(await performWrite({ config, state, type: 'pr_comment', repo: 'o/r' })).toEqual({ error: 'pr_comment requires repo, number, and body', status: 400 });
});

test('performWrite: demo mode returns a stub success shape without dispatching a network write', async () => {
  const config = { demo: true, writeEnabled: false, jira: {}, github: {} };
  const result = await performWrite({ config, state: emptyState(), type: 'transition', key: 'P-1', status: 'Done' });
  expect(result).toEqual({ ok: true, demo: true, message: 'demo mode: write-back is a no-op (nothing real to write to)' });
});

test('performWrite: writeEnabled false (non-demo) refuses with a real error, not a stub', async () => {
  const config = { demo: false, writeEnabled: false };
  const result = await performWrite({ config, state: emptyState(), type: 'comment', key: 'P-1', body: 'hi' });
  expect(result).toEqual({ error: 'write-back disabled; set writeEnabled: true in config.json', status: 403 });
});
