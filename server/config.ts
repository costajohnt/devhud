import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config, JiraStatuses } from './types.ts';

const DEFAULT_STATUSES: JiraStatuses = { todo: 'To Do', inTest: 'In Test', done: 'Done' };

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
  github?: { token?: string; org?: string; repos?: string[]; username?: string };
  port?: number;
  demo?: boolean;
  writeEnabled?: boolean;
}

export function loadConfig(path: string = fileURLToPath(new URL('../config.json', import.meta.url))): Config {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch { throw new Error(`config not found at ${path} — copy config.example.json to config.json and fill it in`); }
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
  for (const key of ['username', 'org'] as const) {
    if (!github[key]) throw new Error(`config at ${path} is missing required key "github.${key}"`);
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
  // Off by default: write-back (Jira transitions/comments, PR comments) must
  // be explicitly opted into. See server/writeback.ts's checkWriteGate.
  return {
    jira: {
      baseUrl: jira.baseUrl, email: jira.email, apiToken: jira.apiToken,
      projectKey: jira.projectKey!, accountId: jira.accountId!,
      statuses: { ...DEFAULT_STATUSES, ...(jira.statuses ?? {}) },
    },
    github: {
      token: github.token || process.env.GITHUB_TOKEN || '',
      org: github.org!, repos: github.repos ?? [], username: github.username!,
    },
    port: c.port ?? 3010,
    demo,
    writeEnabled: Boolean(c.writeEnabled),
  };
}
