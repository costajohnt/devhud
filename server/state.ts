import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { State, CelebratedEntry, Snapshot } from './types.ts';

export function emptyState(): State {
  // Null-prototype cards dict: defense in depth against prototype pollution
  // (see the guard in actions.ts). Even with that guard rejecting
  // '__proto__'/'constructor'/'prototype' before a key ever reaches here,
  // a null-prototype object means `state.cards[anyKey]` can never resolve
  // to an inherited accessor like Object.prototype.__proto__ in the first
  // place — cardState()'s `??=` sees a real missing key and assigns
  // normally, no matter what string reaches it.
  return { cards: Object.create(null) as State['cards'], celebrated: [], mergedTotal: 0, lastRefreshAt: null, snapshot: null, lastCards: null, lastPrs: null, prLog: {} };
}

// JSON.parse always produces normal-prototype objects, so the `cards` field
// loaded off disk (or merged in from a parsed file below) needs its
// null prototype re-established after every load — Object.create(null)
// only protects state built fresh via emptyState().
function withNullProtoCards(state: State): State {
  state.cards = Object.assign(Object.create(null), state.cards) as State['cards'];
  return state;
}

// Legacy state files stored `celebrated` as plain id strings ("org/repo#42").
// Migrate them to `{ id, at }` objects so buildSnapshot can report a merge
// timestamp alongside the id; `at: null` marks entries with no known merge
// time (pre-migration merges).
function migrateCelebrated(state: State): State {
  state.celebrated = (state.celebrated ?? []).map((e: CelebratedEntry | string) => (
    typeof e === 'string' ? { id: e, at: null } : e
  ));
  return state;
}

// Older states predate the prLog field: synthesize a minimal entry for every
// celebrated merge so the charts don't lose merge history that predates this
// field. Real PR lifecycle data (openedAt/closedAt) stays unknown for these —
// only mergedAt is recoverable from the celebrated timestamp.
function migratePrLog(state: State): State {
  state.prLog = state.prLog ?? {};
  for (const e of state.celebrated) {
    if (state.prLog[e.id]) continue;
    state.prLog[e.id] = { id: e.id, repo: e.id.split('#')[0] ?? e.id, openedAt: null, mergedAt: e.at, closedAt: null };
  }
  return state;
}

// A missing file is the normal first-run case (no warn). An existing but
// unparseable file is a corruption signal: warn and fall back to the
// rotating .bak written by saveState, rather than silently losing overrides.
export function loadState(path: string): State {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch { return emptyState(); }
  try { return withNullProtoCards(migratePrLog(migrateCelebrated({ ...emptyState(), ...JSON.parse(raw) }))); }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`simon-dash: state file at ${path} is unparseable (${message}); falling back to ${path}.bak`);
    try { return withNullProtoCards(migratePrLog(migrateCelebrated({ ...emptyState(), ...JSON.parse(readFileSync(path + '.bak', 'utf8')) }))); }
    catch { return emptyState(); }
  }
}

// Only rotate the current file into .bak when it actually parses as JSON.
// Rotating a corrupt current file would overwrite a still-good .bak with
// garbage, destroying the one fallback loadState relies on.
export function saveState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  let current: string | null;
  try { current = readFileSync(path, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; current = null; }
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
// instead of null. Must carry every top-level key buildSnapshot() produces —
// board.tsx and friends read fields like closedPrs.length unconditionally,
// so a missing key here crashes the web client on true first boot rather
// than just showing an empty state.
export function emptySnapshot(): Snapshot {
  return {
    updatedAt: null, errors: { jira: null, github: null },
    buckets: { needs_attention: [], in_progress: [], waiting_review: [], in_qa: [] },
    todo: [], unlinkedPrs: [], mergedCards: [], mergedTotal: 0, newlyMerged: [], recentActivity: [],
    closedPrs: [], prLog: [],
  };
}

export function cardState(state: State, key: string) {
  return (state.cards[key] ??= { lastSeenPr: null, lastSeenJira: null, override: null, overrideAt: null });
}
