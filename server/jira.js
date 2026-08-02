// Flatten Atlassian Document Format to plain text (links + text nodes only).
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'mention') return node.attrs?.text ?? '@user';
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content ?? []).map(adfToText).join('');
  return node.type === 'paragraph' ? inner + '\n' : inner;
}

const iso = (t) => t ? new Date(t).toISOString() : null;

// Done cards within 14 days are fetched so merged+Done cards flow to
// mergedCards/celebration once before aging out.
export function buildJql(cfg) {
  return `project = ${cfg.projectKey} AND assignee = "${cfg.accountId}" AND (statusCategory != Done OR updated >= -14d) ORDER BY updated DESC`;
}

export function mapIssue(issue, cfg) {
  const f = issue.fields;
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

// When a card has more comments than fields.comment returned (Jira caps the
// embedded comment list), refetch the newest 50 from the dedicated comment
// endpoint so attention-worthy recent comments aren't silently dropped.
async function fetchLatestComments(key, cfg, auth) {
  const url = new URL(`/rest/api/3/issue/${key}/comment`, cfg.baseUrl);
  url.searchParams.set('orderBy', '-created');
  url.searchParams.set('maxResults', '50');
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.comments ?? []).map(c => ({
    author: c.author?.displayName ?? '',
    authorId: c.author?.accountId ?? '',
    body: adfToText(c.body).trim(),
    createdAt: iso(c.created),
  }));
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
    const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    for (const issue of data.issues ?? []) {
      const mapped = mapIssue(issue, cfg);
      const total = issue.fields?.comment?.total ?? mapped.comments.length;
      if (total > mapped.comments.length) {
        console.warn(`jira-dash: ${issue.key} has ${total} comments but only ${mapped.comments.length} were returned; refetching latest 50`);
        try { mapped.comments = await fetchLatestComments(issue.key, cfg, auth); }
        catch (e) { console.warn(`jira-dash: refetch of ${issue.key} comments failed: ${e.message}`); }
      }
      cards.push(mapped);
    }
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);
  return cards;
}
