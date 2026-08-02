import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATUSES = { todo: 'To Do', inTest: 'In Test', done: 'Done' };

export function loadConfig(path = fileURLToPath(new URL('../config.json', import.meta.url))) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch { throw new Error(`config not found at ${path} — copy config.example.json to config.json and fill it in`); }
  let c;
  try { c = JSON.parse(raw); }
  catch (e) { throw new Error(`config at ${path} is not valid JSON: ${e.message}`); }
  for (const key of ['jira', 'github']) {
    if (!c[key]) throw new Error(`config at ${path} is missing required key "${key}"`);
  }
  for (const key of ['projectKey', 'accountId']) {
    if (!c.jira[key]) throw new Error(`config at ${path} is missing required key "jira.${key}"`);
  }
  for (const key of ['username', 'org']) {
    if (!c.github[key]) throw new Error(`config at ${path} is missing required key "github.${key}"`);
  }
  // JIRA_DASH_DEMO is a deprecated alias kept for anyone with it already set
  // in their environment; SIMON_DASH_DEMO is the current name post-rename.
  const demo = Boolean(c.demo) || process.env.SIMON_DASH_DEMO === '1' || process.env.JIRA_DASH_DEMO === '1';
  // Demo mode never talks to real Jira, so requiring these would just make
  // trying the demo harder for no reason. Everyone else needs them, or
  // every real fetch/write fails with a confusing runtime auth error
  // instead of a clear config error up front.
  if (!demo) {
    for (const key of ['baseUrl', 'email', 'apiToken']) {
      if (!c.jira[key]) throw new Error(`config at ${path} is missing required key "jira.${key}"`);
    }
  }
  c.port ??= 3010;
  c.demo = demo;
  // Off by default: write-back (Jira transitions/comments, PR comments) must
  // be explicitly opted into. See server/writeback.js's checkWriteGate.
  c.writeEnabled = Boolean(c.writeEnabled);
  c.jira.statuses = { ...DEFAULT_STATUSES, ...(c.jira.statuses ?? {}) };
  c.github.token ||= process.env.GITHUB_TOKEN || '';
  return c;
}
