// @vitest-environment happy-dom
//
// Renders the real useData() hook in a DOM (happy-dom) with a stubbed
// EventSource, so the wiring the pure applyEvent() tests can't reach —
// onmessage → setData/loading/connError, onRefreshed firing, cleanup on
// unmount — is exercised against the actual hook.
import { test, expect, vi, beforeEach, afterEach, describe } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useData } from './use-data.js';
import type { DashboardData } from './types.js';

class StubEventSource {
  static instances: StubEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = 0; // CONNECTING
  listeners: Record<string, ((ev: { data: string }) => void) | undefined> = {};
  closed = false;
  constructor(public url: string) {
    StubEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (ev: { data: string }) => void) { this.listeners[name] = fn; }
  close() { this.closed = true; this.readyState = 2; }
  // A non-200 response (503 client cap, 403): the browser fires error with
  // readyState already CLOSED and never retries this instance.
  failPermanently() { this.readyState = 2; this.onerror?.(); }
  emit(d: unknown) { this.onmessage?.({ data: JSON.stringify(d) }); }
}

const snap = (updatedAt: string | null, newlyDone: string[] = []): DashboardData => ({
  updatedAt,
  errors: { jira: null, github: null }, queue: [], reviewRequests: [],
  buckets: { needs_attention: [], in_progress: [], self_review: [], waiting_review: [], mergeable: [], qa_ready: [], in_qa: [] },
  todo: [], blocked: [], filed: [], unlinkedPrs: [], doneCards: [], doneTotal: 0, newlyDone, recentActivity: [],
  prLog: [],
});

let hook: ReturnType<typeof useData>;
function Probe() {
  hook = useData();
  return null;
}

let host: HTMLElement;
beforeEach(() => {
  StubEventSource.instances.length = 0;
  vi.stubGlobal('EventSource', StubEventSource);
  host = document.createElement('div');
  act(() => { render(h(Probe, null), host); });
});

const es = () => StubEventSource.instances[0]!;

test('opens one EventSource on /api/events and renders the connect event', () => {
  expect(StubEventSource.instances).toHaveLength(1);
  expect(es().url).toBe('/api/events');
  expect(hook.loading).toBe(true);

  act(() => { es().emit(snap('t1')); });
  expect(hook.loading).toBe(false);
  expect(hook.data?.updatedAt).toBe('t1');
});

test('onRefreshed fires on a fresh refresh but not on the connect replay or a re-broadcast', () => {
  const fired: string[] = [];
  hook.onRefreshed.current = (d) => fired.push(d.updatedAt ?? 'null');

  act(() => { es().emit(snap('t1', ['P-1'])); }); // connect replay: must NOT fire
  expect(fired).toEqual([]);
  act(() => { es().emit(snap('t2')); });          // fresh refresh: fires
  expect(fired).toEqual(['t2']);
  act(() => { es().emit(snap('t2')); });          // action re-broadcast: no refire
  expect(fired).toEqual(['t2']);
});

test('a connection error surfaces in connError and the next message clears it', () => {
  act(() => { es().onerror?.(); });
  expect(hook.connError).toContain('connection lost');

  act(() => { es().emit(snap('t1')); });
  expect(hook.connError).toBeNull();
});

test('unmount closes the EventSource', () => {
  act(() => { render(null, host); });
  expect(es().closed).toBe(true);
});

test('an SSE message supersedes an in-flight manual refresh (stale response discarded)', async () => {
  // Deferred fetch: refresh() is awaiting the network when a fresher SSE
  // snapshot lands. The late response must NOT clobber it.
  let resolveFetch!: (r: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(r => { resolveFetch = r; })));

  let refreshDone: Promise<void>;
  act(() => { refreshDone = hook.refresh(); });
  act(() => { es().emit(snap('fresh-from-sse')); });
  await act(async () => {
    resolveFetch({ ok: true, json: async () => snap('stale-from-refresh') });
    await refreshDone;
  });

  expect(hook.data?.updatedAt).toBe('fresh-from-sse');
});

test('an SSE message supersedes the post-action get() (stale /api/data response discarded)', async () => {
  // The action POST succeeds; its follow-up GET /api/data is still in flight
  // when the server's SSE broadcast of a newer snapshot lands.
  let resolveGet!: (r: unknown) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/action'
    ? Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
    : new Promise(r => { resolveGet = r; })));

  let actDone!: Promise<boolean>;
  await act(async () => {
    actDone = hook.act({ type: 'ack', key: 'P-1' });
    await vi.waitFor(() => expect(resolveGet).toBeTypeOf('function'));
  });
  act(() => { es().emit(snap('fresh-from-sse')); });
  await act(async () => {
    resolveGet({ ok: true, json: async () => snap('stale-from-get') });
    expect(await actDone).toBe(true);
  });

  expect(hook.data?.updatedAt).toBe('fresh-from-sse');
});

