import { test, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guessStatuses, runInit, type Prompter } from './init.ts';

const prompter = (answers: string[]): Prompter & { asked: string[] } => {
  const asked: string[] = [];
  const next = (q: string, fallback?: string) => { asked.push(q); const a = answers.shift(); return Promise.resolve(a === undefined || a === '' ? fallback ?? '' : a); };
  return { asked, ask: next, secret: q => next(q), close() {} };
};

const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

test('init looks up accountId, statuses and GitHub login, then writes a valid 0600 config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devhud-init-'));
  const configPath = join(dir, 'config.json');
  const urls: string[] = [];
  const fetchFn = (url: string) => {
    urls.push(url);
    if (url.endsWith('/rest/api/3/myself')) return json({ accountId: 'acc-123', displayName: 'Dev' });
    if (url.includes('/statuses')) return json([{ statuses: [{ name: 'To Do' }, { name: 'In Progress' }, { name: 'PR Review' }, { name: 'QA' }, { name: 'Done' }] }]);
    if (url === 'https://api.github.com/user') return json({ login: 'octo' });
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  };
  // site, email, jira token, project, gh token, username (default), org, repos
  const p = prompter(['https://acme.atlassian.net/', 'me@acme.com', 'jt', 'proj', 'ght', '', 'acme', 'web, acme/api']);
  const r = await runInit({ prompter: p, configPath, fetchFn, log: () => {} });
  expect(r).toEqual({ code: 0 });
  const c = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(c.jira).toMatchObject({ baseUrl: 'https://acme.atlassian.net', projectKey: 'PROJ', accountId: 'acc-123' });
  expect(c.jira.statuses).toMatchObject({ review: 'PR Review', inTest: 'QA' });
  expect(c.github).toEqual({ token: 'ght', org: 'acme', repos: ['web', 'acme/api'], username: 'octo' });
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
  expect(urls).toContain('https://acme.atlassian.net/rest/api/3/project/PROJ/statuses');
});

test('init refuses to overwrite an existing config without --force', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devhud-init-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, '{}');
  const r = await runInit({ prompter: prompter([]), configPath, log: () => {} });
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/already exists/);
  expect(readFileSync(configPath, 'utf8')).toBe('{}');
});

test('guessStatuses maps obvious names and keeps defaults otherwise', () => {
  const s = guessStatuses(['Backlog', 'In Progress', 'Code Review', 'Peer Review', 'Testing', 'Ready for Testing', 'Done']);
  expect(s.review).toEqual(['Code Review', 'Peer Review']);
  expect(s.inTest).toBe('Testing');
  expect(s.todo).toBe('To Do');
});
