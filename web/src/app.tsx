import { useEffect, useRef, useState } from 'preact/hooks';
import { LocationProvider, useLocation } from 'preact-iso';
import { useData } from './use-data.js';
import { useBoardFilter, BoardStats, BoardFilterBar, BoardList } from './board.js';
import { Detail } from './detail.js';
import { Extras } from './extras.js';
import { MergedPage } from './merged.js';
import { fireConfetti } from './celebrate.js';

// preact-iso's <Router>/<Route> memoize the rendered route on
// [url, JSON.stringify(matchProps)] and freeze the FIRST render's closure —
// an inline `component={() => (...)}` referencing outer state (data, board,
// selected) never sees later updates, so clicks/search/refresh silently do
// nothing after mount. Reading `path` from useLocation() and branching in
// plain JS (as the reference dashboard this app follows does) sidesteps
// that memoization entirely.
function AppContent() {
  const { data, loading, refreshing, connError, actionError, actionInFlight, refresh, act, onRefreshed } = useData();
  const [selected, setSelected] = useState<string | null>(null);
  const board = useBoardFilter(data, act);
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

  const flipTheme = () => {
    const t = theme === 'dark' ? 'light' : 'dark';
    setTheme(t);
    localStorage.setItem('jira-dash-theme', t);
    document.documentElement.dataset.theme = t;
  };

  if (loading) {
    return (
      <div class="shell-center">
        <p class="shell-status">Loading…</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div class="shell-center" role="alert">
        <p class="shell-status shell-error">Server unreachable.</p>
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
          <h1>jira-dash</h1>
        </div>
        <div class="header-bar">
          <div class="header-stats">
            <span><span class="val" style={{ color: 'var(--green)' }}>{inFlight}</span> in flight</span>
            <span class="header-sep" />
            <span><span class="val" style={{ color: 'var(--purple)' }}>{data.mergedTotal}</span> merged</span>
          </div>
          <div class="header-right">
            <span class="last-updated">
              {data.updatedAt ? `Updated ${new Date(data.updatedAt).toLocaleTimeString()}` : 'Never refreshed'}
            </span>
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
      {actionError && <div class="error-banner" role="alert"><span>{actionError}</span></div>}
      {data.errors.jira && <div class="partial-banner" role="status"><span>Jira fetch failed: {data.errors.jira}</span></div>}
      {data.errors.github && <div class="partial-banner" role="status"><span>GitHub fetch failed: {data.errors.github}</span></div>}
      <main class="dashboard-main">
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
      <AppContent />
    </LocationProvider>
  );
}
