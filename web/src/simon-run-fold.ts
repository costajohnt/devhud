// Pure fold of a Simon run ledger (ordered SimonEvent[]) into what the detail
// page renders. DOM-free so it's unit-testable; the server deliberately ships
// raw events and all interpretation lives here.
import type { SimonEvent } from './types.js';

// Mirrors the server's staleness cutoff: an in-flight run whose ledger has
// been silent this long is probably stalled.
export const STALE_AFTER_S = 600;

export interface FoldedPhase {
  phase: string;
  startedAt: string;
  endedAt: string | null;
  durationS: number | null;
  retries: number;
}

export interface FoldedRun {
  key: string | null;
  source: string | null;
  outcome: string | null;
  haltedAt: string | null;
  gates: string[];
  budgets: Record<string, unknown> | null;
  spawnTotal: number | null;
  phases: FoldedPhase[];
  rounds: Record<string, number>;
  spawns: { ts: string; agent: string; model: string | null }[];
  live: boolean;
  staleSeconds: number | null;
}

export function foldRun(events: SimonEvent[], now: number = Date.now()): FoldedRun {
  const fold: FoldedRun = {
    key: null, source: null, outcome: null, haltedAt: null,
    gates: [], budgets: null, spawnTotal: null,
    phases: [], rounds: {}, spawns: [],
    live: true, staleSeconds: null,
  };
  for (const e of events) {
    switch (e.event) {
      case 'run_start':
        if (typeof e.key === 'string') fold.key = e.key;
        if (typeof e.source === 'string') fold.source = e.source;
        break;
      case 'run_end':
        fold.live = false;
        if (typeof e.outcome === 'string') fold.outcome = e.outcome;
        if (typeof e.halted_at === 'string' && e.halted_at) fold.haltedAt = e.halted_at;
        break;
      case 'gate_reached':
        if (typeof e.gate === 'string') fold.gates.push(e.gate);
        break;
      case 'budgets': {
        const { ts: _ts, event: _event, ...rest } = e;
        fold.budgets = rest;
        break;
      }
      case 'run_spawns':
        if (typeof e.total === 'number') fold.spawnTotal = e.total;
        break;
      case 'phase_start':
        if (typeof e.phase === 'string') {
          fold.phases.push({ phase: e.phase, startedAt: e.ts, endedAt: null, durationS: null, retries: 0 });
        }
        break;
      case 'phase_end': {
        // Pair with the most recent unclosed phase of the same name (retries
        // restart a phase, so match from the end).
        const open = [...fold.phases].reverse().find(p => p.phase === e.phase && !p.endedAt);
        if (open) {
          open.endedAt = e.ts;
          open.durationS = Math.max(0, Math.round((Date.parse(e.ts) - Date.parse(open.startedAt)) / 1000));
        }
        break;
      }
      case 'phase_retry': {
        const last = fold.phases[fold.phases.length - 1];
        if (last && last.phase === e.phase) last.retries += 1;
        break;
      }
      case 'agent_spawn':
        fold.spawns.push({
          ts: e.ts,
          agent: typeof e.agent === 'string' ? e.agent : '?',
          model: typeof e.model === 'string' ? e.model : null,
        });
        break;
      default:
        if (e.event.endsWith('_round')) {
          fold.rounds[e.event] = (fold.rounds[e.event] ?? 0) + 1;
        }
    }
  }
  const last = events[events.length - 1];
  if (fold.live && last) {
    fold.staleSeconds = Math.max(0, Math.round((now - Date.parse(last.ts)) / 1000));
  }
  return fold;
}
