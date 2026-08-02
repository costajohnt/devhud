import { useEffect, useState } from 'preact/hooks';
import { LocationProvider, Router, Route } from 'preact-iso';
import { useData } from './use-data.js';
import { Board } from './board.js';
import { Detail } from './detail.js';
import { Extras } from './extras.js';
import { MergedPage } from './merged.js';
import { fireConfetti } from './celebrate.js';

export function App() {
  const { data, loading, refreshing, connError, refresh, act, onRefreshed } = useData();
  const [selected, setSelected] = useState<string | null>(null);
  const [theme, setTheme] = useState(localStorage.getItem('jira-dash-theme') ?? 'dark');
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    onRefreshed.current = (d) => {
      if (d.newlyMerged.length) {
        fireConfetti();
        setToast(`${d.newlyMerged.join(', ')} merged 🎉`);
        setTimeout(() => setToast(null), 5000);
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
      {data.errors.jira && <div class="partial-banner" role="status"><span>Jira fetch failed: {data.errors.jira}</span></div>}
      {data.errors.github && <div class="partial-banner" role="status"><span>GitHub fetch failed: {data.errors.github}</span></div>}
      <main class="dashboard-main">
        <div class="dashboard-content">
          <LocationProvider>
            <Router>
              <Route
                path="/"
                component={() => (
                  <>
                    <Board data={data} selectedKey={selected} onSelect={setSelected} />
                    {selectedItem && <Detail item={selectedItem} onClose={() => setSelected(null)} act={act} />}
                    <Extras data={data} />
                  </>
                )}
              />
              <Route path="/merged" component={() => <MergedPage data={data} />} />
            </Router>
          </LocationProvider>
        </div>
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
