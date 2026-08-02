import { test, expect } from 'vitest';
import { loadConfig } from './config.js';
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
