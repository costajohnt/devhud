import { test, expect, vi, afterEach } from 'vitest';
import { opWrite } from './ops.ts';
import { emptyState, saveState } from './state.ts';
import { writePidFile } from './transport.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from './types.ts';

afterEach(() => vi.unstubAllGlobals());

// The contract this file exists to pin: an external Jira/GitHub write that
// SUCCEEDED must never be reported as failed just because the local save got
// blocked — a caller that retried would double-post. Before ops.ts this
// branch lived as two hand-synced copies (CLI + MCP) and had already drifted
// once; nothing else in the suite reaches it.
test('opWrite direct mode: successful external write + blocked save returns ok with saveBlockedError, not error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jd-ops-'));
  const statePath = join(dir, 'state.json');
  saveState(statePath, emptyState());
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
    writeEnabled: true, demo: false,
  }));
  const config = { port: 1, demo: false, writeEnabled: true,
    jira: { projectKey: 'PROJ', accountId: 'id', statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } },
    github: { org: 'o', repos: ['r'], username: 'u', token: '' },
  } as Config;

  // The Jira comment POST "succeeds" — and as a side effect a server starts
  // (its pid file appears) in exactly the TOCTOU window between opWrite's
  // early split-brain guard and the final saveStateGuarded.
  let externalWriteHappened = false;
  vi.stubGlobal('fetch', vi.fn(() => {
    if (!externalWriteHappened) {
      externalWriteHappened = true;
      writePidFile(join(dirname(statePath), 'server.pid'), 1);
    }
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) });
  }));

  const result = await opWrite(
    { config, statePath, configPath, viaServer: false },
    { type: 'comment', key: 'PROJ-1', body: 'hi' },
  );

  expect(externalWriteHappened).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);
  expect(String(result.saveBlockedError)).toContain('appears to be running');
});
