import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function emptyState() {
  return { cards: {}, celebrated: [], mergedTotal: 0, lastRefreshAt: null, snapshot: null, lastCards: null, lastPrs: null, prLog: {} };
}

// Legacy state files stored `celebrated` as plain id strings ("org/repo#42").
// Migrate them to `{ id, at }` objects so buildSnapshot can report a merge
// timestamp alongside the id; `at: null` marks entries with no known merge
// time (pre-migration merges).
function migrateCelebrated(state) {
  state.celebrated = (state.celebrated ?? []).map(e => (
    typeof e === 'string' ? { id: e, at: null } : e
  ));
  return state;
}

// Older states predate the prLog field: synthesize a minimal entry for every
// celebrated merge so the charts don't lose merge history that predates this
// field. Real PR lifecycle data (openedAt/closedAt) stays unknown for these —
// only mergedAt is recoverable from the celebrated timestamp.
function migratePrLog(state) {
  state.prLog = state.prLog ?? {};
  for (const e of state.celebrated) {
    if (state.prLog[e.id]) continue;
    state.prLog[e.id] = { id: e.id, repo: e.id.split('#')[0], openedAt: null, mergedAt: e.at, closedAt: null };
  }
  return state;
}

// A missing file is the normal first-run case (no warn). An existing but
// unparseable file is a corruption signal: warn and fall back to the
// rotating .bak written by saveState, rather than silently losing overrides.
export function loadState(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch { return emptyState(); }
  try { return migratePrLog(migrateCelebrated({ ...emptyState(), ...JSON.parse(raw) })); }
  catch (e) {
    console.warn(`jira-dash: state file at ${path} is unparseable (${e.message}); falling back to ${path}.bak`);
    try { return migratePrLog(migrateCelebrated({ ...emptyState(), ...JSON.parse(readFileSync(path + '.bak', 'utf8')) })); }
    catch { return emptyState(); }
  }
}

// Only rotate the current file into .bak when it actually parses as JSON.
// Rotating a corrupt current file would overwrite a still-good .bak with
// garbage, destroying the one fallback loadState relies on.
export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  let current;
  try { current = readFileSync(path, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; current = null; }
  if (current !== null) {
    let valid = true;
    try { JSON.parse(current); } catch { valid = false; }
    if (valid) renameSync(path, path + '.bak');
  }
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

// Placeholder shape for GET /api/data (and the CLI's direct-mode `status`)
// before any refresh has ever run, so callers get a well-formed empty board
// instead of null. Documented in docs/API.md as predating closedPrs/prLog —
// intentionally not backfilled here (display-only gap on true first boot).
export function emptySnapshot() {
  return {
    updatedAt: null, errors: { jira: null, github: null },
    buckets: { needs_attention: [], in_progress: [], waiting_review: [], in_qa: [] },
    todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 0, newlyMerged: [], recentActivity: [],
  };
}

export function cardState(state, key) {
  return (state.cards[key] ??= { lastSeenPr: null, lastSeenJira: null, override: null, overrideAt: null });
}
