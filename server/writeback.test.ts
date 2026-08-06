import { test, expect, vi, afterEach } from 'vitest';
import { buildAdfDoc, findTransition, checkWriteGate, performWrite, transitionCard, commentCard, commentPr } from './writeback.ts';
import { emptyState } from './state.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config, JiraConfig, GithubConfig } from './types.ts';

afterEach(() => vi.unstubAllGlobals());

// performWrite re-reads config from disk on every write and now fails
// CLOSED if that re-read throws (see the fail-closed test below) — so tests
// that aren't specifically exercising the disk re-read itself stub
// loadConfigFn to hand back the in-memory config directly, sidestepping the
// filesystem (and any real config.json that might happen to sit in the
// repo root) entirely.
const NO_CONFIG = '/nonexistent/writeback-test-config.json';
const stubLoadConfig = (cfg: unknown) => () => cfg as Config;

// performWrite's return type is a discriminated union; these tests probe
// every branch (success, demo stub, and every error shape), so assertions
// go through this loose shape rather than narrowing at each call site.
interface LooseWrite {
  ok?: boolean;
  demo?: boolean;
  message?: string;
  error?: string;
  status?: number;
  refreshError?: string;
  transitionedTo?: string;
}

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
  const result = await performWrite({ config, state: emptyState(), type: 'pr_comment', repo: 'not-a-repo', number: 1, body: 'hi', configPath: NO_CONFIG }) as LooseWrite;
  expect(result.status).toBe(400);
  expect(result.error).toContain('invalid repo');
});

test('performWrite rejects a non-integer PR number for pr_comment', async () => {
  const config = { demo: false, writeEnabled: true };
  const result = await performWrite({ config, state: emptyState(), type: 'pr_comment', repo: 'o/r', number: '1; rm -rf' as unknown as number, body: 'hi', configPath: NO_CONFIG }) as LooseWrite;
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
  const result = await performWrite({ config, state: emptyState(), type: 'comment', key: 'P-1', body: 'hi', configPath: NO_CONFIG }) as LooseWrite;
  expect(result.status).toBe(403);
  expect(result.error).toContain('config re-read failed');
  expect(result.error).toContain('refusing write');
  expect(result.ok).toBeUndefined();
});

test('performWrite: a successful write with a failing post-write refresh is still ok:true, with refreshError set', async () => {
  const config = { demo: false, writeEnabled: true, jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'P' } };
  const fetchMock = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  const originalFetch = global.fetch;
  global.fetch = fetchMock;
  try {
    const result = await performWrite({
      config, state: emptyState(), type: 'comment', key: 'P-1', body: 'hi',
      refreshFn: () => { throw new Error('jira down mid-refresh'); },
      loadConfigFn: stubLoadConfig(config),
    }) as LooseWrite;
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.refreshError).toBe('jira down mid-refresh');
  } finally {
    global.fetch = originalFetch;
  }
});

// transitionCard/commentCard/commentPr are the only mutation code in the
// app — the actual functions that construct and send the Jira/GitHub
// write-back requests. Previously untested beyond performWrite's gate/
// validation layer ahead of the dispatch; these assert the real request
// shape (URL, method, body) and the non-2xx error branch.

test('transitionCard GETs the transitions list, matches the target status case-insensitively, then POSTs the matched id', async () => {
  const calls: { url: string; method?: string; body?: string }[] = [];
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body as string | undefined });
    if (!init?.method) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ transitions: [
        { id: '11', to: { name: 'In Progress' } },
        { id: '31', to: { name: 'Done' } },
      ] }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: JiraConfig = { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } };

  const result = await transitionCard(cfg, 'PROJ-1', 'done');

  expect(result).toEqual({ transitionedTo: 'Done' });
  expect(calls).toHaveLength(2);
  expect(calls[0]!.url).toBe('https://x.atlassian.net/rest/api/3/issue/PROJ-1/transitions');
  expect(calls[0]!.method).toBeUndefined(); // GET (no method = GET)
  expect(calls[1]!.url).toBe('https://x.atlassian.net/rest/api/3/issue/PROJ-1/transitions');
  expect(calls[1]!.method).toBe('POST');
  expect(JSON.parse(calls[1]!.body!)).toEqual({ transition: { id: '31' } });
});

