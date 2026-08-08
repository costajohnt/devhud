// @vitest-environment happy-dom
//
// Component tests for the board: the drag-and-drop drop handler (which
// constructs the /api/action payload), the filter/search derivations, and the
// rendered row/stat markup. All of this rode on manual testing until the SSE
// work brought a DOM environment into the repo.
import { test, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useBoardFilter, BoardList, BoardStats, ago } from './board.js';
import type { DashboardData, Item, Bucket, PrRef } from './types.js';

const pr = (overrides: Partial<PrRef> = {}): PrRef => ({
  repo: 'acme/webapp', number: 12, url: 'https://github.com/acme/webapp/pull/12', branch: 'b',
  state: 'open', ciStatus: 'passing', reviewState: 'none', isDraft: false, ...overrides,
});

const item = (overrides: Partial<Item> = {}): Item => ({
  key: 'P-1', summary: 'Fix the thing', jiraStatus: 'In Progress', jiraUrl: 'https://j/browse/P-1',
  bucket: 'in_progress', attention: [], newComments: [], comments: [], pr: null,
  createdAt: null, updatedAt: null, daysSinceActivity: null, pinned: false, pinnedAt: null,
  ...overrides,
});

const emptyBuckets = (): Record<Bucket, Item[]> => ({
  needs_attention: [], in_progress: [], self_review: [], waiting_review: [], mergeable: [], qa_ready: [], in_qa: [],
});

const data = (buckets: Partial<Record<Bucket, Item[]>> = {}): DashboardData => ({
  updatedAt: '2026-08-01T00:00:00Z', errors: { jira: null, github: null },
  buckets: { ...emptyBuckets(), ...buckets },
  todo: [], unlinkedPrs: [], doneCards: [], doneTotal: 3, newlyDone: [], recentActivity: [], prLog: [],
});

// A DragEvent stand-in: happy-dom has no DataTransfer, and the handlers only
// ever touch getData/setData/effectAllowed/dropEffect/preventDefault.
const dragEvent = (key?: string) => {
  const store = new Map<string, string>();
  if (key !== undefined) store.set('text/plain', key);
  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      setData: (k: string, v: string) => store.set(k, v),
      getData: (k: string) => store.get(k) ?? '',
      effectAllowed: '', dropEffect: '',
    },
  } as unknown as DragEvent;
};

let board: ReturnType<typeof useBoardFilter>;
let host: HTMLElement;

function mountFilter(d: DashboardData | null, actFn: (b: object) => Promise<void>, inFlight = false) {
  function Probe() {
    board = useBoardFilter(d, actFn, inFlight);
    return null;
  }
  host = document.createElement('div');
  act(() => { render(h(Probe, null), host); });
}

beforeEach(() => {
  // Reduced motion keeps AnimatedValue synchronous (no rAF) so stat counts
  // are assertable on first render.
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
});

// --- drop handler: the payload that reaches /api/action ---

test('dropping a card on another bucket issues a move with that bucket', () => {
  const actFn = vi.fn(async () => {});
  mountFilter(data({ in_progress: [item()] }), actFn);

  act(() => { board.onSectionDrop(dragEvent('P-1'), 'in_qa'); });

  expect(actFn).toHaveBeenCalledTimes(1);
  expect(actFn).toHaveBeenCalledWith({ type: 'move', key: 'P-1', bucket: 'in_qa' });
});

test('dropping a card back on the bucket it already occupies is a no-op', () => {
  const actFn = vi.fn(async () => {});
  mountFilter(data({ in_progress: [item()] }), actFn);

  act(() => { board.onSectionDrop(dragEvent('P-1'), 'in_progress'); });

  expect(actFn).not.toHaveBeenCalled();
});

test('a drop while another action is in flight is ignored rather than queued', () => {
  const actFn = vi.fn(async () => {});
  mountFilter(data({ in_progress: [item()] }), actFn, true);

  act(() => { board.onSectionDrop(dragEvent('P-1'), 'in_qa'); });

  expect(actFn).not.toHaveBeenCalled();
});

test('a drop carrying no card key does nothing', () => {
  const actFn = vi.fn(async () => {});
  mountFilter(data({ in_progress: [item()] }), actFn);

  act(() => { board.onSectionDrop(dragEvent(), 'in_qa'); });

  expect(actFn).not.toHaveBeenCalled();
});

test('onRowDragStart puts the card key on the drag payload', () => {
  mountFilter(data({ in_progress: [item()] }), vi.fn(async () => {}));
  const e = dragEvent();
  act(() => { board.onRowDragStart(e, 'P-1'); });
  expect(e.dataTransfer!.getData('text/plain')).toBe('P-1');
  expect(e.dataTransfer!.effectAllowed).toBe('move');
});

// --- drag highlight counter ---

test('the drop highlight survives dragenter/dragleave churn over child elements', () => {
  mountFilter(data({ in_progress: [item()] }), vi.fn(async () => {}));

  // Pointer crosses the section, then a child inside it: two enters, one leave.
  act(() => { board.onSectionDragEnter('in_qa'); });
  expect(board.dragOverBucket).toBe('in_qa');
  act(() => { board.onSectionDragEnter('in_qa'); });
  act(() => { board.onSectionDragLeave('in_qa'); });
  expect(board.dragOverBucket).toBe('in_qa'); // still inside: counter is 1

  act(() => { board.onSectionDragLeave('in_qa'); });
  expect(board.dragOverBucket).toBeNull(); // truly left: counter back to 0
});

// --- filtering ---

