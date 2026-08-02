import { test, expect } from 'vitest';
import { mapIssue, buildJql } from './jira.js';

const cfg = { baseUrl: 'https://x.atlassian.net', projectKey: 'PROJ', accountId: 'me',
  statuses: { todo: 'To Do', inTest: 'In Test', done: 'Done' } };

test('buildJql filters project, assignee, not-done', () => {
  const jql = buildJql(cfg);
  expect(jql).toContain('project = PROJ');
  expect(jql).toContain('assignee = "me"');
  expect(jql).toContain('statusCategory != Done');
});

test('buildJql includes recently-updated Done cards', () => {
  const jql = buildJql(cfg);
  expect(jql).toContain('updated >= -14d');
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
