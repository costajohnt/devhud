import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function emptyState() {
  return { cards: {}, celebrated: [], mergedTotal: 0, lastRefreshAt: null, snapshot: null, lastCards: null, lastPrs: null };
}

// A missing file is the normal first-run case (no warn). An existing but
// unparseable file is a corruption signal: warn and fall back to the
// rotating .bak written by saveState, rather than silently losing overrides.
export function loadState(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch { return emptyState(); }
  try { return { ...emptyState(), ...JSON.parse(raw) }; }
  catch (e) {
    console.warn(`jira-dash: state file at ${path} is unparseable (${e.message}); falling back to ${path}.bak`);
    try { return { ...emptyState(), ...JSON.parse(readFileSync(path + '.bak', 'utf8')) }; }
    catch { return emptyState(); }
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  try { renameSync(path, path + '.bak'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

export function cardState(state, key) {
  return (state.cards[key] ??= { lastSeenPr: null, lastSeenJira: null, override: null, overrideAt: null });
}
