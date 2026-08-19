// @vitest-environment happy-dom
//
// Shell-level tests for App: the three top-level render branches (skeleton,
// server-unreachable, board), the tab-title and celebration side effects, and
// the detail panel's action wiring — including Unpin, which reaches
// /api/action through the real useData().act().
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { App } from './app.js';
import type { DashboardData, Item, Bucket } from './types.js';

class StubEventSource {
  static instances: StubEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Record<string, ((ev: { data: string }) => void) | undefined> = {};
  closed = false;
  constructor(public url: string) { StubEventSource.instances.push(this); }
  addEventListener(name: string, fn: (ev: { data: string }) => void) { this.listeners[name] = fn; }
  close() { this.closed = true; }
  emit(d: unknown) { this.onmessage?.({ data: JSON.stringify(d) }); }
}

const emptyBuckets = (): Record<Bucket, Item[]> => ({
  needs_attention: [], in_progress: [], self_review: [], waiting_review: [], mergeable: [], qa_ready: [], in_qa: [],
});

const item = (overrides: Partial<Item> = {}): Item => ({
  key: 'P-1', summary: 'Fix the thing', jiraStatus: 'In Progress', jiraUrl: 'https://j/browse/P-1',
  bucket: 'in_progress', attention: [], newComments: [], comments: [], pr: null,
  createdAt: null, updatedAt: null, daysSinceActivity: null, pinned: false, pinnedAt: null,
  ...overrides,
});

const snap = (overrides: Partial<DashboardData> = {}): DashboardData => ({
  updatedAt: '2026-08-01T00:00:00Z', errors: { jira: null, github: null },
  buckets: emptyBuckets(), todo: [], unlinkedPrs: [], doneCards: [], doneTotal: 0,
  newlyDone: [], recentActivity: [], prLog: [], ...overrides,
});

let host: HTMLElement;
const es = () => StubEventSource.instances[0]!;

// App reads localStorage on its very first render (getInitialTheme), and
// whether the DOM environment supplies one turns out to be Node-version
// dependent: under Node 26 the global came back undefined and every test in
// this file died before rendering, while 22.18 was fine. Supplying our own
// removes the dependency entirely and makes theme state deterministic
// per-test. defineProperty is the fallback for environments where the global
// is already installed and not merely absent.
function installLocalStorage() {
  const store = new Map<string, string>();
  const impl = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  try {
    vi.stubGlobal('localStorage', impl);
  } catch {
    Object.defineProperty(globalThis, 'localStorage', { value: impl, configurable: true, writable: true });
  }
}

beforeEach(() => {
  StubEventSource.instances.length = 0;
  vi.stubGlobal('EventSource', StubEventSource);
  // Reduced motion short-circuits both fireConfetti (no canvas-confetti
  // import) and AnimatedValue's rAF loop, so counts render synchronously.
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('scrollTo', vi.fn());
  installLocalStorage();
  document.title = '';
  host = document.createElement('div');
  document.body.append(host);
  act(() => { render(h(App, null), host); });
});

afterEach(() => {
  // Guarded: if beforeEach ever fails before assigning `host`, teardown
  // shouldn't bury the real error under a second one from rendering into
  // undefined — which is exactly how the localStorage failure above
  // presented in CI.
  if (host) {
    act(() => { render(null, host); });
    host.remove();
  }
  vi.unstubAllGlobals();
});

test('renders the loading skeleton before any snapshot arrives', () => {
  expect(host.querySelector('.skeleton-wrapper')).not.toBeNull();
  expect(host.textContent).toContain('Loading…');
});

test('a connection error with no data yet shows the unreachable state, not a stuck skeleton', () => {
  act(() => { es().onerror?.(); });
  // The skeleton would otherwise sit on top of an error banner nobody can see.
  expect(host.querySelector('.skeleton-wrapper')).toBeNull();
  expect(host.textContent).toContain('Server unreachable.');
  expect(host.querySelector('.shell-retry')).not.toBeNull();
});

