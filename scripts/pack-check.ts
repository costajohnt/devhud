// End-to-end check of the published artifact: npm pack (which runs the
// build), install the tarball into a scratch prefix, and exercise the
// installed bins against a demo config in a scratch DEVHUD_HOME. Proves the
// package installs and runs, which `npm pack` contents alone do not.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// fileURLToPath, not .pathname: a path with a space is %20-encoded there.
const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'devhud-pack-'));
const sh = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });

try {
  const tarball = sh('npm', ['pack', '--silent', '--pack-destination', tmp]).trim().split('\n').pop()!;
  const prefix = join(tmp, 'install');
  mkdirSync(prefix);
  sh('npm', ['install', '--silent', '--no-audit', '--no-fund', '--prefix', prefix, join(tmp, tarball)]);
  const bin = (name: string) => join(prefix, 'node_modules', '.bin', name);

  const home = join(tmp, 'home');
  const env = { DEVHUD_HOME: home };
  assert.match(sh(bin('devhud'), ['--help'], env), /devhud init/);
  let missing = '';
  try { sh(bin('devhud'), ['status'], env); } catch (e) { missing = String((e as { stderr?: string }).stderr); }
  assert.match(missing, /Run `devhud init`/);

  // Installed-package default home: no DEVHUD_HOME, so an installed copy must
  // resolve $HOME/.devhud, never its own node_modules (server/paths.ts).
  const fakeHome = join(tmp, 'fake-home');
  mkdirSync(fakeHome);
  const { DEVHUD_HOME: _, ...noHomeEnv } = process.env;
  let defaultHome = '';
  try {
    execFileSync(bin('devhud'), ['status'], { cwd: tmp, encoding: 'utf8', env: { ...noHomeEnv, HOME: fakeHome }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { defaultHome = String((e as { stderr?: string }).stderr); }
  assert.ok(defaultHome.includes(`No config at ${join(fakeHome, '.devhud', 'config.json')}.`), `installed default home: ${defaultHome}`);

  const port = await new Promise<number>(res => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    jira: { projectKey: 'DEMO', accountId: 'demo' }, github: { org: 'acme', username: 'demo', repos: ['webapp'] }, demo: true, port,
  }));
  assert.match(sh(bin('devhud'), ['refresh'], env), /Needs Attention/);
  assert.match(sh(bin('devhud'), ['todo'], env), /TODO \(\d+\)/);

  // The server: serves the built SPA and the API from the installed package.
  const server = spawn(bin('devhud'), ['serve'], { env: { ...process.env, ...env }, stdio: 'ignore' });
  const serverExited = new Promise(r => server.on('exit', r));
  try {
    let page = '';
    for (let i = 0; i < 50 && !page; i++) {
      await new Promise(r => setTimeout(r, 100));
      page = await fetch(`http://127.0.0.1:${port}/`).then(r => r.text(), () => '');
    }
    assert.match(page, /<title>devhud<\/title>/);
    const data = await (await fetch(`http://127.0.0.1:${port}/api/data`)).json() as { queue?: unknown[] };
    assert.ok(Array.isArray(data.queue), 'api/data has a queue');
  } finally {
    server.kill();
    await serverExited;
  }
  // `serve` forwards SIGTERM to the real server: nothing is left listening.
  assert.equal(await fetch(`http://127.0.0.1:${port}/api/data`).then(() => 'up', () => 'down'), 'down', 'server stopped with serve');

  // The MCP server answers an initialize request over stdio.
  const mcp = spawn(bin('devhud-mcp'), [], { env: { ...process.env, ...env } });
  let timer: NodeJS.Timeout | undefined;
  try {
    const reply = await new Promise<string>((res, rej) => {
      let buf = '';
      mcp.stdout.on('data', d => { buf += d; if (buf.includes('\n')) res(buf); });
      mcp.on('error', rej);
      timer = setTimeout(() => rej(new Error(`no MCP reply; got: ${buf}`)), 10_000);
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pack-check', version: '0' } } }) + '\n');
    });
    assert.match(reply, /"name":"devhud"/);
  } finally {
    clearTimeout(timer);
    mcp.kill();
  }

  console.log(`pack-check ok: ${tarball} installs; devhud --help/init hint/refresh/todo/serve and devhud-mcp all run`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
