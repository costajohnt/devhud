// The local API token (audit M3) and the MCP write gate (audit M4).
import { test, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from './index.ts';
import { saveState, emptyState } from './state.ts';
import { loadOrCreateApiToken, readApiToken, apiTokenPath, probeServer } from './transport.ts';
import { run } from './cli.ts';
import { performWrite } from './writeback.ts';
import type { Config } from './types.ts';

const config: Config = {
  port: 0, demo: false, writeEnabled: false,
  jira: { projectKey: 'PROJ', accountId: 'id', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
  github: { username: 'u', org: 'o', token: '', repos: [] },
};

let server: http.Server | undefined;
afterEach(() => { server?.close(); server = undefined; vi.unstubAllGlobals(); });

async function start(apiToken?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'devhud-auth-'));
  const statePath = join(dir, 'data', 'state.json');
  saveState(statePath, emptyState());
  const webDist = join(dir, 'dist');
  mkdirSync(join(webDist, 'assets'), { recursive: true });
  writeFileSync(join(webDist, 'index.html'), '<html><title>devhud</title>app</html>');
  writeFileSync(join(webDist, 'assets', 'app.js'), 'console.log(1)');
  const token = apiToken ?? loadOrCreateApiToken(statePath);
  server = createServer({ config: { ...config }, statePath, webDist, apiToken: token });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
  const port = (server!.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port, token, statePath };
}

test('the token file is created 0600 once and reused', () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'devhud-tok-')), 'data', 'state.json');
  const a = loadOrCreateApiToken(statePath);
  expect(a).toMatch(/^[\w-]{40,}$/);
  expect(statSync(apiTokenPath(statePath)).mode & 0o777).toBe(0o600);
  expect(loadOrCreateApiToken(statePath)).toBe(a);
  expect(readApiToken(statePath)).toBe(a);
});

test('/api/* needs the token header (or a session cookie, see below)', async () => {
  const { base, token } = await start();
  expect((await fetch(`${base}/api/data`)).status).toBe(401);
  expect((await fetch(`${base}/api/data`, { headers: { 'x-devhud-token': 'wrong' } })).status).toBe(401);
  expect((await fetch(`${base}/api/data`, { headers: { 'x-devhud-token': token } })).status).toBe(200);
  // The cookie carries a session value, never the API token itself.
  expect((await fetch(`${base}/api/data`, { headers: { cookie: `other=1; devhud_token=${token}` } })).status).toBe(401);
  expect((await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  // The Host guard still runs first.
  const { request } = await import('node:http');
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: new URL(base).port, path: '/api/data', headers: { host: 'evil.example.com', 'x-devhud-token': token } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  expect(status).toBe(403);
});

test('the dashboard page needs a session; assets do not; a one-time login code creates one', async () => {
  const { base, token } = await start();
  const gate = await fetch(`${base}/`);
  expect(gate.status).toBe(401);
  expect(await gate.text()).toContain('devhud open');
  expect((await fetch(`${base}/assets/app.js`)).status).toBe(200);
  // The raw token is never accepted in a URL.
  expect((await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })).status).toBe(401);
  // Login codes are minted only with the token header.
  expect((await fetch(`${base}/api/login-code`, { method: 'POST' })).status).toBe(401);
  const mint = () => fetch(`${base}/api/login-code`, { method: 'POST', headers: { 'x-devhud-token': token } }).then(r => r.json() as Promise<{ code: string }>);
  const { code } = await mint();

  const opened = await fetch(`${base}/?login=${encodeURIComponent(code)}`, { redirect: 'manual' });
  expect(opened.status).toBe(302);
  expect(opened.headers.get('location')).toBe('/');
  const cookie = opened.headers.get('set-cookie') ?? '';
  expect(cookie).toMatch(/^devhud_token=[\w-]+; HttpOnly; SameSite=Strict; Path=\//);
  const session = cookie.split(';')[0]!;
  // The session is its own value, not the API token.
  expect(session).not.toContain(token);
  const page = await fetch(`${base}/`, { headers: { cookie: session } });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('app');
  expect((await fetch(`${base}/api/data`, { headers: { cookie: session } })).status).toBe(200);
  // Single use: the same code can't make a second session.
  expect((await fetch(`${base}/?login=${encodeURIComponent(code)}`, { redirect: 'manual' })).status).toBe(401);
});

test('login codes expire after a minute', async () => {
  const { base, token } = await start();
  const { code } = await fetch(`${base}/api/login-code`, { method: 'POST', headers: { 'x-devhud-token': token } }).then(r => r.json() as Promise<{ code: string }>);
  const realNow = Date.now;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);
  try {
    expect((await fetch(`${base}/?login=${encodeURIComponent(code)}`, { redirect: 'manual' })).status).toBe(401);
  } finally {
    vi.restoreAllMocks();
  }
});

test('the CLI reads the token from next to the state file and goes via the server', async () => {
  const { port, statePath } = await start();
  expect(await probeServer(port, { timeoutMs: 5000 })).toBe(false);
  expect(await probeServer(port, { timeoutMs: 5000, token: readApiToken(statePath) })).toBe(true);
  const r = await run(['status', '--json'], { config: { ...config, port }, statePath, probeTimeoutMs: 5000 });
  expect(r.err).toBe('via server');
  expect(r.code).toBe(0);
});

// M4: an MCP write needs mcpWriteEnabled as well as writeEnabled.
test('MCP-sourced writes need mcpWriteEnabled; CLI writes need only writeEnabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devhud-mcpw-'));
  const base = { jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' }, github: { org: 'o', repos: ['r'], username: 'u' }, writeEnabled: true };
  const write = (mcpWriteEnabled: boolean, source?: 'mcp') => {
    const configPath = join(dir, `c-${mcpWriteEnabled}-${source ?? 'cli'}.json`);
    writeFileSync(configPath, JSON.stringify({ ...base, mcpWriteEnabled }));
    return performWrite({ config: {}, state: emptyState(), type: 'comment', key: 'PROJ-1', body: 'hi', configPath, source, refreshFn: (async () => emptyState().snapshot) as never });
  };
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ id: 'c1' }), { status: 201, headers: { 'content-type': 'application/json' } }))));
  expect(await write(false, 'mcp')).toMatchObject({ status: 403, error: expect.stringMatching(/mcpWriteEnabled/) });
  expect(await write(true, 'mcp')).toMatchObject({ ok: true });
  expect(await write(false)).toMatchObject({ ok: true });
});
