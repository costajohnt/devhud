import { test, expect, vi, afterEach } from 'vitest';
import { mapIssue, buildJql, doneWatermark, adfToText, fetchJiraCards } from './jira.ts';

afterEach(() => vi.unstubAllGlobals());

const cfg = { baseUrl: 'https://x.atlassian.net', projectKey: 'PROJ', accountId: 'me',
  statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } };

test('buildJql filters project and assignee', () => {
  const jql = buildJql(cfg, '2026-08-01');
  expect(jql).toContain('project = PROJ');
  expect(jql).toContain('assignee = "me"');
  expect(jql).toContain('statusCategory != Done');
});

test('buildJql with no watermark drops the status clause, so the seeding fetch sees every Done card', () => {
  const jql = buildJql(cfg);
  expect(jql).not.toContain('updated >=');
  expect(jql).not.toContain('statusCategory');
});

test('buildJql bounds Done cards at the watermark once one exists', () => {
  expect(buildJql(cfg, '2026-08-01')).toContain('updated >= "2026-08-01"');
});

test('doneWatermark lags the newest entry by a day so a boundary card is refetched, not missed', () => {
  expect(doneWatermark([{ doneAt: '2026-08-11T22:18:00.000Z' }])).toBe('2026-08-10');
});

test('doneWatermark takes the newest entry regardless of ledger order', () => {
  expect(doneWatermark([
    { doneAt: '2026-07-01T00:00:00.000Z' },
    { doneAt: '2026-08-11T00:00:00.000Z' },
  ])).toBe('2026-08-10');
});

test('doneWatermark is undefined for an empty or untimestamped ledger', () => {
  expect(doneWatermark([])).toBeUndefined();
  expect(doneWatermark([{ doneAt: null }])).toBeUndefined();
});

test('mapIssue flattens ADF description and comments', () => {
  const issue = {
    key: 'PROJ-9',
    fields: {
      summary: 'Fix the thing',
      status: { name: 'In Progress' },
      created: '2026-07-01T00:00:00.000+0000',
      updated: '2026-07-02T00:00:00.000+0000',
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see https://github.com/o/r/pull/4' }] }] },
      comment: { comments: [{ author: { accountId: 'other', displayName: 'Sam' },
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'looks off' }] }] },
        created: '2026-07-02T01:00:00.000+0000' }] }
    }
  };
  const c = mapIssue(issue, cfg);
  expect(c.key).toBe('PROJ-9');
  expect(c.url).toBe('https://x.atlassian.net/browse/PROJ-9');
  expect(c.description).toContain('https://github.com/o/r/pull/4');
  expect(c.comments[0]).toMatchObject({ authorId: 'other', author: 'Sam', body: 'looks off' });
  expect(c.comments[0].createdAt).toMatch(/^2026-07-02T01:00:00/);
  expect(c.myAccountId).toBe('me');
});

test('adfToText resolves mention and hardBreak nodes', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'hey ' },
    { type: 'mention', attrs: { text: '@sam' } },
    { type: 'hardBreak' },
    { type: 'text', text: 'line two' },
  ] }] };
  expect(adfToText(doc)).toBe('hey @sam\nline two\n');
});

test('adfToText falls back to @user for a mention with no attrs.text', () => {
  expect(adfToText({ type: 'mention', attrs: {} })).toBe('@user');
});

test('fetchJiraCards refetches the newest comments when the embedded list was truncated', async () => {
  const searchPayload = {
    issues: [{
      key: 'PROJ-9',
      fields: {
        summary: 'S', status: { name: 'In Progress' }, created: '2026-07-01T00:00:00.000+0000', updated: '2026-07-01T00:00:00.000+0000',
        description: null,
        comment: { total: 3, comments: [{ author: { accountId: 'a', displayName: 'A' }, body: { type: 'doc', content: [] }, created: '2026-07-01T00:00:00.000+0000' }] },
      },
    }],
  };
  const latestCommentsPayload = { comments: [
    { author: { accountId: 'a', displayName: 'A' }, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'newest' }] }] }, created: '2026-07-03T00:00:00.000+0000' },
  ] };
  // Throw on unmatched URLs (mirroring github.test.ts) and capture the
  // primary request: a mock that answers ANY non-comment URL with the
  // search payload would let a wrong endpoint, missing auth header, or
  // broken JQL encoding pass silently.
  let searchAuth: string | undefined;
  const fetchMock = vi.fn((url: string | URL, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    if (u.includes('/comment?')) return Promise.resolve({ ok: true, json: () => Promise.resolve(latestCommentsPayload) });
    if (u.startsWith('https://x.atlassian.net/rest/api/3/search/jql?')) {
      searchAuth = init?.headers?.Authorization;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(searchPayload) });
    }
    throw new Error(`unexpected URL ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const cfg = { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'me',
    statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } };
  const cards = await fetchJiraCards(cfg);
  expect(cards[0]!.comments).toHaveLength(1);
  expect(cards[0]!.comments[0]!.body).toContain('newest');
  expect(searchAuth).toBe('Basic ' + Buffer.from('a@b.c:t').toString('base64'));
  expect(warnSpy).toHaveBeenCalled();
  warnSpy.mockRestore();
});
