import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, JiraStatuses, GithubIdentity } from './types.ts';

const DEFAULT_STATUSES: JiraStatuses = { todo: 'To Do', inTest: 'In Test', done: 'Done', canceled: 'Canceled', blocked: 'Blocked' };

// Comment authors whose comments never trigger triage or enter the actionable
// queue: the user themselves and Atlassian's Rovo agent. Overridable via
// config.json's top-level "ignoreAuthors".
const DEFAULT_IGNORE_AUTHORS = ['John', 'Rovo'];

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
    // one entry without repos), or to the first identity if there is none.
    identities?: Array<{ username?: string; tokenEnv?: string; repos?: string[] }>;
  };
  port?: number;
  demo?: boolean;
  writeEnabled?: boolean;
  autoTransitionMerged?: boolean;
  refreshIntervalSeconds?: number;
  ignoreAuthors?: string[];
  // null allowed at parse time: "simon": null is how a hand-edited config
  // disables the block, normalized to undefined below.
  simon?: { root?: string; bin?: string } | null;
}

export function loadConfig(path: string = fileURLToPath(new URL('../config.json', import.meta.url))): Config {
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
      console.warn(`simon-dash: ${path} is readable by group/other (mode ${mode.toString(8)}) and holds live credentials — run \`chmod 600 ${path}\``);
    }
  } catch { /* already handled by the readFileSync above if the file is genuinely missing */ }
  let c: RawConfig;
  try { c = JSON.parse(raw) as RawConfig; }
  catch (e) { throw new Error(`config at ${path} is not valid JSON: ${(e as Error).message}`); }
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
  // JIRA_DASH_DEMO is a deprecated alias kept for anyone with it already set
  // in their environment; SIMON_DASH_DEMO is the current name post-rename.
  const demo = Boolean(c.demo) || process.env.SIMON_DASH_DEMO === '1' || process.env.JIRA_DASH_DEMO === '1';
  // Demo mode never talks to real Jira, so requiring these would just make
  // trying the demo harder for no reason. Everyone else needs them, or
  // every real fetch/write fails with a confusing runtime auth error
  // instead of a clear config error up front.
  if (!demo) {
    for (const key of ['baseUrl', 'email', 'apiToken'] as const) {
      if (!jira[key]) throw new Error(`config at ${path} is missing required key "jira.${key}"`);
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
  // Optional Simon executor block: when present, root is required and must be
  // absolute — it flows into readdir/resolve calls (server/simon.ts) where a
  // relative path would silently depend on the server's cwd. "simon": null is
  // treated as absent (the natural way to null the block out to disable it);
  // any other non-object gets the readable error, not a TypeError.
  const simon = c.simon ?? undefined;
  if (simon !== undefined) {
    if (typeof simon !== 'object' || Array.isArray(simon)) {
      throw new Error(`config at ${path} has an invalid "simon" (${JSON.stringify(simon)}); must be an object like { "root": "/abs/path" }`);
    }
    if (!simon.root || typeof simon.root !== 'string' || !isAbsolute(simon.root)) {
      throw new Error(`config at ${path} has an invalid "simon.root" (${JSON.stringify(simon.root)}); must be an absolute path`);
    }
    // bin flows into execFile's argv[0]; a non-string there only fails at
    // request time with a confusing per-request statusError.
    if (simon.bin !== undefined && (typeof simon.bin !== 'string' || !simon.bin)) {
      throw new Error(`config at ${path} has an invalid "simon.bin" (${JSON.stringify(simon.bin)}); must be a non-empty string`);
    }
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

  // fetchPrs iterates this list: the top-level github.repos plus every
  // identity's own repos. A catch-all identity (no repos) owns the top-level
  // entries no explicit identity claims (resolveIdentity in github.ts); more
  // than one catch-all would make that ownership ambiguous.
  if (identities.filter(id => !id.repos.length).length > 1) {
    throw new Error(`config at ${path}: at most one github.identities entry may omit "repos" (the catch-all identity)`);
  }
  const allRepos = [...new Set([...(github.repos ?? []), ...identities.flatMap(id => id.repos)])];

  const allUsernames = [...new Set(identities.map(id => id.username))];
  const firstIdentity = identities[0]!;

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
    simon: simon ? { root: simon.root!, bin: simon.bin ?? 'simon' } : undefined,
  };
}
