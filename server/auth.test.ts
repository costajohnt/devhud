// The local API token (audit M3) and the MCP write gate (audit M4).
import { test, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from './index.ts';
import { saveState, emptyState } from './state.ts';
import { newApiToken, writeApiToken, readApiToken, apiTokenPath, probeServer } from './transport.ts';
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
  const token = apiToken ?? newApiToken();
  writeApiToken(statePath, token);
  server = createServer({ config: { ...config }, statePath, webDist, apiToken: token });
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
  const port = (server!.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port, token, statePath };
}

test('the token file is written 0600 and read back', () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'devhud-tok-')), 'data', 'state.json');
  const a = newApiToken();
  expect(a).toMatch(/^[\w-]{40,}$/);
  expect(newApiToken()).not.toBe(a);
  writeApiToken(statePath, a);
  expect(statSync(apiTokenPath(statePath)).mode & 0o777).toBe(0o600);
  expect(readApiToken(statePath)).toBe(a);
});

test('/api/* needs the token header (or a session cookie, see below)', async () => {
  const { base, token } = await start();
  expect((await fetch(`${base}/api/data`)).status).toBe(401);
  expect((await fetch(`${base}/api/data`, { headers: { 'x-devhud-token': 'wrong' } })).status).toBe(401);
  expect((await fetch(`${base}/api/data`, { headers: { 'x-devhud-token': token } })).status).toBe(200);
  // Not a cookie: cookies are not credentials here at all.
  expect((await fetch(`${base}/api/data`, { headers: { cookie: `devhud_token=${token}` } })).status).toBe(401);
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

const mintCode = (base: string, token: string) =>
  fetch(`${base}/api/login-code`, { method: 'POST', headers: { 'x-devhud-token': token } }).then(r => r.json() as Promise<{ code: string }>).then(j => j.code);
const claim = (base: string, code: string) =>
  fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });

// PR #140 review: a cookie is sent to every port on localhost, so a session
// cookie leaked to any local service the browser visited. Sessions are now
// a header (the page keeps them in per-origin localStorage), never a cookie.
test('a one-time login code becomes a header session; nothing is set as a cookie', async () => {
  const { base, token } = await start();
  // The page itself and assets carry no data: always served.
  expect((await fetch(`${base}/`)).status).toBe(200);
  expect((await fetch(`${base}/assets/app.js`)).status).toBe(200);
  // Login codes: token header only.
  expect((await fetch(`${base}/api/login-code`, { method: 'POST' })).status).toBe(401);
  const code = await mintCode(base, token);
  const r = await claim(base, code);
  expect(r.status).toBe(200);
  expect(r.headers.get('set-cookie')).toBeNull();
  const { session } = await r.json() as { session: string };
  expect(session).not.toBe(token);
  expect((await fetch(`${base}/api/data`, { headers: { 'x-devhud-session': session } })).status).toBe(200);
  // EventSource can't set headers: the stream (and only the stream) takes it as a query.
  const ev = await fetch(`${base}/api/events?session=${encodeURIComponent(session)}`);
  expect(ev.status).toBe(200);
  await ev.body?.cancel();
  expect((await fetch(`${base}/api/data?session=${encodeURIComponent(session)}`)).status).toBe(401);
  // A session can't mint codes; a cookie is not a credential at all.
  expect((await fetch(`${base}/api/login-code`, { method: 'POST', headers: { 'x-devhud-session': session } })).status).toBe(401);
  expect((await fetch(`${base}/api/data`, { headers: { cookie: `devhud_token=${session}` } })).status).toBe(401);
  // Single use: a second claim is refused (and revokes the first session,
  // see the theft test below).
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await claim(base, code)).status).toBe(409);
  errSpy.mockRestore();
});

test('login codes expire after a minute', async () => {
  const { base, token } = await start();
  const code = await mintCode(base, token);
  const realNow = Date.now;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);
  try {
    expect((await claim(base, code)).status).toBe(401);
  } finally {
    vi.restoreAllMocks();
  }
});

test('sessions are capped: the oldest is dropped past 32', async () => {
  const { base, token } = await start();
  const sessions: string[] = [];
  for (let i = 0; i < 33; i++) sessions.push(((await (await claim(base, await mintCode(base, token))).json()) as { session: string }).session);
  expect((await fetch(`${base}/api/data`, { headers: { 'x-devhud-session': sessions[0]! } })).status).toBe(401);
  expect((await fetch(`${base}/api/data`, { headers: { 'x-devhud-session': sessions[32]! } })).status).toBe(200);
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
    return performWrite({ state: emptyState(), type: 'comment', key: 'PROJ-1', body: 'hi', configPath, source, refreshFn: (async () => emptyState().snapshot) as never });
  };
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ id: 'c1' }), { status: 201, headers: { 'content-type': 'application/json' } }))));
  expect(await write(false, 'mcp')).toMatchObject({ status: 403, error: expect.stringMatching(/mcpWriteEnabled/) });
  expect(await write(true, 'mcp')).toMatchObject({ ok: true });
  expect(await write(false)).toMatchObject({ ok: true });
});

test('the request log never records query strings (the event stream carries the session there)', async () => {
  const { base, token } = await start();
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(String(a[0])); });
  try {
    await fetch(`${base}/api/data?session=SECRET123`, { headers: { 'x-devhud-token': token } });
    await new Promise(r => setTimeout(r, 20));
  } finally {
    spy.mockRestore();
  }
  expect(lines.some(l => l.startsWith('GET /api/data '))).toBe(true);
  expect(lines.join('\n')).not.toContain('SECRET123');
});

// PR #140 round 2: the login code is visible in the `open` command's argv to
// other local users. If one claims it first, the browser's claim (which
// always follows) revokes that session instead of silently losing.
test('a second claim of the same login code revokes the session the first claim got', async () => {
  const { base, token } = await start();
  const code = await mintCode(base, token);
  const thief = ((await (await claim(base, code)).json()) as { session: string }).session;
  expect((await fetch(`${base}/api/data`, { headers: { 'x-devhud-session': thief } })).status).toBe(200);
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const victim = await claim(base, code);
  errSpy.mockRestore();
  expect(victim.status).toBe(409);
  expect((await fetch(`${base}/api/data`, { headers: { 'x-devhud-session': thief } })).status).toBe(401);
  // A third try is just an unknown code.
  expect((await claim(base, code)).status).toBe(401);
});

// A theft near the end of a code's 60 s and a slower browser claim must still
// be caught (within SPENT_CODE_WINDOW_MS of the theft), but a code someone
// saw must not be a way to revoke the user's session forever after.
test('a second claim within five minutes revokes the first session; a later replay does nothing', async () => {
  const { base, token } = await start();
  const realNow = Date.now;
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = await mintCode(base, token);
    const thief = ((await (await claim(base, code)).json()) as { session: string }).session;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 4 * 60_000);
    expect((await claim(base, code)).status).toBe(409);
    expect((await fetch(`${base}/api/data`, { headers: { 'x-devhud-session': thief } })).status).toBe(401);
    vi.mocked(Date.now).mockRestore();

    const code2 = await mintCode(base, token);
    const user = ((await (await claim(base, code2)).json()) as { session: string }).session;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * 60_000);
    expect((await claim(base, code2)).status).toBe(401);
    expect((await fetch(`${base}/api/data`, { headers: { 'x-devhud-session': user } })).status).toBe(200);
  } finally {
    vi.restoreAllMocks();
    errSpy.mockRestore();
  }
});
