// `devhud serve` runs the server as a child process and forwards termination
// signals to it (server/cli.ts). Without forwarding, a signal to the CLI
// orphans the server, still listening on its port.
import { test, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';

const freePort = async () => {
  const srv = createNetServer();
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>(r => srv.close(() => r()));
  return port;
};
// The server writes its API token next to its state when it starts; until
// then (or without it) /api/data answers 401, which reads as not up yet.
const up = (port: number, home: string) => {
  let token = '';
  try { token = readFileSync(join(home, 'data', 'api-token'), 'utf8').trim(); } catch { /* not written yet */ }
  return fetch(`http://127.0.0.1:${port}/api/data`, { headers: { 'x-devhud-token': token } }).then(r => r.ok, () => false);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// The real server refuses to start without a built web bundle, and a fresh
// clone (CI runs `npm test` before `npm run build`) has none.
beforeAll(() => {
  const web = fileURLToPath(new URL('../web', import.meta.url));
  if (!existsSync(join(web, 'dist', 'index.html'))) execFileSync('npm', ['run', '-s', 'build'], { cwd: web, stdio: 'ignore' });
}, 120_000);

test('serve forwards SIGINT to the server: the port closes and the CLI exits 0', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jd-serve-'));
  const port = await freePort();
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    jira: { projectKey: 'DEMO', accountId: 'me' }, github: { org: 'acme', username: 'me', repos: [] }, demo: true, port,
  }));
  mkdirSync(join(home, 'data'));
  const cli = spawn(process.execPath, [fileURLToPath(new URL('./cli.ts', import.meta.url)), 'serve'], {
    env: { ...process.env, DEVHUD_HOME: home }, stdio: 'ignore',
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(r => cli.on('exit', (code, signal) => r({ code, signal })));
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { await sleep(100); ready = await up(port, home); }
    expect(ready, 'server answered /api/data').toBe(true);

    cli.kill('SIGINT');
    const result = await Promise.race([exited, sleep(5_000).then(() => null)]);
    expect(result).toEqual({ code: 0, signal: null });
    expect(await up(port, home)).toBe(false);
  } finally {
    // Clean up even on failure: the CLI, and the server child it may have
    // orphaned (its pid is in data/server.pid while it runs).
    if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
    try {
      const { pid } = JSON.parse(readFileSync(join(home, 'data', 'server.pid'), 'utf8')) as { pid: number };
      process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
}, 20_000);

// PR #140 review: the token used to be rotated before listen(), so a second
// start that failed on "port in use" overwrote the running server's token and
// locked the CLI, MCP and `devhud open` out until a restart.
test('a second start on a taken port leaves the running server\'s token alone', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jd-serve2-'));
  const port = await freePort();
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    jira: { projectKey: 'DEMO', accountId: 'me' }, github: { org: 'acme', username: 'me', repos: [] }, demo: true, port,
  }));
  mkdirSync(join(home, 'data'));
  const index = fileURLToPath(new URL('./index.ts', import.meta.url));
  const env = { ...process.env, DEVHUD_HOME: home };
  const first = spawn(process.execPath, [index], { env, stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { await sleep(100); ready = await up(port, home); }
    expect(ready, 'first server up').toBe(true);
    const token = readFileSync(join(home, 'data', 'api-token'), 'utf8');
    const second = spawn(process.execPath, [index], { env, stdio: 'ignore' });
    const code = await new Promise<number | null>(r => second.on('exit', c => r(c)));
    expect(code).toBe(1);
    expect(readFileSync(join(home, 'data', 'api-token'), 'utf8')).toBe(token);
    expect(await up(port, home)).toBe(true);
  } finally {
    first.kill('SIGKILL');
  }
}, 20_000);
