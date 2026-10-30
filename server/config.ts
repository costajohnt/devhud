import { readFileSync, statSync } from 'node:fs';
import { CONFIG_PATH } from './paths.ts';
import type { Config, JiraStatuses, GithubIdentity } from './types.ts';

const DEFAULT_STATUSES: JiraStatuses = { todo: 'To Do', inTest: 'In Test', done: 'Done', canceled: 'Canceled', blocked: 'Blocked' };

// Comment authors whose comments never trigger triage or enter the actionable
// queue. Your own comments are already excluded by Jira accountId and GitHub
// username, so the default only mutes Atlassian's Rovo agent. Overridable via
// config.json's top-level "ignoreAuthors".
const DEFAULT_IGNORE_AUTHORS = ['Rovo'];

// Loose shape of whatever JSON.parse hands back for config.json: every field
// optional/untyped until the validation below confirms it's present, at
// which point the function returns a real Config. This is the "typed
// helper" for the JSON.parse cast the erasable-syntax rule allows — the
// alternative (typing loadConfig's return as Config from the start) would
// require every field to already exist at the `c = JSON.parse(raw)` line,
// which defeats the point of validating them one at a time below.
interface RawConfig {
  jira?: {
    baseUrl?: string; email?: string; apiToken?: string;
    projectKey?: string; accountId?: string; statuses?: Partial<JiraStatuses>;
  };
  github?: {
    // Single-identity shape (backward compat): token/username/repos at the top level.
    token?: string; org?: string; repos?: string[]; username?: string;
    // Multi-identity shape (#108): each entry carries its own credentials and
    // repo list. When present, the top-level token/username are ignored; the
    // top-level repos still apply and belong to the catch-all identity (the
    // one entry without repos). With no catch-all, each must be listed under
    // an identity or loadConfig throws.
    identities?: Array<{ username?: string; tokenEnv?: string; repos?: string[] }>;
  };
  port?: number;
  demo?: boolean;
  writeEnabled?: boolean;
  autoTransitionMerged?: boolean;
  refreshIntervalSeconds?: number;
  ignoreAuthors?: string[];
}

export const isHttpsUrl = (u: string): boolean => {
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
};

