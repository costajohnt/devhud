import { useState } from 'preact/hooks';
import { useData } from './use-data.js';
import { Board } from './board.js';

export function App() {
  const { data, loading, refreshing, connError, refresh } = useData();
  const [selected, setSelected] = useState<string | null>(null);
  const [theme, setTheme] = useState(localStorage.getItem('jira-dash-theme') ?? 'dark');
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
        <Board data={data} selectedKey={selected} onSelect={setSelected} />
      </main>
    </div>
  );
}
