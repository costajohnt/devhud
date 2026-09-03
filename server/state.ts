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
  return { cards: Object.create(null) as State['cards'], celebrated: [], doneCelebrated: [], lastRefreshAt: null, snapshot: null, lastCards: null, lastPrs: null, prLog: {} };
}

// JSON.parse always produces normal-prototype objects, so the `cards` field
// loaded off disk (or merged in from a parsed file below) needs its
// null prototype re-established after every load — Object.create(null)
// only protects state built fresh via emptyState().
function withNullProtoCards(state: State): State {
  state.cards = Object.assign(Object.create(null), state.cards) as State['cards'];
  // state.json is hand-editable: coerce a non-array ackedReasons to null here
  // at the load boundary so one bad field can't throw inside classifyCard on
  // every subsequent refresh (or silently spread a string into characters in
  // ackReasons). classifyCard filters element junk against STATE_REASONS.
  for (const k of Object.keys(state.cards)) {
    const cs = state.cards[k];
    // A null/non-object entry (plausible hand-edit to "reset" a card) must
    // not throw here — that would send a perfectly parseable file down the
    // corruption path and discard it wholesale. Drop the entry instead;
    // cardState() recreates it on demand.
    if (cs === null || typeof cs !== 'object') {
      console.warn(`simon-dash: card ${k} has a malformed entry in the state file; dropping it`);
      delete state.cards[k];
      continue;
    }
    if (cs.ackedReasons != null && !Array.isArray(cs.ackedReasons)) {
      console.warn(`simon-dash: card ${k} has a malformed ackedReasons in the state file; resetting it`);
      cs.ackedReasons = null;
    }
  }
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

// Pre-blocked snapshots omit the field. The web client reads
// data.blocked.length unconditionally (same as todo), so a missing key
// would crash the board on first load of an old state.json.
function migrateSnapshot(state: State): State {
  if (state.snapshot && !Array.isArray(state.snapshot.blocked)) {
    state.snapshot.blocked = [];
  }
  return state;
}

// A missing file is the normal first-run case (no warn). An existing but
// unparseable file is a corruption signal: warn and fall back to the
// rotating .bak written by saveState, rather than silently losing overrides.
export function loadState(path: string): State {
  const hydrate = (json: string): State =>
    withNullProtoCards(migrateSnapshot(migratePrLog(migrateCelebrated({ ...emptyState(), ...JSON.parse(json) }))));
  const fromBak = (): State | null => {
    try { return hydrate(readFileSync(path + '.bak', 'utf8')); }
    catch { return null; }
  };
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch {
    // A missing state file is the normal first-run case, so no warning when
    // there's no .bak either. But it's ALSO what an interrupted save used to
    // leave behind, and treating that as first-run silently discarded every
    // override, ack horizon and the whole prLog with a good backup sitting
    // right next to it — so check for one before concluding there's nothing.
    const recovered = fromBak();
    if (!recovered) return emptyState();
    console.warn(`simon-dash: state file at ${path} is missing; recovered from ${path}.bak`);
    return recovered;
  }
  try { return hydrate(raw); }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`simon-dash: state file at ${path} is unparseable (${message}); falling back to ${path}.bak`);
    return fromBak() ?? emptyState();
  }
}

// Only copy the current file into .bak when it actually parses as JSON.
// Backing up a corrupt current file would overwrite a still-good .bak with
// garbage, destroying the one fallback loadState relies on.
export function saveState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  let current: string | null;
  try { current = readFileSync(path, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; current = null; }
  if (current !== null) {
    let valid = true;
    try { JSON.parse(current); } catch { valid = false; }
    // Copy, not rename. Renaming the live file out of the way left NO
    // state.json at all until the tmp rename below landed; a crash in that
    // window was unrecoverable data loss. Writing a copy keeps a valid
    // state.json present at every instant: during the .bak write and the tmp
    // write the original is untouched, and the swap itself is one atomic
    // rename. A torn .bak costs nothing — state.json is still good.
    if (valid) writeFileSync(path + '.bak', current);
  }
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

// Placeholder shape for GET /api/data (and the CLI's direct-mode `status`)
// before any refresh has ever run, so callers get a well-formed empty board
// instead of null. Must carry every top-level key buildSnapshot() produces —
// board.tsx and friends read fields like doneCards.length unconditionally,
// so a missing key here crashes the web client on true first boot rather
// than just showing an empty state.
export function emptySnapshot(): Snapshot {
  return {
    updatedAt: null, errors: { jira: null, github: null },
    buckets: { needs_attention: [], in_progress: [], self_review: [], waiting_review: [], mergeable: [], qa_ready: [], in_qa: [] },
    todo: [], blocked: [], unlinkedPrs: [],
    doneCards: [], doneTotal: 0, newlyDone: [], recentActivity: [],
    prLog: [],
  };
}

export function cardState(state: State, key: string) {
  return (state.cards[key] ??= { lastSeenPr: null, lastSeenJira: null, override: null, overrideAt: null });
}
