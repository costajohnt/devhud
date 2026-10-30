// `devhud serve` runs the server as a child process and forwards termination
// signals to it (server/cli.ts). Without forwarding, a signal to the CLI
// orphans the server, still listening on its port.
import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
const up = (port: number) => fetch(`http://127.0.0.1:${port}/api/data`).then(r => r.ok, () => false);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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
    for (let i = 0; i < 100 && !ready; i++) { await sleep(100); ready = await up(port); }
    expect(ready, 'server answered /api/data').toBe(true);

    cli.kill('SIGINT');
    const result = await Promise.race([exited, sleep(5_000).then(() => null)]);
    expect(result).toEqual({ code: 0, signal: null });
    expect(await up(port)).toBe(false);
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