test('the connect event renders the board and the in-flight/done counters', () => {
  act(() => { es().emit(snap({ buckets: { ...emptyBuckets(), in_progress: [item()] }, doneTotal: 4 })); });

  expect(host.querySelector('.dashboard')).not.toBeNull();
  expect(host.textContent).toContain('Fix the thing');
  const stats = host.querySelector('.header-stats')!.textContent!;
  expect(stats).toContain('1');
  expect(stats).toContain('in flight');
  expect(stats).toContain('4');
});

test('the runs link sits with the header controls, not among the stats (#52)', () => {
  act(() => { es().emit(snap()); });

  const link = host.querySelector('a.header-link')!;
  expect(link).not.toBeNull();
  expect(link.getAttribute('href')).toBe('/simon');
  // Navigation belongs beside the theme/notify controls. Inside .header-stats
  // it read as a third stat label, which is what #52 reported.
  expect(host.querySelector('.header-right')!.contains(link)).toBe(true);
  expect(host.querySelector('.header-stats')!.contains(link)).toBe(false);
});

test('the tab title carries the needs-attention count and clears when it empties', () => {
  act(() => { es().emit(snap({ buckets: { ...emptyBuckets(), needs_attention: [item({ bucket: 'needs_attention' }), item({ key: 'P-2', bucket: 'needs_attention' })] } })); });
  expect(document.title).toBe('(2) simon');

  act(() => { es().emit(snap({ updatedAt: '2026-08-01T00:05:00Z' })); });
  expect(document.title).toBe('simon');
});

test('a fresh snapshot with newlyDone raises the celebration toast, which is dismissable', () => {
  act(() => { es().emit(snap()); });                                    // connect replay: no toast
  expect(host.querySelector('.celebration-toast')).toBeNull();

  act(() => { es().emit(snap({ updatedAt: '2026-08-01T00:05:00Z', newlyDone: ['P-9'] })); });
  const toast = host.querySelector('.celebration-toast')!;
  expect(toast.textContent).toContain('P-9 done');

  act(() => { host.querySelector('.celebration-toast-dismiss')!.dispatchEvent(new Event('click', { bubbles: true })); });
  expect(host.querySelector('.celebration-toast')).toBeNull();
});

test('the connect replay does not celebrate a persisted newlyDone', () => {
  // newlyDone survives in the persisted snapshot until the next refresh, so
  // the very first event of a page load must not fire the toast.
  act(() => { es().emit(snap({ newlyDone: ['P-9'] })); });
  expect(host.querySelector('.celebration-toast')).toBeNull();
});

test('partial-source failures surface as banners without hiding the board', () => {
  act(() => { es().emit(snap({ errors: { jira: 'Jira 500', github: null }, buckets: { ...emptyBuckets(), in_progress: [item()] } })); });

  expect(host.textContent).toContain('Jira fetch failed: Jira 500');
  expect(host.querySelector('.dashboard')).not.toBeNull();
  expect(host.textContent).toContain('Fix the thing');
});

// --- detail panel + actions ---

function selectFirstRow() {
  act(() => { host.querySelector('.pr-row')!.dispatchEvent(new Event('click', { bubbles: true })); });
}

test('selecting a row opens the detail panel', () => {
  act(() => { es().emit(snap({ buckets: { ...emptyBuckets(), in_progress: [item()] } })); });
  expect(host.querySelector('.pr-detail-fields')).toBeNull();

  selectFirstRow();
  expect(host.querySelector('.pr-detail-fields')).not.toBeNull();
});

