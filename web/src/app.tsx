import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { LocationProvider, useLocation } from 'preact-iso';
import { useData } from './use-data.js';
import { BUCKET_LABEL } from './types.js';
import type { Bucket } from './types.js';
import { useBoardFilter, BoardStats, BoardFilterBar, BoardList } from './board.js';
import { Detail } from './detail.js';
import { Extras, TodoSection, BlockedSection } from './extras.js';
import { DonePage } from './done.js';
import { FiledPage } from './filed.js';
import { SimonRunsPage, SimonRunPage } from './simon.js';
import { fireConfetti } from './celebrate.js';
import { readStorage, writeStorage } from './storage.js';
import { SkeletonLoader } from './skeleton-loader.js';
import { LazyChartPanel } from './chart-panel-lazy.js';
import {
  decideNotification, showAttentionNotification, notificationsSupported,
  notificationPermission, requestNotificationPermission,
} from './notify.js';

// How often the header re-renders so the relative "Updated Xm ago" label
// ticks — purely cosmetic, no network calls ride this interval.
const RELATIVE_TIME_TICK_MS = 30_000;

const THEME_KEY = 'simon-dash-theme';
const LEGACY_THEME_KEY = 'jira-dash-theme';
const NOTIFY_KEY = 'simon-dash-notify';

