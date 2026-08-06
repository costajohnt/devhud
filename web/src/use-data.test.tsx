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
  closed = false;
  constructor(public url: string) {
    StubEventSource.instances.push(this);
  }
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
