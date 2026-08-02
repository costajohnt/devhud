import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function emptyState() {
  return { cards: {}, celebrated: [], mergedTotal: 0, lastRefreshAt: null, snapshot: null };
}

export function loadState(path) {
  try { return { ...emptyState(), ...JSON.parse(readFileSync(path, 'utf8')) }; }
  catch { return emptyState(); }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

export function cardState(state, key) {
  return (state.cards[key] ??= { lastSeenPr: null, lastSeenJira: null, override: null, overrideAt: null });
}
