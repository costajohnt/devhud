import { test, expect, vi } from 'vitest';
import { loadConfig } from './config.ts';
import { writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'jd-'));

test('loads config and applies defaults', () => {
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' }
  }));
  const c = loadConfig(p);
  expect(c.port).toBe(3010);
  expect(c.jira.statuses.inTest).toBe('In Test');
  expect(c.writeEnabled).toBe(false); // off by default
});

test('writeEnabled: true is normalized through untouched', () => {
  const p = join(dir, 'write-enabled.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
    writeEnabled: true,
  }));
  expect(loadConfig(p).writeEnabled).toBe(true);
});

test('SIMON_DASH_DEMO=1 turns on demo mode', () => {
  const p = join(dir, 'demo-env.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  }));
  process.env.SIMON_DASH_DEMO = '1';
  try {
    expect(loadConfig(p).demo).toBe(true);
  } finally {
    delete process.env.SIMON_DASH_DEMO;
  }
});

test('JIRA_DASH_DEMO=1 still works as a deprecated alias', () => {
  const p = join(dir, 'demo-env-legacy.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  }));
  process.env.JIRA_DASH_DEMO = '1';
  try {
    expect(loadConfig(p).demo).toBe(true);
  } finally {
    delete process.env.JIRA_DASH_DEMO;
  }
});

test('throws readable error when missing', () => {
  expect(() => loadConfig(join(dir, 'nope.json'))).toThrow(/config/i);
});

test('throws readable error on invalid JSON', () => {
  const p = join(dir, 'bad.json');
  writeFileSync(p, '{ not json');
  expect(() => loadConfig(p)).toThrow(/not valid JSON/);
});

test('throws readable error when jira or github key missing', () => {
  const p = join(dir, 'missing-key.json');
  writeFileSync(p, JSON.stringify({ github: { org: 'o', repos: ['r'], username: 'u' } }));
  expect(() => loadConfig(p)).toThrow(/missing required key "jira"/);
});

test('throws when jira.projectKey or jira.accountId missing', () => {
  const p = join(dir, 'missing-jira-fields.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  }));
  expect(() => loadConfig(p)).toThrow(/missing required key "jira.projectKey"/);
});

test('throws when github.username or github.org missing', () => {
  const p = join(dir, 'missing-github-fields.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { repos: ['r'] },
  }));
  expect(() => loadConfig(p)).toThrow(/missing required key "github.username"/);
});

test('throws when jira.baseUrl/email/apiToken missing outside demo mode', () => {
  const p = join(dir, 'missing-jira-creds.json');
  writeFileSync(p, JSON.stringify({
    jira: { projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  }));
  expect(() => loadConfig(p)).toThrow(/missing required key "jira.baseUrl"/);
});

test('jira.baseUrl/email/apiToken are not required in demo mode', () => {
  const p = join(dir, 'demo-no-creds.json');
  writeFileSync(p, JSON.stringify({
    jira: { projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
    demo: true,
  }));
  expect(loadConfig(p).demo).toBe(true);
});

test('loadConfig warns when config.json is group/world-readable (0644)', () => {
  const p = join(dir, 'loose-perms.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  }));
  chmodSync(p, 0o644);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  loadConfig(p);
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('chmod 600'));
  warnSpy.mockRestore();
});

test('loadConfig does not warn when config.json is already 0600', () => {
  const p = join(dir, 'tight-perms.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  }));
  chmodSync(p, 0o600);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  loadConfig(p);
  expect(warnSpy).not.toHaveBeenCalled();
  warnSpy.mockRestore();
});

test('accepts a valid explicit port at both ends of the range, including 0 (OS-assigned)', () => {
  const base = { jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' } };
  const p0 = join(dir, 'port-zero.json');
  // 0 is Node's own convention for "bind to any free port" (server.listen(0)),
  // relied on throughout this suite's own test servers — not an edge case to reject.
  writeFileSync(p0, JSON.stringify({ ...base, port: 0 }));
  expect(loadConfig(p0).port).toBe(0);
  const p1 = join(dir, 'port-min.json');
  writeFileSync(p1, JSON.stringify({ ...base, port: 1 }));
  expect(loadConfig(p1).port).toBe(1);
  const p2 = join(dir, 'port-max.json');
  writeFileSync(p2, JSON.stringify({ ...base, port: 65535 }));
  expect(loadConfig(p2).port).toBe(65535);
});

test('throws a readable error for a port outside 0-65535', () => {
  const base = { jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' } };
  const p2 = join(dir, 'port-too-big.json');
  writeFileSync(p2, JSON.stringify({ ...base, port: 65536 }));
  expect(() => loadConfig(p2)).toThrow(/invalid "port"/);
  const p3 = join(dir, 'port-negative.json');
  writeFileSync(p3, JSON.stringify({ ...base, port: -1 }));
  expect(() => loadConfig(p3)).toThrow(/invalid "port"/);
});

test('throws a readable error for a non-integer port (fraction or string)', () => {
  const base = { jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' } };
  const p1 = join(dir, 'port-fraction.json');
  writeFileSync(p1, JSON.stringify({ ...base, port: 3010.5 }));
  expect(() => loadConfig(p1)).toThrow(/invalid "port"/);
  const p2 = join(dir, 'port-string.json');
  writeFileSync(p2, JSON.stringify({ ...base, port: '3010' }));
  expect(() => loadConfig(p2)).toThrow(/invalid "port"/);
});

test('passes refreshIntervalSeconds through and leaves it undefined when absent', () => {
  const base = { jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' } };
  const p0 = join(dir, 'interval-absent.json');
  writeFileSync(p0, JSON.stringify(base));
  expect(loadConfig(p0).refreshIntervalSeconds).toBeUndefined();
  const p1 = join(dir, 'interval-set.json');
  writeFileSync(p1, JSON.stringify({ ...base, refreshIntervalSeconds: 60 }));
  expect(loadConfig(p1).refreshIntervalSeconds).toBe(60);
});

test('throws a readable error for a non-positive or non-integer refreshIntervalSeconds', () => {
  const base = { jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' } };
  for (const [name, value] of [['zero', 0], ['negative', -5], ['fraction', 1.5], ['string', '60']] as const) {
    const p = join(dir, `interval-${name}.json`);
    writeFileSync(p, JSON.stringify({ ...base, refreshIntervalSeconds: value }));
    expect(() => loadConfig(p)).toThrow(/invalid "refreshIntervalSeconds"/);
  }
});
