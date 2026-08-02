import { readFileSync } from 'node:fs';

const DEFAULT_STATUSES = { todo: 'To Do', inTest: 'In Test', done: 'Done' };

export function loadConfig(path = new URL('../config.json', import.meta.url).pathname) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch { throw new Error(`config not found at ${path} — copy config.example.json to config.json and fill it in`); }
  let c;
  try { c = JSON.parse(raw); }
  catch (e) { throw new Error(`config at ${path} is not valid JSON: ${e.message}`); }
  for (const key of ['jira', 'github']) {
    if (!c[key]) throw new Error(`config at ${path} is missing required key "${key}"`);
  }
  c.port ??= 3010;
  c.jira.statuses = { ...DEFAULT_STATUSES, ...(c.jira.statuses ?? {}) };
  c.github.token ||= process.env.GITHUB_TOKEN || '';
  return c;
}