export function loadConfig(path: string = CONFIG_PATH): Config {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch { throw new Error(`config not found at ${path} — copy config.example.json to config.json and fill it in`); }
  // config.json holds long-lived Jira/GitHub credentials (Basic auth token,
  // Bearer token). Warn, don't throw, if it's group- or world-readable —
  // this is a local single-user tool, so a wrong-but-working permission
  // shouldn't block startup, but it's worth flagging since nothing else in
  // the stack enforces this.
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      console.warn(`devhud: ${path} is readable by group/other (mode ${mode.toString(8)}) and holds live credentials — run \`chmod 600 ${path}\``);
    }
  } catch { /* already handled by the readFileSync above if the file is genuinely missing */ }
  let c: RawConfig;
  try { c = JSON.parse(raw) as RawConfig; }
  catch (e) {
    // Never echo JSON.parse's message: V8 quotes the surrounding source, which
    // for this file can be a token ("Unexpected token 'g', ..."token":ghp_...").
    // That error reaches HTTP/MCP callers through performWrite. Keep only the
    // position, when the engine reports one.
    const at = (e as Error).message.match(/line (\d+) column (\d+)/);
    throw new Error(`config at ${path} is not valid JSON${at ? ` (line ${at[1]}, column ${at[2]})` : ''}; check quotes and commas`);
  }
  for (const key of ['jira', 'github'] as const) {
    if (!c[key]) throw new Error(`config at ${path} is missing required key "${key}"`);
  }
  const jira = c.jira!;
  const github = c.github!;
  for (const key of ['projectKey', 'accountId'] as const) {
    if (!jira[key]) throw new Error(`config at ${path} is missing required key "jira.${key}"`);
  }
  // With the identities array, username and token are not required at the top
  // level — they can live inside each identity. Without identities, the old
  // single-identity fields are still required so the error message stays useful.
  if (!github.identities?.length) {
    for (const key of ['username', 'org'] as const) {
      if (!github[key]) throw new Error(`config at ${path} is missing required key "github.${key}"`);
    }
  } else {
    // org is still needed to expand bare repo names to "org/repo" in fetchPrs.
    if (!github.org) throw new Error(`config at ${path} is missing required key "github.org"`);
  }
  // SIMON_DASH_DEMO and JIRA_DASH_DEMO are deprecated aliases kept for anyone
  // with them already set from earlier names; DEVHUD_DEMO is the current name.
  const demo = Boolean(c.demo)
    || ['DEVHUD_DEMO', 'SIMON_DASH_DEMO', 'JIRA_DASH_DEMO'].some((k) => process.env[k] === '1');
  // Demo mode never talks to real Jira, so requiring these would just make
  // trying the demo harder for no reason. Everyone else needs them, or
  // every real fetch/write fails with a confusing runtime auth error
  // instead of a clear config error up front.
  if (!demo) {
    for (const key of ['baseUrl', 'email', 'apiToken'] as const) {
      if (!jira[key]) throw new Error(`config at ${path} is missing required key "jira.${key}"`);
    }
    // Every Jira request carries Basic email:apiToken; over http that is the
    // token in cleartext on every refresh.
    if (!isHttpsUrl(jira.baseUrl!)) {
      throw new Error(`config at ${path} has an invalid "jira.baseUrl" (${JSON.stringify(jira.baseUrl)}); must be an https:// URL`);
    }
  }
  // These values flow unescaped into query/path languages downstream —
  // projectKey and accountId into JQL (jira.ts buildJql), org and repos[]
  // into GitHub API URL paths (github.ts) — where a stray quote, slash, or
  // "?" silently rewrites the query or re-routes the Bearer-tokened request
  // to a different endpoint. Reject at load with a readable error instead.
  if (!/^[A-Z][A-Z0-9_]*$/.test(jira.projectKey!)) {
    throw new Error(`config at ${path} has an invalid "jira.projectKey" (${JSON.stringify(jira.projectKey)}); must match ^[A-Z][A-Z0-9_]*$`);
  }
  if (!/^[a-zA-Z0-9:_-]+$/.test(jira.accountId!)) {
    throw new Error(`config at ${path} has an invalid "jira.accountId" (${JSON.stringify(jira.accountId)}); must match ^[a-zA-Z0-9:_-]+$`);
  }
  if (!/^[\w.-]+$/.test(github.org!)) {
    throw new Error(`config at ${path} has an invalid "github.org" (${JSON.stringify(github.org)}); must match ^[\\w.-]+$`);
  }
  // Repos allow one optional "owner/" segment: fetchPrs (github.ts) supports
  // fully-qualified cross-org entries like "otherorg/svc" and a test relies
  // on it. Exactly one slash — still no path smuggling.
  const repoPattern = /^[\w.-]+(\/[\w.-]+)?$/;
  for (const r of github.repos ?? []) {
    if (!repoPattern.test(r)) {
      throw new Error(`config at ${path} has an invalid "github.repos" entry (${JSON.stringify(r)}); must be "name" or "owner/name" using only [\\w.-] characters`);
    }
  }
  // Validate repos inside the identities array with the same pattern.
  for (const [i, id] of (github.identities ?? []).entries()) {
    for (const r of id.repos ?? []) {
      if (!repoPattern.test(r)) {
        throw new Error(`config at ${path} has an invalid "github.identities[${i}].repos" entry (${JSON.stringify(r)}); must be "name" or "owner/name" using only [\\w.-] characters`);
      }
    }
  }
  // A corrupted or hand-edited config.json can hand back a non-numeric or
  // out-of-range port; that value flows straight into `open`'s CLI command
  // (server/cli.ts's `open`) and into the server's own listen() call, so
  // catching it here with a readable error beats a confusing failure later.
  // 0 is a valid value (not just an edge case): it's Node's own convention
  // for "bind to any free port" (`server.listen(0, ...)`), used throughout
  // this codebase's own tests and available to real config.json too.
  const port = c.port ?? 3010;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`config at ${path} has an invalid "port" (${JSON.stringify(c.port)}); must be an integer between 0 and 65535`);
  }
  // Same shape of failure as a bad port: a hand-edited value flows straight
  // into the server's self-rescheduling refresh timer, where 0/negative/NaN would spin a hot loop
  // hammering Jira and GitHub. Reject anything but a positive integer.
  if (c.refreshIntervalSeconds !== undefined &&
      (!Number.isInteger(c.refreshIntervalSeconds) || c.refreshIntervalSeconds < 1)) {
    throw new Error(`config at ${path} has an invalid "refreshIntervalSeconds" (${JSON.stringify(c.refreshIntervalSeconds)}); must be a positive integer`);
  }
  // Build the normalised identities array from whichever shape was provided.
  // Single-identity (old) shape: wrap into a one-element array.
  // Multi-identity (new) shape: resolve each tokenEnv, validate required fields.
  let identities: GithubIdentity[];
  if (github.identities?.length) {
    identities = github.identities.map((id, i) => {
      if (!id.username) throw new Error(`config at ${path} is missing required key "github.identities[${i}].username"`);
      if (!id.tokenEnv) throw new Error(`config at ${path} is missing required key "github.identities[${i}].tokenEnv"`);
      const token = process.env[id.tokenEnv] ?? '';
      if (!token) throw new Error(`config at ${path}: env var "${id.tokenEnv}" for github.identities[${i}] is not set`);
      return { username: id.username, token, repos: id.repos ?? [] };
    });
  } else {
    identities = [{
      username: github.username!,
      token: github.token || process.env.GITHUB_TOKEN || '',
      repos: github.repos ?? [],
    }];
  }

  // fetchPrs iterates allRepos: the top-level github.repos plus every
  // identity's own repos, deduplicated after qualifying bare names with the
  // org. GitHub owner/repo names are case-insensitive, so two spellings that
  // differ only in case are rejected rather than fetched twice.
  const qualify = (r: string) => (r.includes('/') ? r : `${github.org}/${r}`);
  const spelling = new Map<string, string>();
  const allRepos: string[] = [];
  for (const r of [...(github.repos ?? []), ...identities.flatMap(id => id.repos)]) {
    const q = qualify(r), key = q.toLowerCase(), prev = spelling.get(key);
    if (prev === undefined) { spelling.set(key, q); allRepos.push(r); }
    else if (prev !== q) throw new Error(`config at ${path}: github repos "${prev}" and "${q}" differ only in case; list each repo once`);
  }
  // Every repo must have exactly one owning identity (resolveIdentity in
  // github.ts): an explicit repos entry, or else the catch-all (the single
  // identity without repos). No silent fallback to another account.
  if (github.identities?.length) {
    const owner = new Map<string, number>();
    identities.forEach((id, i) => {
      for (const r of id.repos) {
        const key = qualify(r).toLowerCase();
        if ((owner.get(key) ?? i) !== i) throw new Error(`config at ${path}: "${qualify(r)}" is listed under more than one github.identities entry`);
        owner.set(key, i);
      }
    });
    const catchAlls = identities.filter(id => !id.repos.length).length;
    if (catchAlls > 1) throw new Error(`config at ${path}: at most one github.identities entry may omit "repos" (the catch-all identity)`);
    if (!catchAlls) {
      const unowned = (github.repos ?? []).find(r => !owner.has(qualify(r).toLowerCase()));
      if (unowned) throw new Error(`config at ${path}: "${qualify(unowned)}" is in github.repos but no github.identities entry lists it; list it under one identity or add a catch-all identity (an entry without "repos")`);
    }
  }

  const allUsernames = [...new Set(identities.map(id => id.username))];
  const firstIdentity = identities[0]!;

  // Each status is one name or a non-empty list of names. A wrong shape would
  // otherwise silently never match and misroute every card.
  for (const [k, v] of Object.entries(jira.statuses ?? {})) {
    const names = Array.isArray(v) ? v : [v];
    if (!names.length || names.some(n => typeof n !== 'string' || !n.trim())) {
      throw new Error(`config at ${path} has an invalid "jira.statuses.${k}" (${JSON.stringify(v)}); must be a status name or a non-empty list of names`);
    }
  }

  // Off by default: write-back (Jira transitions/comments, PR comments) must
  // be explicitly opted into. See server/writeback.ts's checkWriteGate.
  return {
    jira: {
      baseUrl: jira.baseUrl, email: jira.email, apiToken: jira.apiToken,
      projectKey: jira.projectKey!, accountId: jira.accountId!,
      statuses: { ...DEFAULT_STATUSES, ...(jira.statuses ?? {}) },
    },
    github: {
      token: firstIdentity.token,
      org: github.org!,
      repos: allRepos,
      username: firstIdentity.username,
      identities,
      usernames: allUsernames,
    },
    port,
    demo,
    writeEnabled: Boolean(c.writeEnabled),
    autoTransitionMerged: Boolean(c.autoTransitionMerged),
    refreshIntervalSeconds: c.refreshIntervalSeconds,
    ignoreAuthors: Array.isArray(c.ignoreAuthors) ? c.ignoreAuthors : DEFAULT_IGNORE_AUTHORS,
  };
}
