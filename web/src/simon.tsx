import { useEffect, useState } from 'preact/hooks';
import type { SimonRunDetail, SimonRunsPayload, SimonRunSummary } from './types.js';
import { foldRun, STALE_AFTER_S } from './simon-run-fold.js';

// While a run is live (no run_end yet) the detail page re-fetches the whole
// ledger on this cadence. ponytail: whole-file re-read per poll; add ?offset
// byte-resume if ledgers ever exceed a few MB.
const LIVE_POLL_MS = 1500;

// Attention classes / outcomes → existing pill palette.
function pillClass(cls: string | null): string {
  switch (cls) {
    case 'needs_attention': case 'failed': return 'pill--red';
    case 'needs_input': case 'stale': case 'cancelled': return 'pill--amber';
    case 'in_flight': case 'waiting': return 'pill--blue';
    case 'done_needs_review': case 'done': case 'shipped': return 'pill--green';
    default: return 'pill--muted';
  }
}

function fmtDuration(s: number | null): string {
  if (s === null) return '—';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtTs(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function SimonRunsPage() {
  const [payload, setPayload] = useState<SimonRunsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/simon/runs')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setPayload)
      .catch(e => setError((e as Error).message));
  }, []);

  return (
    <div class="merged-view merged-view--full-width">
      <div class="merged-view-header">
        <a href="/" class="merged-view-back">← Back</a>
        <div>
          <h2 class="merged-view-title">Simon runs</h2>
          {payload?.configured && <span class="merged-view-subtitle">{payload.runs.length} runs</span>}
        </div>
      </div>
      {error ? (
        <div class="merged-view-empty" role="alert">Failed to load runs: {error}</div>
      ) : !payload ? (
        <div class="merged-view-empty">Loading…</div>
      ) : !payload.configured ? (
        <div class="merged-view-empty">
          Simon isn't configured. Add <code>"simon": {'{'} "root": "/path/to/simon/scaffold" {'}'}</code> to config.json
          and restart the server.
        </div>
      ) : payload.runs.length === 0 ? (
        <div class="merged-view-empty">No runs yet. Ledgers land in <code>state/runs/</code> under simon.root once the executor runs.</div>
      ) : (
        <>
          {payload.statusError && (
            <div class="partial-banner" role="status">
              <span>`simon status` unavailable ({payload.statusError}) — classes derived from ledgers.</span>
            </div>
          )}
          <table class="merged-table">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Key</th>
                <th scope="col">Class</th>
                <th scope="col">Outcome</th>
                <th scope="col">Phase</th>
                <th scope="col">Started</th>
                <th scope="col">Duration</th>
              </tr>
            </thead>
            <tbody>
              {payload.runs.map((r: SimonRunSummary) => (
                <tr key={r.id}>
                  <td><a class="merged-table-pr-link" href={`/simon/${encodeURIComponent(r.id)}`}>{r.id}</a></td>
                  <td>{r.key}</td>
                  <td><span class={`pill ${pillClass(r.class)}`}>{r.class ?? '—'}</span></td>
                  <td><span class="merged-table-status">{r.outcome ?? (r.endedAt ? '—' : 'running')}</span></td>
                  <td><span class="merged-table-status">{r.phase ?? '—'}</span></td>
                  <td><span class="merged-table-date">{fmtTs(r.startedAt)}</span></td>
                  <td><span class="merged-table-date">{fmtDuration(r.durationS)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

export function SimonRunPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<SimonRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/simon/runs/${encodeURIComponent(id)}`);
        if (!r.ok) throw new Error(r.status === 404 ? 'run not found' : `HTTP ${r.status}`);
        const d = (await r.json()) as SimonRunDetail;
        if (cancelled) return;
        setDetail(d);
        setError(null);
        // Keep polling while the ledger has no run_end.
        if (!d.events.some(e => e.event === 'run_end')) {
          timer = setTimeout(load, LIVE_POLL_MS);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [id]);

  const fold = detail ? foldRun(detail.events) : null;

  return (
    <div class="merged-view merged-view--full-width">
      <div class="merged-view-header">
        <a href="/simon" class="merged-view-back">← All runs</a>
        <div>
          <h2 class="merged-view-title">{detail?.key ?? id}</h2>
          <span class="merged-view-subtitle">{id}</span>
        </div>
      </div>
      {error ? (
        <div class="merged-view-empty" role="alert">Failed to load run: {error}</div>
      ) : !detail || !fold ? (
        <div class="merged-view-empty">Loading…</div>
      ) : (
        <>
          <div class="simon-run-chips">
            <span class={`pill ${fold.live ? 'pill--blue' : pillClass(fold.outcome)}`}>
              {fold.live ? 'live' : fold.outcome ?? 'ended'}
            </span>
            {fold.live && fold.staleSeconds !== null && fold.staleSeconds > STALE_AFTER_S && (
              <span class="pill pill--amber">possibly stalled — quiet for {fmtDuration(fold.staleSeconds)}</span>
            )}
            {fold.haltedAt && <span class="pill pill--amber">halted at {fold.haltedAt}</span>}
            {fold.source && <span class="pill pill--muted">source: {fold.source}</span>}
            {fold.spawnTotal !== null && <span class="pill pill--muted">{fold.spawnTotal} spawns</span>}
            {fold.gates.map(g => <span key={g} class="pill pill--muted">gate: {g}</span>)}
          </div>
          {fold.budgets && (
            <p class="merged-view-subtitle">
              Budgets: {Object.entries(fold.budgets).map(([k, v]) => `${k}=${String(v)}`).join(', ')}
            </p>
          )}
          <h3 class="simon-section-title">Phases</h3>
          {fold.phases.length === 0 ? (
            <div class="merged-view-empty">No phases yet.</div>
          ) : (
            <table class="merged-table">
              <thead>
                <tr>
                  <th scope="col">Phase</th>
                  <th scope="col">Started</th>
                  <th scope="col">Ended</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Retries</th>
                </tr>
              </thead>
              <tbody>
                {fold.phases.map((p, i) => (
                  <tr key={`${p.phase}-${i}`}>
                    <td>{p.phase}</td>
                    <td><span class="merged-table-date">{fmtTs(p.startedAt)}</span></td>
                    <td><span class="merged-table-date">{p.endedAt ? fmtTs(p.endedAt) : 'running'}</span></td>
                    <td><span class="merged-table-date">{fmtDuration(p.durationS)}</span></td>
                    <td>{p.retries || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {Object.keys(fold.rounds).length > 0 && (
            <>
              <h3 class="simon-section-title">Rounds</h3>
              <div class="simon-run-chips">
                {Object.entries(fold.rounds).map(([name, n]) => (
                  <span key={name} class="pill pill--muted">{name.replace(/_round$/, '')}: {n}</span>
                ))}
              </div>
            </>
          )}
          {fold.spawns.length > 0 && (
            <>
              <h3 class="simon-section-title">Agent spawns</h3>
              <table class="merged-table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Agent</th>
                    <th scope="col">Model</th>
                  </tr>
                </thead>
                <tbody>
                  {fold.spawns.map((s, i) => (
                    <tr key={i}>
                      <td><span class="merged-table-date">{fmtTs(s.ts)}</span></td>
                      <td>{s.agent}</td>
                      <td><span class="merged-table-status">{s.model ?? '—'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