test('search matches key and summary case-insensitively, and counts reflect it', () => {
  const d = data({ in_progress: [item({ key: 'P-1', summary: 'Fix login' }), item({ key: 'P-2', summary: 'Charts' })] });
  mountFilter(d, vi.fn(async () => {}));

  expect(board.total).toBe(2);
  act(() => { board.setQ('LOGIN'); });
  expect(board.shown).toBe(1);
  expect(d.buckets.in_progress.filter(board.match).map(i => i.key)).toEqual(['P-1']);

  act(() => { board.setQ('p-2'); });
  expect(d.buckets.in_progress.filter(board.match).map(i => i.key)).toEqual(['P-2']);
});

test('the repo filter hides cards with no linked PR, and repos are distinct and sorted', () => {
  const d = data({
    in_progress: [
      item({ key: 'P-1', pr: pr({ repo: 'acme/webapp' }) }),
      item({ key: 'P-2', pr: pr({ repo: 'acme/api' }) }),
      item({ key: 'P-3', pr: null }),
      item({ key: 'P-4', pr: pr({ repo: 'acme/webapp' }) }),
    ],
  });
  mountFilter(d, vi.fn(async () => {}));

  expect(board.repos).toEqual(['acme/api', 'acme/webapp']);

  act(() => { board.setRepoFilter('acme/webapp'); });
  expect(d.buckets.in_progress.filter(board.match).map(i => i.key)).toEqual(['P-1', 'P-4']);
});

test('the status filter narrows to one bucket', () => {
  const d = data({ in_progress: [item({ key: 'P-1' })], mergeable: [item({ key: 'P-2', bucket: 'mergeable' })] });
  mountFilter(d, vi.fn(async () => {}));

  act(() => { board.setStatusFilter('mergeable'); });
  expect(board.shown).toBe(1);
  expect(d.buckets.mergeable.filter(board.match).map(i => i.key)).toEqual(['P-2']);
});

// --- rendered markup ---

function mountList(d: DashboardData, onSelect = vi.fn()) {
  function Harness() {
    const b = useBoardFilter(d, vi.fn(async () => {}), false);
    return h(BoardList, { data: d, selectedKey: null, onSelect, board: b });
  }
  host = document.createElement('div');
  document.body.append(host);
  act(() => { render(h(Harness, null), host); });
  return onSelect;
}

test('every external PR link carries rel="noopener noreferrer"', () => {
  mountList(data({
    in_progress: [item({ key: 'P-1', pr: pr() })],
    mergeable: [item({ key: 'P-2', bucket: 'mergeable', pr: pr({ number: 34, reviewState: 'approved' }) })],
  }));

  const links = [...host.querySelectorAll('a[target="_blank"]')];
  expect(links.length).toBe(2);
  // The audit found this drifted on exactly one anchor; assert on all of them
  // rather than a representative sample.
  for (const a of links) expect(a.getAttribute('rel')).toBe('noopener noreferrer');
});

test('clicking a row selects it; clicking its PR link does not', () => {
  const onSelect = mountList(data({ in_progress: [item({ key: 'P-1', pr: pr() })] }));

  const row = host.querySelector('.pr-row')!;
  act(() => { row.dispatchEvent(new Event('click', { bubbles: true })); });
  expect(onSelect).toHaveBeenCalledWith('P-1');

  onSelect.mockClear();
  const link = host.querySelector('a[target="_blank"]')!;
  act(() => { link.dispatchEvent(new Event('click', { bubbles: true })); });
  expect(onSelect).not.toHaveBeenCalled(); // stopPropagation keeps the row out of it
});

test('rows are keyboard-operable with Enter and Space', () => {
  const onSelect = mountList(data({ in_progress: [item({ key: 'P-1' })] }));
  const row = host.querySelector('.pr-row')!;
  expect(row.getAttribute('tabindex')).toBe('0');

  for (const key of ['Enter', ' ']) {
    onSelect.mockClear();
    act(() => { row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
    expect(onSelect).toHaveBeenCalledWith('P-1');
  }
});

test('CI failing outranks a merged pill, and unread comments outrank both', () => {
  mountList(data({
    in_progress: [
      item({ key: 'P-1', pr: pr({ ciStatus: 'failing' }) }),
      item({ key: 'P-2', pr: pr({ state: 'merged' }) }),
      item({ key: 'P-3', pr: pr({ state: 'merged' }), newComments: [{ source: 'github', author: 'a', body: 'b', createdAt: null }] }),
    ],
  }));

  const pills = [...host.querySelectorAll('.pill')].map(p => p.textContent);
  expect(pills).toEqual(['CI Failing', 'Merged', '1 new comment']);
});

test('an empty board renders the empty state instead of empty sections', () => {
  mountList(data());
  expect(host.querySelector('.pr-list-empty')?.textContent).toBe('No cards to display');
  expect(host.querySelectorAll('.pr-section')).toHaveLength(0);
});

test('stat cards link to their section only when the bucket has cards', () => {
  const d = data({ in_progress: [item()] });
  host = document.createElement('div');
  act(() => { render(h(BoardStats, { data: d }), host); });

  const cards = [...host.querySelectorAll('.stat-card')];
  const inProgress = cards.find(c => c.textContent?.includes('In Progress'))!;
  const mergeable = cards.find(c => c.textContent?.includes('Mergeable'))!;
  expect(inProgress.tagName).toBe('A');
  expect(inProgress.getAttribute('href')).toBe('#in_progress');
  // Empty bucket: a plain span, not a dead link to a section that won't render.
  expect(mergeable.tagName).toBe('SPAN');
  expect(mergeable.hasAttribute('href')).toBe(false);
});

test('ago() reads today as "today" and older dates in whole days', () => {
  const now = Date.now();
  expect(ago(null)).toBe('');
  expect(ago(new Date(now).toISOString())).toBe('today');
  expect(ago(new Date(now - 3 * 86400000).toISOString())).toBe('3d ago');
});
