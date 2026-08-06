// @vitest-environment happy-dom
//
// Renders the real useData() hook in a DOM (happy-dom) with a stubbed
// EventSource, so the wiring the pure applyEvent() tests can't reach —
// onmessage → setData/loading/connError, onRefreshed firing, cleanup on
// unmount — is exercised against the actual hook.
import { test, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useData } from './use-data.js';
import type { DashboardData } from './types.js';

class StubEventSource {
  static instances: StubEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Record<string, ((ev: { data: string }) => void) | undefined> = {};
  closed = false;
  constructor(public url: string) {
    StubEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (ev: { data: string }) => void) { this.listeners[name] = fn; }
  close() { this.closed = true; }
  emit(d: unknown) { this.onmessage?.({ data: JSON.stringify(d) }); }
}

const snap = (updatedAt: string | null, newlyDone: string[] = []): DashboardData => ({
  updatedAt,
  errors: { jira: null, github: null },
  buckets: { needs_attention: [], in_progress: [], self_review: [], waiting_review: [], mergeable: [], qa_ready: [], in_qa: [] },
  todo: [], unlinkedPrs: [], doneCards: [], doneTotal: 0, newlyDone, recentActivity: [],
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
