import { test, expect } from 'vitest';
import { loadConfig } from './config.ts';
import { writeFileSync, mkdtempSync } from 'node:fs';
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