test('a tick event advances only updatedAt, without firing onRefreshed', () => {
  const fired: unknown[] = [];
  hook.onRefreshed.current = (d) => fired.push(d);
  act(() => { es().emit(snap('t1', ['P-1'])); });

  act(() => {
    const listener = es().listeners['tick'];
    listener?.({ data: JSON.stringify({ updatedAt: 't2' }) });
  });
  expect(hook.data?.updatedAt).toBe('t2');
  expect(hook.data?.newlyDone).toEqual(['P-1']); // rest of the snapshot untouched
  expect(fired).toEqual([]);
});

test('a torn SSE frame sets connError instead of throwing, and the next good frame clears it', () => {
  act(() => { es().onmessage?.({ data: '{"updatedAt": "tor' }); });
  expect(hook.connError).toContain('connection lost');
  act(() => { es().emit(snap('t1')); });
  expect(hook.connError).toBeNull();
});

test('a permanently closed EventSource is reopened with doubling backoff, reset on open', () => {
  vi.useFakeTimers();
  try {
    act(() => { es().failPermanently(); });
    expect(hook.connError).toBe('connection lost — reconnecting in 2s');
    expect(StubEventSource.instances).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(1999); });
    expect(StubEventSource.instances).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(StubEventSource.instances).toHaveLength(2);
    expect(StubEventSource.instances[1]!.url).toBe('/api/events');

    // Second failure doubles the delay.
    act(() => { StubEventSource.instances[1]!.failPermanently(); });
    expect(hook.connError).toBe('connection lost — reconnecting in 4s');
    act(() => { vi.advanceTimersByTime(4000); });
    expect(StubEventSource.instances).toHaveLength(3);

    // A successful open resets the backoff, and the next message clears the banner.
    const third = StubEventSource.instances[2]!;
    act(() => { third.readyState = 1; third.onopen?.(); third.emit(snap('t1')); });
    expect(hook.connError).toBeNull();
    expect(hook.data?.updatedAt).toBe('t1');
    act(() => { third.failPermanently(); });
    expect(hook.connError).toBe('connection lost — reconnecting in 2s');
  } finally {
    vi.useRealTimers();
  }
});

test('backoff caps at 60s', () => {
  vi.useFakeTimers();
  try {
    for (let i = 0; i < 8; i++) {
      act(() => { StubEventSource.instances.at(-1)!.failPermanently(); });
      act(() => { vi.advanceTimersByTime(60_000); });
    }
    act(() => { StubEventSource.instances.at(-1)!.failPermanently(); });
    expect(hook.connError).toBe('connection lost — reconnecting in 60s');
  } finally {
    vi.useRealTimers();
  }
});

test('unmount during a pending reconnect cancels it', () => {
  vi.useFakeTimers();
  try {
    act(() => { es().failPermanently(); });
    act(() => { render(null, host); });
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(StubEventSource.instances).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test('unmount closes a reopened EventSource, not just the first one', () => {
  vi.useFakeTimers();
  try {
    act(() => { es().failPermanently(); });
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => { render(null, host); });
    expect(StubEventSource.instances[1]!.closed).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

// PR #140: sessions are header-based (per-origin localStorage), obtained by
// trading the one-time ?login= code `devhud open` puts in the URL.
describe('sign-in', () => {
  const remount = async (url: string, fetchImpl: (...a: unknown[]) => Promise<unknown>) => {
    act(() => { render(null, host); });
    StubEventSource.instances.length = 0;
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    history.replaceState(null, '', url);
    const fetchMock = vi.fn(fetchImpl);
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { render(h(Probe, null), host); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return { fetchMock, store };
  };
  afterEach(() => { history.replaceState(null, '', '/'); });

  test('?login= is traded for a session, dropped from the URL, and used on the stream', async () => {
    const { fetchMock, store } = await remount('/?login=abc', () => Promise.resolve({ ok: true, json: () => Promise.resolve({ session: 's1' }) }));
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/session');
    expect(JSON.parse(init.body)).toEqual({ code: 'abc' });
    expect(location.search).toBe('');
    expect(store.get('devhud-session')).toBe('s1');
    expect(es().url).toBe('/api/events?session=s1');
    expect(hook.needsLogin).toBe(false);
  });

  test('a refused code asks for `devhud open` instead of connecting', async () => {
    await remount('/?login=used', () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }));
    expect(hook.needsLogin).toBe(true);
    expect(StubEventSource.instances).toHaveLength(0);
  });

  test('a stream that closes with a 401 asks for `devhud open` and stops retrying', async () => {
    await remount('/', () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }));
    act(() => { es().failPermanently(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(hook.needsLogin).toBe(true);
  });
});
