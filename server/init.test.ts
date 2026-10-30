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

test('guessStatuses with no project statuses writes the full default template', () => {
  expect(Object.entries(guessStatuses([]))).toEqual([
    ['todo', 'To Do'], ['inProgress', 'In Progress'], ['review', 'Code Review'], ['inTest', 'In Test'],
    ['done', 'Done'], ['blocked', 'Blocked'], ['canceled', 'Canceled'],
  ]);
});

test('guessStatuses maps obvious names and keeps defaults otherwise', () => {
  const s = guessStatuses(['Backlog', 'In Progress', 'Code Review', 'Peer Review', 'Testing', 'Ready for Testing', 'Done']);
  expect(s.review).toEqual(['Code Review', 'Peer Review']);
  expect(s.inTest).toBe('Testing');
  expect(s.todo).toBe('To Do');
});

test('init refuses an http Jira URL before asking for the token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devhud-init-'));
  const p = prompter(['http://acme.atlassian.net']);
  const r = await runInit({ prompter: p, configPath: join(dir, 'config.json'), fetchFn: () => { throw new Error('no fetch expected'); }, log: () => {} });
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/https/);
  expect(p.asked).toHaveLength(1);
});

// Audit 2026-10-29 M14: --force over an existing 0644 file wrote the tokens
// in place, readable by others until a later chmod.
test('init --force over a world-readable config leaves it 0600', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devhud-init-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, '{}', { mode: 0o644 });
  const fetchFn = (url: string) => url.endsWith('/myself') ? json({ accountId: 'acc' }) : json([]);
  const p = prompter(['https://acme.atlassian.net', 'me@acme.com', 'jt', 'PROJ', '', 'me', 'acme', 'web']);
  const r = await runInit({ prompter: p, configPath, fetchFn, force: true, log: () => {} });
  expect(r).toEqual({ code: 0 });
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(configPath, 'utf8')).jira.apiToken).toBe('jt');
});

test('init asks for the accountId when Jira rejects the credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devhud-init-'));
  const configPath = join(dir, 'config.json');
  const fetchFn = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  // site, email, token, accountId (asked because /myself failed), project, gh token, username, org, repos
  const p = prompter(['https://acme.atlassian.net', 'me@acme.com', 'jt', 'acc-typed', 'PROJ', '', 'me', 'acme', 'web']);
  const r = await runInit({ prompter: p, configPath, fetchFn, log: () => {} });
  expect(r).toEqual({ code: 0 });
  expect(p.asked.some(q => /Could not reach Jira/.test(q))).toBe(true);
  expect(JSON.parse(readFileSync(configPath, 'utf8')).jira.accountId).toBe('acc-typed');
});
