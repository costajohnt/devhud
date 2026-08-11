// Simon executor run data: reads the append-only JSONL ledgers the Go
// orchestrator writes to <simon.root>/state/runs/<UTC-ts>-<KEY>.jsonl and,
// when the simon binary is reachable, joins on `simon status --json` so the
// class shown here is the executor's own attention classifier, never a
// reimplementation. Detail views get the raw parsed events; all timeline
// interpretation happens client-side (web/src/simon-run-fold.ts).
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Config, SimonEvent, SimonRunDetail, SimonRunsPayload, SimonRunSummary } from './types.ts';

const execFile = promisify(execFileCb);
export type ExecFn = typeof execFile;

// A run whose ledger hasn't grown in this long, with no run_end, is flagged
// stale rather than in_flight — phases heartbeat far more often than this.
const STALE_AFTER_MS = 10 * 60 * 1000;

// Ledger basenames are <UTC-ts>-<KEY>.jsonl; anything outside this set is
// either not a run id or a path-traversal attempt.
const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

// Run ids are <UTC-ts>-<KEY> with a fixed-width timestamp prefix in Go's
// 2006-01-02T150405Z reference form (e.g. 2026-08-01T100000Z-PROJ-1).
const RUN_ID_TS_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{6}Z-/;

function runsDir(root: string): string {
  return join(root, 'state', 'runs');
}

// Fallback when a ledger has no run_start line (truncated first line, run
// crashed before flush): recover the work-item key from the id itself.
function keyFromId(id: string): string {
  return id.replace(RUN_ID_TS_PREFIX_RE, '');
}

// Malformed/blank lines are skipped, not fatal: the ledger is telemetry and
// the Go side treats read tolerance as caller policy.
async function parseLedger(path: string): Promise<SimonEvent[]> {
  const events: SimonEvent[] = [];
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SimonEvent;
      if (e && typeof e === 'object' && typeof e.event === 'string') events.push(e);
    } catch { /* skip malformed line */ }
  }
  return events;
}

function summarize(id: string, events: SimonEvent[]): SimonRunSummary {
  const start = events.find(e => e.event === 'run_start');
  const end = events.find(e => e.event === 'run_end');
  let phase: string | null = null;
  for (const e of events) if (e.event === 'phase_start' && typeof e.phase === 'string') phase = e.phase;
  const startedAt = (start?.ts as string) ?? (events[0]?.ts as string) ?? null;
  const lastEventAt = (events[events.length - 1]?.ts as string) ?? null;
  const endedAt = (end?.ts as string) ?? null;
  const durationEnd = endedAt ?? lastEventAt;
  const durationS = startedAt && durationEnd
    ? Math.max(0, Math.round((Date.parse(durationEnd) - Date.parse(startedAt)) / 1000))
    : null;
  return {
    id,
    key: typeof start?.key === 'string' ? start.key : keyFromId(id),
    startedAt,
    endedAt,
    outcome: typeof end?.outcome === 'string' ? end.outcome : null,
    haltedAt: typeof end?.halted_at === 'string' ? end.halted_at : null,
    phase,
    class: null, // filled in by listRuns
    durationS,
    lastEventAt,
  };
}

// Fallback class when `simon status --json` is unavailable: terminal runs get
// their outcome verbatim; live ones split on ledger staleness. An unparsable
// or missing last timestamp counts as stale — unknown recency must not read
// as alive, or a corrupt ledger shows in_flight forever.
function fallbackClass(run: SimonRunSummary, now: number): string {
  if (run.endedAt) return run.outcome ?? 'ended';
  const last = run.lastEventAt ? Date.parse(run.lastEventAt) : NaN;
  if (Number.isNaN(last) || now - last > STALE_AFTER_MS) return 'stale';
  return 'in_flight';
}

async function statusClasses(cfg: NonNullable<Config['simon']>, execFn: ExecFn): Promise<Map<string, string>> {
  const { stdout } = await execFn(cfg.bin, ['status', '--json'], {
    env: { ...process.env, SIMON_ROOT: cfg.root },
    timeout: 5000,
  });
  const report = JSON.parse(stdout) as { items?: { key?: string; class?: string }[] };
  const map = new Map<string, string>();
  for (const item of report.items ?? []) {
    if (item.key && item.class) map.set(item.key, item.class);
  }
  return map;
}

export async function listRuns(config: Config, execFn: ExecFn = execFile): Promise<SimonRunsPayload> {
  if (!config.simon) return { configured: false, runs: [] };
  // Kick off the subprocess before the ledger scan: the two are independent,
  // so the exec round trip (up to its 5s timeout) overlaps the file reads.
  const classesPromise = statusClasses(config.simon, execFn);
  // A rejection that lands while we're still scanning must not become an
  // unhandled rejection; the real error is picked up at the await below.
  classesPromise.catch(() => {});
  const dir = runsDir(config.simon.root);
  let names: string[];
  try {
    names = (await readdir(dir)).filter(n => n.endsWith('.jsonl'));
  } catch {
    // Runs dir missing is the day-one state (no runs yet), not an error.
    return { configured: true, runs: [] };
  }
  const runs: SimonRunSummary[] = [];
  for (const name of names) {
    try {
      runs.push(summarize(name.slice(0, -6), await parseLedger(join(dir, name))));
    } catch { /* unreadable ledger: skip rather than fail the whole list */ }
  }
  // Timestamp-prefixed ids sort lexicographically; newest first.
  runs.sort((a, b) => b.id.localeCompare(a.id));

  let statusError: string | undefined;
  let classes = new Map<string, string>();
  try {
    classes = await classesPromise;
  } catch (e) {
    statusError = (e as Error).message;
  }
  const now = Date.now();
  // The attention report classifies the LATEST run per key; runs sort newest
  // first, so attach each key's class to its first occurrence only.
  const seenKeys = new Set<string>();
  for (const run of runs) {
    const cls = !seenKeys.has(run.key) ? classes.get(run.key) : undefined;
    seenKeys.add(run.key);
    run.class = cls ?? fallbackClass(run, now);
  }
  const payload: SimonRunsPayload = { configured: true, runs };
  if (statusError) payload.statusError = statusError;
  return payload;
}

export async function readRun(config: Config, id: string): Promise<SimonRunDetail | null> {
  if (!config.simon || !RUN_ID_RE.test(id)) return null;
  const dir = resolve(runsDir(config.simon.root));
  // Same containment guard as the static-file branch in index.ts: the regex
  // already excludes separators, but belt-and-suspenders on a path we readFile.
  const p = resolve(dir, `${id}.jsonl`);
  if (!p.startsWith(dir + sep)) return null;
  let events: SimonEvent[];
  try {
    events = await parseLedger(p);
  } catch {
    return null;
  }
  const start = events.find(e => e.event === 'run_start');
  return {
    id,
    key: typeof start?.key === 'string' ? start.key : keyFromId(id),
    events,
  };
}