test('transitionCard throws (no POST attempted) when no transition matches the target status', async () => {
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ transitions: [
    { id: '11', to: { name: 'In Progress' } },
  ] }) }));
  vi.stubGlobal('fetch', fetchMock);
  const cfg: JiraConfig = { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } };
  await expect(transitionCard(cfg, 'PROJ-1', 'Done')).rejects.toThrow(/no transition to "Done"/);
  expect(fetchMock).toHaveBeenCalledTimes(1); // only the GET, never a POST
});

test('transitionCard throws on a non-2xx GET (transitions list fetch failure)', async () => {
  const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('not found') }));
  vi.stubGlobal('fetch', fetchMock);
  const cfg: JiraConfig = { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } };
  await expect(transitionCard(cfg, 'PROJ-1', 'Done')).rejects.toThrow(/Jira 404/);
});

test('transitionCard throws on a non-2xx POST (the transition itself rejected)', async () => {
  const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
    if (!init?.method) return Promise.resolve({ ok: true, json: () => Promise.resolve({ transitions: [{ id: '31', to: { name: 'Done' } }] }) });
    return Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve('bad transition') });
  });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: JiraConfig = { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } };
  await expect(transitionCard(cfg, 'PROJ-1', 'Done')).rejects.toThrow(/Jira 400/);
});

test('commentCard POSTs the body wrapped in an ADF doc to the comment endpoint', async () => {
  let capturedUrl = '', capturedBody = '';
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = init?.body as string;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: JiraConfig = { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } };

  await commentCard(cfg, 'PROJ-1', 'looks good');

  expect(capturedUrl).toBe('https://x.atlassian.net/rest/api/3/issue/PROJ-1/comment');
  expect(JSON.parse(capturedBody)).toEqual({ body: buildAdfDoc('looks good') });
});

test('commentCard throws on a non-2xx response', async () => {
  const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve('forbidden') }));
  vi.stubGlobal('fetch', fetchMock);
  const cfg: JiraConfig = { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } };
  await expect(commentCard(cfg, 'PROJ-1', 'hi')).rejects.toThrow(/Jira 403/);
});

test('commentPr POSTs the plain-text body to the GitHub issue-comments endpoint', async () => {
  let capturedUrl = '', capturedBody = '', capturedAuth = '';
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = init?.body as string;
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? '';
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  const cfg: GithubConfig = { token: 'ghtoken', org: 'acme', repos: [], username: 'me' };

  await commentPr(cfg, 'acme/webapp', 482, 'nice work');

  expect(capturedUrl).toBe('https://api.github.com/repos/acme/webapp/issues/482/comments');
  expect(JSON.parse(capturedBody)).toEqual({ body: 'nice work' });
  expect(capturedAuth).toBe('Bearer ghtoken');
});

test('commentPr throws on a non-2xx response', async () => {
  const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 422, text: () => Promise.resolve('unprocessable') }));
  vi.stubGlobal('fetch', fetchMock);
  const cfg: GithubConfig = { token: 't', org: 'acme', repos: [], username: 'me' };
  await expect(commentPr(cfg, 'acme/webapp', 482, 'hi')).rejects.toThrow(/GitHub 422/);
});

// --- write scope: shape-valid targets outside the configured project/repos ---

const scopedConfig = {
  demo: false, writeEnabled: true,
  jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
  github: { token: 't', org: 'o', repos: ['r'], username: 'u' },
};

test('performWrite refuses a well-formed Jira key outside the configured project', async () => {
  const result = await performWrite({
    config: scopedConfig, state: emptyState(), type: 'comment', key: 'OTHER-1', body: 'hi',
    loadConfigFn: stubLoadConfig(scopedConfig),
  }) as LooseWrite;
  expect(result.status).toBe(403);
  expect(result.error).toContain('outside the configured project PROJ');
});

test('performWrite refuses a well-formed repo not in the configured github.repos list', async () => {
  const result = await performWrite({
    config: scopedConfig, state: emptyState(), type: 'pr_comment', repo: 'o/not-mine', number: 1, body: 'hi',
    loadConfigFn: stubLoadConfig(scopedConfig),
  }) as LooseWrite;
  expect(result.status).toBe(403);
  expect(result.error).toContain('not in the configured github.repos list');
});

test('performWrite allows in-scope targets through the scope check', async () => {
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
  vi.stubGlobal('fetch', fetchMock);
  const result = await performWrite({
    config: scopedConfig, state: emptyState(), type: 'pr_comment', repo: 'o/r', number: 1, body: 'hi',
    loadConfigFn: stubLoadConfig(scopedConfig),
    refreshFn: (async ({ state: s }: { state: { snapshot: unknown } }) => s.snapshot) as never,
  }) as LooseWrite;
  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
});
