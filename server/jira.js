// Flatten Atlassian Document Format to plain text (links + text nodes only).
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  const inner = (node.content ?? []).map(adfToText).join('');
  return node.type === 'paragraph' ? inner + '\n' : inner;
}

// Done cards within 14 days are fetched so merged+Done cards flow to
// mergedCards/celebration once before aging out.
export function buildJql(cfg) {
  return `project = ${cfg.projectKey} AND assignee = "${cfg.accountId}" AND (statusCategory != Done OR updated >= -14d) ORDER BY updated DESC`;
}

export function mapIssue(issue, cfg) {
  const f = issue.fields;
  const iso = (t) => t ? new Date(t).toISOString() : null;
  return {
    key: issue.key,
    summary: f.summary ?? '',
    status: f.status?.name ?? '',
    description: adfToText(f.description).trim(),
    url: `${cfg.baseUrl}/browse/${issue.key}`,
    createdAt: iso(f.created),
    updatedAt: iso(f.updated),
    myAccountId: cfg.accountId,
    comments: (f.comment?.comments ?? []).map(c => ({
      author: c.author?.displayName ?? '',
      authorId: c.author?.accountId ?? '',
      body: adfToText(c.body).trim(),
      createdAt: iso(c.created),
    })),
  };
}

export async function fetchJiraCards(cfg) {
  const auth = 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
  const fields = 'summary,status,description,created,updated,comment';
  const cards = [];
  let nextPageToken;
  do {
    const url = new URL('/rest/api/3/search/jql', cfg.baseUrl);
    url.searchParams.set('jql', buildJql(cfg));
    url.searchParams.set('fields', fields);
    url.searchParams.set('maxResults', '50');
    if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
    const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    cards.push(...(data.issues ?? []).map(i => mapIssue(i, cfg)));
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);
  return cards;
}
