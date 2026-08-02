import { useEffect, useRef, useState } from 'preact/hooks';
import { LocationProvider, useLocation } from 'preact-iso';
import { useData } from './use-data.js';
import { useBoardFilter, BoardStats, BoardFilterBar, BoardList } from './board.js';
import { Detail } from './detail.js';
import { Extras } from './extras.js';
import { MergedPage } from './merged.js';
import { fireConfetti } from './celebrate.js';
import { SkeletonLoader } from './skeleton-loader.js';
import { LazyChartPanel } from './chart-panel-lazy.js';

// How often the header re-renders so the relative "Updated Xm ago" label
// ticks — purely cosmetic, no network calls ride this interval.
const RELATIVE_TIME_TICK_MS = 30_000;

function formatUpdated(iso: string | null): string {
  if (!iso) return 'Never refreshed';
  const ts = Date.parse(iso);
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'Updated just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${new Date(ts).toLocaleString()}`;
}

// preact-iso's <Router>/<Route> memoize the rendered route on
// [url, JSON.stringify(matchProps)] and freeze the FIRST render's closure —
// an inline `component={() => (...)}` referencing outer state (data, board,
// selected) never sees later updates, so clicks/search/refresh silently do
// nothing after mount. Reading `path` from useLocation() and branching in
// plain JS (as the reference dashboard this app follows does) sidesteps
// that memoization entirely.
function AppContent() {
  const { data, loading, refreshing, connError, actionError, actionInFlight, refresh, act, onRefreshed, clearActionError } = useData();
  const [selected, setSelected] = useState<string | null>(null);
  const board = useBoardFilter(data, act, actionInFlight);
  const { path } = useLocation();
  const [theme, setTheme] = useState(localStorage.getItem('jira-dash-theme') ?? 'dark');
  const [toast, setToast] = useState<string | null>(null);
  const toastTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onRefreshed.current = (d) => {
      if (d.newlyMerged.length) {
        fireConfetti();
        setToast(`${d.newlyMerged.join(', ')} merged 🎉`);
        if (toastTimeout.current) clearTimeout(toastTimeout.current);
        toastTimeout.current = setTimeout(() => setToast(null), 5000);
      }
    };
  }, []);

  // Purely cosmetic re-render tick so "Updated Xm ago" stays fresh even if
  // the user leaves the tab open without triggering any other re-render.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Glanceable tab title: a backgrounded tab shows "(2) jira-dash" when
  // cards need attention.
  useEffect(() => {
    const n = data?.buckets.needs_attention.length ?? 0;
    document.title = n > 0 ? `(${n}) jira-dash` : 'jira-dash';
  }, [data]);

  // Scroll to top on every route change (e.g. Board <-> Merged).
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);

  const flipTheme = () => {
    const t = theme === 'dark' ? 'light' : 'dark';
    setTheme(t);
    localStorage.setItem('jira-dash-theme', t);
    document.documentElement.dataset.theme = t;
  };

  if (loading && !data) {
    return (
      <div class="skeleton-wrapper">
        <SkeletonLoader />
        <div class="shell-center shell-center--skeleton">
          <p class="shell-status">Loading…</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div class="shell-center" role="alert">
        <p class="shell-status shell-error">Server unreachable.</p>
        <button class="shell-retry" type="button" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  const inFlight = Object.values(data.buckets).flat().length;
  const selectedItem = selected
    ? Object.values(data.buckets).flat().find(i => i.key === selected) ?? null
    : null;

  return (
    <div class="dashboard">
      <header class="dashboard-header">
        <div class="header-brand">
          <img class="header-icon" src="/favicon.svg" alt="" width="32" height="32" />
          <h1>jira-dash</h1>
        </div>
        <div class="header-bar">
          <div class="header-stats">
            <span><span class="val" style={{ color: 'var(--green)' }}>{inFlight}</span> in flight</span>
            <span class="header-sep" />
            <span><span class="val" style={{ color: 'var(--purple)' }}>{data.mergedTotal}</span> merged</span>
          </div>
          <div class="header-right">
            <span class="last-updated">{formatUpdated(data.updatedAt)}</span>
            <button class="celebrate-btn" onClick={() => { fireConfetti(); }} type="button" aria-label="Celebrate" title="Celebrate">
              🎉
            </button>
            <button class="theme-toggle" onClick={flipTheme} type="button" aria-label="Toggle theme">
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            <button class="refresh-btn" onClick={refresh} disabled={refreshing} type="button">
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
      </header>
      {connError && <div class="error-banner" role="alert"><span>Refresh failed ({connError}) — showing last data.</span></div>}
      {actionError && (
        <div class="error-banner" role="alert">
          <span>{actionError}</span>
          <button class="error-banner-dismiss" type="button" onClick={clearActionError} aria-label="Dismiss">
            &times;
          </button>
        </div>
      )}
      {data.errors.jira && <div class="partial-banner" role="status"><span>Jira fetch failed: {data.errors.jira}</span></div>}
      {data.errors.github && <div class="partial-banner" role="status"><span>GitHub fetch failed: {data.errors.github}</span></div>}
      <main id="main-content" class="dashboard-main">
        {path === '/merged' ? (
          <MergedPage data={data} />
        ) : (
          <>
            <BoardStats data={data} />
            <BoardFilterBar board={board} />
            <div class="dashboard-content animate-in delay-3">
              <BoardList data={data} selectedKey={selected} onSelect={setSelected} board={board} />
              {selectedItem && (
                <Detail item={selectedItem} onClose={() => setSelected(null)} act={act} actionInFlight={actionInFlight} />
              )}
            </div>
            {data.mergedLog.length > 0 && (
              <div class="animate-in delay-4">
                <LazyChartPanel mergedLog={data.mergedLog} theme={theme} />
              </div>
            )}
            <div class="animate-in delay-4">
              <Extras data={data} />
            </div>
          </>
        )}
      </main>
      {toast && (
        <div class="celebration-toast" role="status" aria-live="polite">
          <span class="celebration-toast-message">{toast}</span>
          <button type="button" class="celebration-toast-dismiss" aria-label="Dismiss celebration" onClick={() => setToast(null)}>
            &times;
          </button>
        </div>
      )}
    </div>
  );
}

export function App() {
  return (
    <LocationProvider>
      <a class="skip-link" href="#main-content">
        Skip to main content
      </a>
      <AppContent />
    </LocationProvider>
  );
}