test('Unpin is offered only for a pinned card, and posts type: unpin', async () => {
  // Typed params so mock.calls carries the (url, init) tuple rather than [].
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve({ ok: true, json: () => Promise.resolve(snap()) }));
  vi.stubGlobal('fetch', fetchMock);

  act(() => { es().emit(snap({ buckets: { ...emptyBuckets(), in_progress: [item()] } })); });
  selectFirstRow();
  const unpinnedButtons = [...host.querySelectorAll('button')].map(b => b.textContent);
  expect(unpinnedButtons).not.toContain('Unpin');

  // Same card, now pinned — the affordance appears without any local state.
  act(() => {
    es().emit(snap({
      updatedAt: '2026-08-01T00:05:00Z',
      buckets: { ...emptyBuckets(), in_qa: [item({ bucket: 'in_qa', pinned: true, pinnedAt: '2026-07-30T00:00:00Z' })] },
    }));
  });
  const unpin = [...host.querySelectorAll('button')].find(b => b.textContent === 'Unpin');
  expect(unpin).toBeDefined();

  await act(async () => { unpin!.dispatchEvent(new Event('click', { bubbles: true })); });

  const actionCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/action');
  expect(actionCall).toBeDefined();
  const init = actionCall![1] as { method: string; headers: Record<string, string>; body: string };
  expect(init.method).toBe('POST');
  expect(init.headers['content-type']).toBe('application/json');
  expect(JSON.parse(init.body)).toEqual({ type: 'unpin', key: 'P-1' });
});

test('a pinned card shows when it was pinned', () => {
  act(() => {
    es().emit(snap({
      buckets: { ...emptyBuckets(), in_qa: [item({ bucket: 'in_qa', pinned: true, pinnedAt: new Date(Date.now() - 2 * 86400000).toISOString() })] },
    }));
  });
  selectFirstRow();

  const labels = [...host.querySelectorAll('.pr-detail-field-label')].map(l => l.textContent);
  expect(labels).toContain('Pinned');
  const pinnedRow = [...host.querySelectorAll('.pr-detail-field')].find(f => f.textContent?.startsWith('Pinned'))!;
  expect(pinnedRow.textContent).toContain('In QA');
  expect(pinnedRow.textContent).toContain('2d ago');
});

test('a failed action surfaces a dismissable error banner', async () => {
  const fetchSpy = vi.fn(() => Promise.resolve({
    ok: false, status: 400, json: () => Promise.resolve({ error: 'bucket must be one of …' }),
  }));
  vi.stubGlobal('fetch', fetchSpy);

  act(() => { es().emit(snap({ buckets: { ...emptyBuckets(), in_progress: [item()] } })); });
  selectFirstRow();
  const ackBtn = [...host.querySelectorAll('button')].find(b => b.textContent === 'Acknowledge')!;
  await act(async () => { ackBtn.dispatchEvent(new Event('click', { bubbles: true })); });
  // act() flushes the click, but the error is set two microtasks deep (the
  // fetch promise, then res.json()); a second empty flush lets that settle.
  await act(async () => {});

  expect(fetchSpy).toHaveBeenCalled();
  expect(host.textContent).toContain('Action failed: bucket must be one of');
  act(() => { host.querySelector('.error-banner-dismiss')!.dispatchEvent(new Event('click', { bubbles: true })); });
  expect(host.textContent).not.toContain('Action failed');
});

test('unmounting closes the event stream', () => {
  act(() => { render(null, host); });
  expect(es().closed).toBe(true);
});

// --- attention notifications ---

// Minimal Notification stand-in: happy-dom has none, and the app must also
// behave when a browser doesn't either (the bell hides entirely).
class StubNotification {
  static permission = 'default';
  static requested = 0;
  static grantOnRequest = 'granted';
  static fired: { title: string; body?: string; tag?: string }[] = [];
  onclick: (() => void) | null = null;
  constructor(public title: string, public options?: { body?: string; tag?: string }) {
    StubNotification.fired.push({ title, ...options });
  }
  close() {}
  static requestPermission() {
    StubNotification.requested++;
    StubNotification.permission = StubNotification.grantOnRequest;
    return Promise.resolve(StubNotification.permission);
  }
}