// No explicit user preference stored yet: fall back to the OS setting. Mirrors
// the pre-paint script in index.html so the very first render already agrees
// with what that script painted (no flash of the wrong theme). One-time
// migration from the pre-rename key: read it as a fallback and write it
// forward under the new key so nobody's saved theme choice resets.
function getInitialTheme(): string {
  const stored = readStorage(THEME_KEY) ?? readStorage(LEGACY_THEME_KEY);
  if (stored) {
    if (!readStorage(THEME_KEY)) writeStorage(THEME_KEY, stored);
    return stored;
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

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

// decodeURIComponent throws URIError on malformed percent-encoding (/simon/%zz
// from a mangled link); during render that would white-screen the whole app,
// so a bad segment falls through to the not-found branch instead.
function safeDecode(segment: string): string | null {
  try { return decodeURIComponent(segment); } catch { return null; }
}

// Screen-reader text for a successful /api/action call; null for any action
// shape we don't recognize (nothing is announced rather than something vague).
function describeAction(body: object): string | null {
  const b = body as { type?: string; key?: string; bucket?: string };
  if (!b.key) return null;
  switch (b.type) {
    case 'move': {
      const label = b.bucket && b.bucket in BUCKET_LABEL ? BUCKET_LABEL[b.bucket as Bucket] : b.bucket;
      return `Moved ${b.key} to ${label}`;
    }
    case 'ack': return `Acknowledged ${b.key}`;
    case 'unpin': return `Unpinned ${b.key}`;
    default: return null;
  }
}

function AppContent() {
  const { data, loading, refreshing, connError, actionError, actionInFlight, refresh, act, onRefreshed, clearActionError } = useData();
  const [selected, setSelected] = useState<string | null>(null);
  // Polite announcement for successful actions (moves, acks, unpins) — the
  // only feedback otherwise is the card silently relocating, which assistive
  // tech never hears. Failures already announce via the role="alert" banner.
  const [announcement, setAnnouncement] = useState('');
  const announceTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announce = useCallback((message: string) => {
    // A repeat of the identical string is not re-read by most screen readers,
    // so nudge it with a trailing no-break space to register as a change.
    setAnnouncement(prev => (prev === message ? `${message} ` : message));
    if (announceTimeout.current) clearTimeout(announceTimeout.current);
    announceTimeout.current = setTimeout(() => setAnnouncement(''), 7000);
  }, []);
  const announcedAct = async (body: object) => {
    const ok = await act(body);
    if (ok) {
      const message = describeAction(body);
      if (message) announce(message);
    }
    return ok;
  };
  const board = useBoardFilter(data, announcedAct, actionInFlight);
  // Key of the row whose activation opened the detail panel, so closing the
  // panel can hand focus back to that row's button (audit M16).
  const openerKey = useRef<string | null>(null);
  const selectRow = (key: string | null) => {
    openerKey.current = key;
    setSelected(key);
  };
  const closeDetail = () => {
    const candidates = [openerKey.current, selected];
    setSelected(null);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.pr-row-main')];
    for (const key of candidates) {
      const btn = key ? buttons.find(b => b.dataset.rowKey === key) : undefined;
      if (btn) { btn.focus(); break; }
    }
  };
  const { path } = useLocation();
  const [theme, setTheme] = useState(getInitialTheme);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Off unless explicitly turned on, and only meaningful while the browser
  // still says granted — a permission revoked in site settings must not leave
  // the bell showing "on" for a channel that can no longer deliver.
  const [notifyOn, setNotifyOn] = useState(() =>
    readStorage(NOTIFY_KEY) === '1' && notificationPermission() === 'granted');
  const [notifyError, setNotifyError] = useState<string | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    toastTimeout.current = setTimeout(() => setToast(null), 5000);
  }, []);

  // The header button is the only confetti caller with no toast of its own, so
  // a reduced-motion return or a failed chunk load left the click with zero
  // feedback (#54). Say why nothing happened instead.
  const celebrate = useCallback(async () => {
    const outcome = await fireConfetti();
    if (outcome === 'reduced-motion') showToast('Confetti is off while your system asks for reduced motion.');
    else if (outcome === 'failed') showToast('Confetti failed to load — see the console.');
  }, [showToast]);

  useEffect(() => {
    onRefreshed.current = (d) => {
      // Completion — a Jira card reaching Done — is what we celebrate now, not
      // a PR merge (a merge only means the code is ready for QA).
      if (d.newlyDone.length) {
        void fireConfetti();
        showToast(`${d.newlyDone.join(', ')} done 🎉`);
      }
    };
    // onRefreshed is a stable ref from useData, so this still runs once —
    // listed so the dependency array is honest rather than relying on the
    // reader knowing that.
  }, [onRefreshed, showToast]);

  // Purely cosmetic re-render tick so "Updated Xm ago" stays fresh even if
  // the user leaves the tab open without triggering any other re-render.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Glanceable tab title: a backgrounded tab shows "(2) simon" when cards need
  // attention.
  useEffect(() => {
    const n = data?.buckets.needs_attention.length ?? 0;
    document.title = n > 0 ? `(${n}) simon` : 'simon';
  }, [data]);

  // Desktop notification when a card newly enters Needs Attention. The title
  // badge above only helps if the tab is on screen; this is what makes
  // leave-it-running mode work when it isn't. All the rules (skip the connect
  // replay, key-based rather than count-based, only while hidden) live in
  // decideNotification — see notify.ts.
  const seenAttention = useRef<string[] | undefined>(undefined);
  useEffect(() => {
    if (!data) return;
    const cards = data.buckets.needs_attention.map(i => ({ key: i.key, summary: i.summary }));
    const { fire, next } = decideNotification(seenAttention.current, cards, {
      enabled: notifyOn,
      permission: notificationPermission(),
      hidden: document.hidden,
    });
    seenAttention.current = next;
    showAttentionNotification(fire);
  }, [data, notifyOn]);

  // Scroll to top on every route change (e.g. Board <-> Done).
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);

  // Track OS theme changes only while the user hasn't explicitly picked one
  // (no localStorage entry). An explicit toggle below pins the choice and
  // this listener backs off — it re-checks localStorage on every OS event
  // rather than caching "unset" once, so a toggle mid-session stops it.
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = (e: MediaQueryListEvent) => {
      if (readStorage(THEME_KEY)) return;
      const t = e.matches ? 'light' : 'dark';
      setTheme(t);
      document.documentElement.dataset.theme = t;
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Opt-in and remembered. Turning it on requests permission first: a browser
  // prompt fired on page load (rather than on a click) is the pattern users
  // reflexively block, and a denial is permanent for the origin.
  const flipNotify = async () => {
    if (notifyOn) {
      writeStorage(NOTIFY_KEY, '0');
      setNotifyOn(false);
      return;
    }
    const permission = await requestNotificationPermission();
    if (permission !== 'granted') {
      setNotifyError(permission === 'denied'
        ? 'Notifications are blocked for this site — re-allow them in your browser settings.'
        : 'Notification permission was not granted.');
      return;
    }
    writeStorage(NOTIFY_KEY, '1');
    setNotifyOn(true);
  };

  const flipTheme = () => {
    const t = theme === 'dark' ? 'light' : 'dark';
    setTheme(t);
    writeStorage(THEME_KEY, t);
    document.documentElement.dataset.theme = t;
  };

  // connError falls through to the "Server unreachable" branch below (with
  // its Retry button) — without it, a server that's down at page load left
  // the skeleton up forever with the error banner unreachable behind it.
  if (loading && !data && !connError) {
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

  // Acknowledging a Needs Attention card moves it out of that bucket; advance
  // the selection to the next card still needing attention so triage keeps
  // flowing. If it was the last one, leave selection as-is (the acked card,
  // now in another bucket) — the pre-existing fallback behavior.
  const onAct = async (body: object) => {
    const b = body as { type?: string; key?: string };
    let nextKey: string | null = null;
    if (b.type === 'ack' && data) {
      const na = data.buckets.needs_attention;
      const idx = na.findIndex(i => i.key === b.key);
      if (idx >= 0) {
        const neighbor = na[idx + 1] ?? na[idx - 1];
        if (neighbor) nextKey = neighbor.key;
      }
    }
    await announcedAct(body);
    if (nextKey) setSelected(nextKey);
  };

  return (
    <div class="dashboard">
      <header class="dashboard-header">
        <div class="header-brand">
          <img class="header-icon" src="/favicon.svg" alt="" width="32" height="32" />
          <h1>simon</h1>
        </div>
        <div class="header-bar">
          <div class="header-stats">
            <span><span class="val" style={{ color: 'var(--green)' }}>{inFlight}</span> in flight</span>
            <span class="header-sep" />
            <span><span class="val" style={{ color: 'var(--purple)' }}>{data.doneTotal}</span> done</span>
          </div>
          <div class="header-right">
            <a class="header-link" href="/simon">runs</a>
            <span class="last-updated">{formatUpdated(data.updatedAt)}</span>
            <button class="celebrate-btn" onClick={() => { void celebrate(); }} type="button" aria-label="Celebrate" title="Celebrate">
              🎉
            </button>
            {notificationsSupported() && (
              <button
                class="theme-toggle"
                onClick={() => { void flipNotify(); }}
                type="button"
                aria-pressed={notifyOn}
                aria-label={notifyOn ? 'Turn off attention notifications' : 'Turn on attention notifications'}
                title={notifyOn
                  ? 'Notifying when a card needs attention'
                  : 'Notify me when a card needs attention'}
              >
                {notifyOn ? '🔔' : '🔕'}
              </button>
            )}
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
      {notifyError && (
        <div class="error-banner" role="alert">
          <span>{notifyError}</span>
          <button class="error-banner-dismiss" type="button" onClick={() => setNotifyError(null)} aria-label="Dismiss">
            &times;
          </button>
        </div>
      )}
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
        {path === '/done' ? (
          <DonePage data={data} />
        ) : path === '/filed' ? (
          <FiledPage data={data} />
        ) : path === '/simon' ? (
          <SimonRunsPage />
        ) : path.startsWith('/simon/') && safeDecode(path.slice('/simon/'.length)) !== null ? (
          <SimonRunPage id={safeDecode(path.slice('/simon/'.length))!} />
        ) : path === '/' ? (
          <>
            <BoardStats data={data} />
            <BoardFilterBar board={board} />
            <div class="dashboard-content animate-in delay-3">
              <BoardList data={data} selectedKey={selected} onSelect={selectRow} board={board} />
              {selectedItem && (
                <Detail item={selectedItem} onClose={closeDetail} act={onAct} actionInFlight={actionInFlight} />
              )}
            </div>
            <div class="animate-in delay-3">
              <TodoSection data={data} />
              <BlockedSection data={data} />
            </div>
            {data.prLog.length > 0 && (
              <div class="animate-in delay-4">
                <LazyChartPanel prLog={data.prLog} theme={theme} />
              </div>
            )}
            <div class="animate-in delay-4">
              <Extras data={data} />
            </div>
          </>
        ) : (
          <div class="merged-view merged-view--full-width" role="alert">
            <div class="merged-view-header">
              <a href="/" class="merged-view-back">← Back to dashboard</a>
              <div>
                <h2 class="merged-view-title">Page not found</h2>
              </div>
            </div>
            <div class="merged-view-empty">
              <p>
                The path <code>{path}</code> doesn't match any known route. Try the dashboard home, or the
                Done or Filed by me stat cards.
              </p>
            </div>
          </div>
        )}
      </main>
      {/* Live regions must already be in the DOM when text is inserted, or
          screen readers miss the change — so the wrappers always render and
          only their contents come and go. */}
      <div class="toast-region" role="status" aria-live="polite">
        {toast && (
          <div class="celebration-toast">
            <span class="celebration-toast-message">{toast}</span>
            <button type="button" class="celebration-toast-dismiss" aria-label="Dismiss celebration" onClick={() => setToast(null)}>
              &times;
            </button>
          </div>
        )}
      </div>
      <div class="sr-only action-announcer" role="status" aria-live="polite">{announcement}</div>
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
