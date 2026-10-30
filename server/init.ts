// `devhud init`: interactive first-run setup that writes config.json.
// Looks up what it can instead of asking (Jira accountId, the project's
// status names, the GitHub login) so the only things typed are the site,
// credentials, project and repos. The prompt/fetch seams are injectable so
// the flow is testable without a TTY or network.
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { DEFAULT_STATUSES as CONFIG_STATUSES, isHttpsUrl, loadConfig } from './config.ts';
import { writeFilePrivate } from './state.ts';

export interface Prompter {
  ask(question: string, fallback?: string): Promise<string>;
  // Same as ask, but the typed answer is not echoed (API tokens).
  secret(question: string): Promise<string>;
  close(): void;
}

export function ttyPrompter(): Prompter {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, done) { if (!muted) process.stdout.write(chunk); done(); },
  });
  // terminal only on a real TTY: on piped input it would echo every line,
  // tokens included. The async iterator buffers lines, so answers piped in
  // before their question is asked are not dropped.
  const rl = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  const read = async () => { const r = await lines.next(); return r.done ? '' : String(r.value).trim(); };
  return {
    async ask(q, fallback) {
      process.stdout.write(fallback ? `${q} [${fallback}]: ` : `${q}: `);
      const a = await read();
      if (!process.stdin.isTTY) process.stdout.write('\n');
      return a || fallback || '';
    },
    async secret(q) {
      process.stdout.write(`${q} (input hidden): `);
      muted = true;
      try { return await read(); }
      finally { muted = false; process.stdout.write('\n'); }
    },
    close() { rl.close(); },
  };
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

async function getJson<T>(fetchFn: FetchFn, url: string, headers: Record<string, string>): Promise<T | null> {
  try {
    const r = await fetchFn(url, { headers: { accept: 'application/json', ...headers } });
    return r.ok ? await r.json() as T : null;
  } catch { return null; }
}

// loadConfig's defaults plus the two stages it leaves unset (classify falls
// back to the stock names), written out so the user can see and edit them.
// todo is pulled out only to keep the written key order.
const { todo, ...laterStatuses } = CONFIG_STATUSES;
const DEFAULT_STATUSES = { todo, inProgress: 'In Progress', review: 'Code Review', ...laterStatuses };

// Map the project's real status names onto the board's stages where a name
// obviously fits; anything unmatched keeps its default for the user to edit.
export function guessStatuses(names: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = { ...DEFAULT_STATUSES };
  const pick = (re: RegExp) => names.filter(n => re.test(n));
  const set = (k: string, hits: string[]) => { if (hits.length) out[k] = hits.length === 1 ? hits[0]! : hits; };
  set('review', pick(/review/i));
  set('inTest', pick(/\b(qa|test|testing)\b/i).filter(n => !/ready for|passed|done/i.test(n)));
  set('blocked', pick(/block/i));
  set('canceled', pick(/cancel|won'?t (do|fix)/i));
  return out;
}

export async function runInit({ prompter, configPath, fetchFn = fetch, force = false, log = console.log }: {
  prompter: Prompter; configPath: string; fetchFn?: FetchFn; force?: boolean; log?: (s: string) => void;
}): Promise<{ code: number; err?: string }> {
  if (existsSync(configPath) && !force) {
    return { code: 1, err: `${configPath} already exists. Edit it directly, or rerun with --force to replace it.` };
  }
  try {
    log('devhud setup. Press enter to accept a [default].\n');

    const baseUrl = (await prompter.ask('Jira site URL, e.g. https://yourcompany.atlassian.net')).replace(/\/+$/, '');
    // Checked before the token is asked for or sent anywhere: the /myself
    // probe below would send it as Basic auth over whatever scheme this is.
    if (!isHttpsUrl(baseUrl)) return { code: 1, err: `Jira site URL must start with https:// (http:// only for localhost; got ${JSON.stringify(baseUrl)})` };
    const email = await prompter.ask('Jira account email');
    log('Create a Jira API token at https://id.atlassian.com/manage-profile/security/api-tokens');
    const apiToken = await prompter.secret('Jira API token');
    const auth = { authorization: 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64') };

    const me = await getJson<{ accountId?: string; displayName?: string }>(fetchFn, `${baseUrl}/rest/api/3/myself`, auth);
    let accountId = me?.accountId ?? '';
    if (accountId) log(`Signed in to Jira as ${me?.displayName ?? accountId}.`);
    else accountId = await prompter.ask('Could not reach Jira with those credentials. Jira accountId (from /rest/api/3/myself)');

    const projectKey = (await prompter.ask('Jira project key, e.g. PROJ')).toUpperCase();
    const projStatuses = await getJson<{ statuses?: { name?: string }[] }[]>(fetchFn, `${baseUrl}/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`, auth);
    const names = [...new Set((projStatuses ?? []).flatMap(t => (t.statuses ?? []).map(s => s.name ?? '')).filter(Boolean))];
    const statuses = guessStatuses(names);
    if (names.length) log(`Project statuses: ${names.join(', ')}`);

    log('\nGitHub: a token with read access to your repos. Leave blank to use the GITHUB_TOKEN env var.');
    const token = await prompter.secret('GitHub token');
    const ghToken = token || process.env.GITHUB_TOKEN || '';
    const ghUser = ghToken
      ? await getJson<{ login?: string }>(fetchFn, 'https://api.github.com/user', { authorization: `Bearer ${ghToken}` })
      : null;
    const username = await prompter.ask('GitHub username', ghUser?.login);
    const org = await prompter.ask('GitHub org (or user) that owns your repos', ghUser?.login);
    const repos = (await prompter.ask('Repos to watch, comma separated (name, or owner/name)'))
      .split(',').map(r => r.trim()).filter(Boolean);

    const config = {
      jira: { baseUrl, email, apiToken, projectKey, accountId, statuses },
      github: { token, org, repos, username },
      ignoreAuthors: ['Rovo'],
      port: 3010,
      refreshIntervalSeconds: 120,
      demo: false,
      writeEnabled: false,
      autoTransitionMerged: false,
    };
    // 0600 temp file then rename: writing in place with --force over an
    // existing 0644 file exposed the new tokens until a later chmod.
    writeFilePrivate(configPath, JSON.stringify(config, null, 2) + '\n');

    log(`\nWrote ${configPath}.`);
    log(`Status mapping: ${JSON.stringify(statuses)}. Edit jira.statuses if a stage is wrong.`);
    try {
      loadConfig(configPath);
    } catch (e) {
      return { code: 1, err: `Saved, but the config is not valid yet: ${(e as Error).message}` };
    }
    log('Next: `devhud serve` (or ./bin/start.sh from a checkout), then open http://localhost:3010');
    return { code: 0 };
  } finally {
    prompter.close();
  }
}