function installNotification(permission = 'default', grantOnRequest = 'granted') {
  StubNotification.permission = permission;
  StubNotification.grantOnRequest = grantOnRequest;
  StubNotification.requested = 0;
  StubNotification.fired = [];
  vi.stubGlobal('Notification', StubNotification);
}

// document.hidden is a getter in happy-dom; redefine it per-test.
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

function remount() {
  act(() => { render(null, host); });
  StubEventSource.instances.length = 0;
  act(() => { render(h(App, null), host); });
}

const attentionSnap = (keys: string[], updatedAt = '2026-08-01T00:05:00Z') => snap({
  updatedAt,
  buckets: { ...emptyBuckets(), needs_attention: keys.map(k => item({ key: k, bucket: 'needs_attention' })) },
});

test('the bell is hidden entirely when the browser has no Notification API', () => {
  act(() => { es().emit(snap()); });
  const labels = [...host.querySelectorAll('button')].map(b => b.getAttribute('aria-label'));
  expect(labels.some(l => l?.includes('notifications'))).toBe(false);
});

test('turning the bell on requests permission once and remembers the choice', async () => {
  installNotification('default');
  remount();
  act(() => { es().emit(snap()); });

  const bell = () => [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.includes('notifications'))!;
  expect(bell().getAttribute('aria-pressed')).toBe('false');

  await act(async () => { bell().dispatchEvent(new Event('click', { bubbles: true })); });
  await act(async () => {}); // requestPermission resolves a tick after the click
  expect(StubNotification.requested).toBe(1);
  expect(bell().getAttribute('aria-pressed')).toBe('true');
  expect(localStorage.getItem('simon-dash-notify')).toBe('1');

  // Off again, without re-prompting.
  await act(async () => { bell().dispatchEvent(new Event('click', { bubbles: true })); });
  await act(async () => {});
  expect(bell().getAttribute('aria-pressed')).toBe('false');
  expect(localStorage.getItem('simon-dash-notify')).toBe('0');
  expect(StubNotification.requested).toBe(1);
});

test('a blocked permission explains itself instead of silently doing nothing', async () => {
  installNotification('default', 'denied');
  remount();
  act(() => { es().emit(snap()); });

  const bell = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.includes('notifications'))!;
  await act(async () => { bell.dispatchEvent(new Event('click', { bubbles: true })); });
  await act(async () => {});

  expect(host.textContent).toContain('Notifications are blocked for this site');
  expect(localStorage.getItem('simon-dash-notify')).not.toBe('1');
});

test('a card entering needs_attention on a hidden tab fires one notification', () => {
  installNotification('granted');
  localStorage.setItem('simon-dash-notify', '1');
  remount();
  setHidden(true);

  act(() => { es().emit(attentionSnap(['P-1'], '2026-08-01T00:00:00Z')); }); // connect replay: baseline
  expect(StubNotification.fired).toEqual([]);

  act(() => { es().emit(attentionSnap(['P-1', 'P-2'])); });
  expect(StubNotification.fired).toHaveLength(1);
  expect(StubNotification.fired[0]!.title).toBe('P-2 needs attention');
  expect(StubNotification.fired[0]!.tag).toBe('simon-dash-attention');
});

test('nothing fires while the tab is visible', () => {
  installNotification('granted');
  localStorage.setItem('simon-dash-notify', '1');
  remount();
  setHidden(false);

  act(() => { es().emit(attentionSnap([], '2026-08-01T00:00:00Z')); });
  act(() => { es().emit(attentionSnap(['P-1'])); });
  expect(StubNotification.fired).toEqual([]);
});

test('a granted permission revoked in site settings leaves the bell off', () => {
  // localStorage still says on, but the browser no longer agrees.
  installNotification('denied');
  localStorage.setItem('simon-dash-notify', '1');
  remount();
  act(() => { es().emit(snap()); });

  const bell = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.includes('notifications'))!;
  expect(bell.getAttribute('aria-pressed')).toBe('false');
});
