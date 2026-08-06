import type { Card, JiraConfig, JiraComment } from './types.ts';

// Minimal ADF (Atlassian Document Format) node shape — a recursive tree of
// text/paragraph/mention/hardBreak nodes. Only the fields adfToText reads.
export interface AdfNode {
  type?: string;
  text?: string;
  attrs?: { text?: string };
  content?: AdfNode[];
}

// Flatten Atlassian Document Format to plain text (links + text nodes only).
export function adfToText(node: AdfNode | string | null | undefined): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'mention') return node.attrs?.text ?? '@user';
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content ?? []).map(adfToText).join('');
  return node.type === 'paragraph' ? inner + '\n' : inner;
}

const iso = (t: string | undefined | null): string | null => t ? new Date(t).toISOString() : null;

// Recently-updated Done-category cards (within 14 days) are still fetched so a
// card that just reached Done flows into doneCards / celebration once before
// aging out; older Done cards are dropped to keep the fetch bounded.
export function buildJql(cfg: JiraConfig): string {
  return `project = ${cfg.projectKey} AND assignee = "${cfg.accountId}" AND (statusCategory != Done OR updated >= -14d) ORDER BY updated DESC`;
}

// Minimal shape for the slice of the raw Jira REST API issue response this
// file reads — not the full API type, just what's used below.
interface RawJiraIssue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    fixVersions?: { name?: string }[];
    description?: AdfNode;
    created?: string;
    updated?: string;
    comment?: { comments?: RawJiraComment[]; total?: number };
  };
}

// Jira's statusCategory.key is one of 'new' | 'indeterminate' | 'done'; map
// anything unexpected to '' so downstream code falls back to status-name
// matching rather than trusting a bogus category.
function statusCategory(key: string | undefined): Card['statusCategory'] {
  return key === 'new' || key === 'indeterminate' || key === 'done' ? key : '';
}

interface RawJiraComment {
  author?: { displayName?: string; accountId?: string };
  body?: AdfNode;
  created?: string;
}

export function mapIssue(issue: RawJiraIssue, cfg: JiraConfig): Card {
  const f = issue.fields;
  return {
    key: issue.key,
    summary: f.summary ?? '',
    status: f.status?.name ?? '',
    statusCategory: statusCategory(f.status?.statusCategory?.key),
    fixVersions: (f.fixVersions ?? []).map(v => v.name ?? '').filter(Boolean),
    description: adfToText(f.description).trim(),
    url: `${cfg.baseUrl}/browse/${issue.key}`,
    createdAt: iso(f.created),
    updatedAt: iso(f.updated),
    myAccountId: cfg.accountId,
    comments: (f.comment?.comments ?? []).map((c): JiraComment => ({
      author: c.author?.displayName ?? '',
      authorId: c.author?.accountId ?? '',
      body: adfToText(c.body).trim(),
      createdAt: iso(c.created),
    })),
  };
}

// When a card has more comments than fields.comment returned (Jira caps the
// embedded comment list), refetch the newest 50 from the dedicated comment
// endpoint so attention-worthy recent comments aren't silently dropped.
async function fetchLatestComments(key: string, cfg: JiraConfig, auth: string): Promise<JiraComment[]> {
  const url = new URL(`/rest/api/3/issue/${key}/comment`, cfg.baseUrl);
  url.searchParams.set('orderBy', '-created');
  url.searchParams.set('maxResults', '50');
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { comments?: RawJiraComment[] };
  return (data.comments ?? []).map((c): JiraComment => ({
    author: c.author?.displayName ?? '',
    authorId: c.author?.accountId ?? '',
    body: adfToText(c.body).trim(),
    createdAt: iso(c.created),
  }));
}

export async function fetchJiraCards(cfg: JiraConfig, extraKeys: string[] = []): Promise<Card[]> {
  const auth = 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
  const fields = 'summary,status,fixVersions,description,created,updated,comment';
  const cards: Card[] = [];
  const seenKeys = new Set<string>();

  const processIssues = async (issues: RawJiraIssue[]) => {
    for (const issue of issues) {
      if (seenKeys.has(issue.key)) continue;
      seenKeys.add(issue.key);
      const mapped = mapIssue(issue, cfg);
      const total = issue.fields?.comment?.total ?? mapped.comments.length;
      if (total > mapped.comments.length) {
        console.warn(`simon-dash: ${issue.key} has ${total} comments but only ${mapped.comments.length} were returned; refetching latest 50`);
        try { mapped.comments = await fetchLatestComments(issue.key, cfg, auth); }
        catch (e) { console.warn(`simon-dash: refetch of ${issue.key} comments failed: ${(e as Error).message}`); }
      }
      cards.push(mapped);
    }
  };

  let nextPageToken: string | undefined;
  do {
    const url = new URL('/rest/api/3/search/jql', cfg.baseUrl);
    url.searchParams.set('jql', buildJql(cfg));
    url.searchParams.set('fields', fields);
    url.searchParams.set('maxResults', '50');
    if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
    const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json() as { issues?: RawJiraIssue[]; nextPageToken?: string };
    await processIssues(data.issues ?? []);
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  const missingKeys = Array.from(new Set(extraKeys)).filter(k => !seenKeys.has(k));
  if (missingKeys.length) {
    const url = new URL('/rest/api/3/search/jql', cfg.baseUrl);
    url.searchParams.set('jql', `key in (${missingKeys.map(k => `"${k}"`).join(',')})`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('maxResults', '50');
    const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (res.ok) {
      const data = await res.json() as { issues?: RawJiraIssue[] };
      await processIssues(data.issues ?? []);
    }
  }

  return cards;
}
