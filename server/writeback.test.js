import { test, expect } from 'vitest';
import { buildAdfDoc, findTransition, checkWriteGate, performWrite } from './writeback.js';
import { emptyState } from './state.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// performWrite re-reads config from disk on every write and now fails
// CLOSED if that re-read throws (see the fail-closed test below) — so tests
// that aren't specifically exercising the disk re-read itself stub
// loadConfigFn to hand back the in-memory config directly, sidestepping the
// filesystem (and any real config.json that might happen to sit in the
// repo root) entirely.
const NO_CONFIG = '/nonexistent/writeback-test-config.json';
const stubLoadConfig = (cfg) => () => cfg;

test('buildAdfDoc wraps plain text in a minimal single-paragraph ADF doc', () => {
  expect(buildAdfDoc('hello world')).toEqual({
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
  });
});

test('buildAdfDoc splits blank-line-separated text into multiple paragraph nodes', () => {
  const doc = buildAdfDoc('First paragraph.\n\nSecond paragraph.');
  expect(doc.content).toEqual([
    { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph.' }] },
  ]);
});

test('buildAdfDoc turns a single newline into a hardBreak within one paragraph', () => {
  const doc = buildAdfDoc('Line one.\nLine two.');
  expect(doc.content).toEqual([
    { type: 'paragraph', content: [
      { type: 'text', text: 'Line one.' },
      { type: 'hardBreak' },
      { type: 'text', text: 'Line two.' },
    ] },
  ]);
});

test('buildAdfDoc normalizes \\r\\n (Windows line endings) the same as \\n — no stray \\r in any text node', () => {
  const doc = buildAdfDoc('Line one.\r\nLine two.\r\n\r\nSecond paragraph.');
  expect(doc.content).toEqual([
    { type: 'paragraph', content: [
      { type: 'text', text: 'Line one.' },
      { type: 'hardBreak' },
      { type: 'text', text: 'Line two.' },
    ] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph.' }] },
  ]);
  const textNodes = doc.content.flatMap(p => p.content).filter(n => n.type === 'text');
  for (const node of textNodes) {
    expect(node.text).not.toContain('\r');
  }
});

test('buildAdfDoc: no text node in the output ever contains a literal newline', () => {
  const doc = buildAdfDoc('a\nb\n\nc\nd\n\n\ne');
  const textNodes = doc.content.flatMap(p => p.content).filter(n => n.type === 'text');
  expect(textNodes.length).toBeGreaterThan(0);
  for (const node of textNodes) {
    expect(node.text).not.toContain('\n');
  }
});

test('buildAdfDoc collapses 3+ consecutive newlines to a single paragraph break (no empty paragraphs)', () => {
  const doc = buildAdfDoc('a\n\n\nb');
  expect(doc.content).toEqual([
    { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
  ]);
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
  expect(await performWrite({ config, state, type: 'transition', key: 'P-1', configPath: NO_CONFIG })).toEqual({ error: 'transition requires key and status', status: 400 });
  expect(await performWrite({ config, state, type: 'comment', key: 'P-1', configPath: NO_CONFIG })).toEqual({ error: 'comment requires key and body', status: 400 });
  expect(await performWrite({ config, state, type: 'pr_comment', repo: 'o/r', configPath: NO_CONFIG })).toEqual({ error: 'pr_comment requires repo, number, and body', status: 400 });
});

test('performWrite: demo mode returns a stub success shape without dispatching a network write', async () => {
  const config = { demo: true, writeEnabled: false, jira: {}, github: {} };
  const result = await performWrite({ config, state: emptyState(), type: 'transition', key: 'P-1', status: 'Done', loadConfigFn: stubLoadConfig(config) });
  expect(result).toEqual({ ok: true, demo: true, message: 'demo mode: write-back is a no-op (nothing real to write to)' });
});

test('performWrite: writeEnabled false (non-demo) refuses with a real error, not a stub', async () => {
  const config = { demo: false, writeEnabled: false };
  const result = await performWrite({ config, state: emptyState(), type: 'comment', key: 'P-1', body: 'hi', loadConfigFn: stubLoadConfig(config) });
  expect(result).toEqual({ error: 'write-back disabled; set writeEnabled: true in config.json', status: 403 });
});

test('performWrite rejects a Jira key that looks like a path-traversal attempt', async () => {
  const config = { demo: false, writeEnabled: true };
  const result = await performWrite({ config, state: emptyState(), type: 'comment', key: 'PROJ-1/../x', body: 'hi', configPath: NO_CONFIG });
  expect(result).toEqual({ error: 'invalid Jira issue key "PROJ-1/../x"', status: 400 });
});

test('performWrite rejects a malformed repo for pr_comment', async () => {
  const config = { demo: false, writeEnabled: true };
  const result = await performWrite({ config, state: emptyState(), type: 'pr_comment', repo: 'not-a-repo', number: 1, body: 'hi', configPath: NO_CONFIG });
  expect(result.status).toBe(400);
  expect(result.error).toContain('invalid repo');
});

test('performWrite rejects a non-integer PR number for pr_comment', async () => {
  const config = { demo: false, writeEnabled: true };
  const result = await performWrite({ config, state: emptyState(), type: 'pr_comment', repo: 'o/r', number: '1; rm -rf', body: 'hi', configPath: NO_CONFIG });
  expect(result.status).toBe(400);
});

test('performWrite re-reads the gate from disk: an in-memory config claiming writeEnabled honors a config.json flip to false, no restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-writeback-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
    writeEnabled: false, // the on-disk truth
  }));
  // The in-memory config a long-lived process loaded before the file was
  // edited — stale, claims writeEnabled: true.
  const staleInMemoryConfig = { demo: false, writeEnabled: true, jira: {}, github: {} };
  const result = await performWrite({
    config: staleInMemoryConfig, state: emptyState(), type: 'comment', key: 'P-1', body: 'hi', configPath,
  });
  expect(result).toEqual({ error: 'write-back disabled; set writeEnabled: true in config.json', status: 403 });
});

test('performWrite fails CLOSED when the config re-read throws, even if the in-memory config would have allowed the write', async () => {
  // In-memory config says writes are allowed — but that must not matter:
  // if the on-disk config can't be read (deleted, permissions, mid-edit),
  // the write must refuse, not silently trust a possibly-stale in-memory
  // config. This is what stops a long-running process from continuing to
  // write after config.json is deleted or made briefly unreadable.
  const config = { demo: false, writeEnabled: true, jira: {}, github: {} };
  const result = await performWrite({ config, state: emptyState(), type: 'comment', key: 'P-1', body: 'hi', configPath: NO_CONFIG });
  expect(result.status).toBe(403);
  expect(result.error).toContain('config re-read failed');
  expect(result.error).toContain('refusing write');
  expect(result.ok).toBeUndefined();
});

test('performWrite: a successful write with a failing post-write refresh is still ok:true, with refreshError set', async () => {
  const config = { demo: false, writeEnabled: true, jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't' } };
  const fetchMock = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  const originalFetch = global.fetch;
  global.fetch = fetchMock;
  try {
    const result = await performWrite({
      config, state: emptyState(), type: 'comment', key: 'P-1', body: 'hi',
      refreshFn: () => { throw new Error('jira down mid-refresh'); },
      loadConfigFn: stubLoadConfig(config),
    });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.refreshError).toBe('jira down mid-refresh');
  } finally {
    global.fetch = originalFetch;
  }
});
