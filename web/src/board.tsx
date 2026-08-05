import { useRef, useState } from 'preact/hooks';
import type { DashboardData, Item, Bucket } from './types.js';
import { BUCKET_ORDER, BUCKET_LABEL } from './types.js';
import { AnimatedValue } from './count-up.js';

export const ago = (iso: string | null) => {
  if (!iso) return '';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return d <= 0 ? 'today' : `${d}d ago`;
};

// Attention reasons (CI failing, unseen comments) always outrank "Merged" —
// a merged PR that still needs a look shouldn't hide behind a muted pill.
function pill(item: Item): { text: string; cls: string } | null {
  // Driven by the PR fact, not the attention flag: acknowledging mutes the
  // needs_attention nag, but red CI is still red and must stay visible.
  if (item.pr?.state === 'open' && item.pr.ciStatus === 'failing') return { text: 'CI Failing', cls: 'pill pill--red' };
  const n = item.newComments.length;
  if (n) return { text: `${n} new comment${n > 1 ? 's' : ''}`, cls: 'pill pill--red' };
  if (item.pr?.state === 'merged') return { text: 'Merged', cls: 'pill pill--muted' };
  if (item.pr?.reviewState === 'changes_requested') return { text: 'Changes Requested', cls: 'pill pill--amber' };
  if (item.bucket === 'waiting_review') return { text: 'Awaiting Review', cls: 'pill pill--blue' };
  return null;
}

// Stat card color classes are the ones .stat-card.<color> defines in styles.css
// (green/red/purple/blue/amber/teal/muted); there's no direct bucket->color
// mapping in the source dashboard, so buckets are assigned distinct colors here.
const STAT_COLOR: Record<Bucket, string> = {
  needs_attention: 'red',
  in_progress: 'blue',
  waiting_review: 'amber',
  in_qa: 'teal',
};

// Kept in sync with STAT_COLOR above so a bucket's section dot and its
// stat-card share the same hue (.pr-section-dot.<color> in styles.css).
const DOT_COLOR: Record<Bucket, string> = STAT_COLOR;

// needs_attention is excluded: the server rejects moves into that bucket.
const DROPPABLE: Bucket[] = ['in_progress', 'waiting_review', 'in_qa'];

// Owns the search text, drag-and-drop state, and derived filter counts that
// the stats bar, filter bar, and section list all need to share. Lifted out
// of a single Board component (and up into App, not into the Route's inline
// component) so search/drag state survives re-renders instead of resetting
// whenever a new anonymous route-component identity gets mounted.
export function useBoardFilter(data: DashboardData | null, act: (b: object) => Promise<void>, actionInFlight = false) {
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<Bucket | 'all'>('all');
  const [repoFilter, setRepoFilter] = useState('all');
  const [dragOverBucket, setDragOverBucket] = useState<Bucket | null>(null);
  // dragenter/dragleave fire on every child element as the pointer crosses them;
  // a per-bucket counter absorbs that churn so the highlight only clears once
  // the drag has truly left the section (counter back to 0).
  const dragCounters = useRef<Partial<Record<Bucket, number>>>({});

  const onRowDragStart = (e: DragEvent, key: string) => {
    e.dataTransfer?.setData('text/plain', key);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  };

  const onSectionDragEnter = (b: Bucket) => {
    dragCounters.current[b] = (dragCounters.current[b] ?? 0) + 1;
    setDragOverBucket(b);
  };

  const onSectionDragLeave = (b: Bucket) => {
    const next = (dragCounters.current[b] ?? 0) - 1;
    dragCounters.current[b] = next;
    if (next <= 0) {
      dragCounters.current[b] = 0;
      setDragOverBucket(cur => (cur === b ? null : cur));
    }
  };

  const onSectionDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  };

  const onSectionDrop = (e: DragEvent, b: Bucket) => {
    e.preventDefault();
    dragCounters.current[b] = 0;
    setDragOverBucket(cur => (cur === b ? null : cur));
    // An action is already in flight (ack/move) — ignore this drop rather
    // than firing a second concurrent action against the same card.
    if (actionInFlight) return;
    const key = e.dataTransfer?.getData('text/plain');
    if (!key || !data) return;
    const current = BUCKET_ORDER.find(bucket => data.buckets[bucket].some(i => i.key === key));
    if (current === b) return;
    void act({ type: 'move', key, bucket: b });
  };

  // Distinct repos across all buckets, sorted; the dropdown itself is hidden
  // by the caller when there are fewer than 2 (nothing to filter between).
  const repos = data
    ? Array.from(new Set(BUCKET_ORDER.flatMap(b => data.buckets[b].map(i => i.pr?.repo).filter((r): r is string => !!r)))).sort()
    : [];

  const match = (i: Item) => {
    if (statusFilter !== 'all' && i.bucket !== statusFilter) return false;
    // Cards without a linked PR have no repo to filter on, so they stay
    // visible under every repo selection except "All Repos" would be wrong —
    // per spec they're only shown under "All Repos".
    if (repoFilter !== 'all' && i.pr?.repo !== repoFilter) return false;
    return !q || i.key.toLowerCase().includes(q.toLowerCase()) || i.summary.toLowerCase().includes(q.toLowerCase());
  };
  const total = data ? BUCKET_ORDER.reduce((n, b) => n + data.buckets[b].length, 0) : 0;
  const shown = data ? BUCKET_ORDER.reduce((n, b) => n + data.buckets[b].filter(match).length, 0) : 0;

  return {
    q, setQ, statusFilter, setStatusFilter, repoFilter, setRepoFilter, repos, dragOverBucket, match, total, shown,
    onRowDragStart, onSectionDragEnter, onSectionDragLeave, onSectionDragOver, onSectionDrop,
  };
}

export type BoardFilter = ReturnType<typeof useBoardFilter>;

export function BoardStats({ data }: { data: DashboardData }) {
  // A stat card only links to a #hash section when that section actually
  // renders (non-empty) — otherwise it'd be a dead link to a missing anchor,
  // so it renders as a plain span instead.
  return (
    <div class="stats-bar animate-in delay-1">
      {BUCKET_ORDER.map(b => {
        const count = data.buckets[b].length;
        const Tag = count > 0 ? 'a' : 'span';
        return (
          <Tag key={b} class={`stat-card ${STAT_COLOR[b]}`} {...(count > 0 ? { href: `#${b}` } : {})}>
            <span class="stat-value"><AnimatedValue value={count} /></span>
            <span class="stat-label">{BUCKET_LABEL[b]}</span>
          </Tag>
        );
      })}
      {(() => {
        const Tag = data.todo.length > 0 ? 'a' : 'span';
        return (
          <Tag class="stat-card muted" {...(data.todo.length > 0 ? { href: '#todo' } : {})}>
            <span class="stat-value"><AnimatedValue value={data.todo.length} /></span>
            <span class="stat-label">Todo</span>
          </Tag>
        );
      })()}
      <a class="stat-card purple" href="/done">
        <span class="stat-value"><AnimatedValue value={data.doneTotal} /></span>
        <span class="stat-label">Done</span>
      </a>
    </div>
  );
}

export function BoardFilterBar({ board }: { board: BoardFilter }) {
  return (
    <div class="filter-bar animate-in delay-2">
      <select
        class="filter-select"
        aria-label="Filter by status"
        value={board.statusFilter}
        onChange={e => board.setStatusFilter((e.target as HTMLSelectElement).value as Bucket | 'all')}
      >
        <option value="all">All Buckets</option>
        {BUCKET_ORDER.map(b => (
          <option key={b} value={b}>{BUCKET_LABEL[b]}</option>
        ))}
      </select>
      {board.repos.length > 1 && (
        <select
          class="filter-select"
          aria-label="Filter by repository"
          value={board.repoFilter}
          onChange={e => board.setRepoFilter((e.target as HTMLSelectElement).value)}
        >
          <option value="all">All Repos</option>
          {board.repos.map(r => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      )}
      <input
        class="filter-input"
        placeholder="Search cards…"
        value={board.q}
        onInput={e => board.setQ((e.target as HTMLInputElement).value)}
      />
      <span class="filter-count">Showing {board.shown} of {board.total} cards</span>
    </div>
  );
}

export function BoardList({ data, selectedKey, onSelect, board }:
  { data: DashboardData; selectedKey: string | null; onSelect: (k: string | null) => void; board: BoardFilter }) {
  if (board.shown === 0) {
    return (
      <div class="pr-list">
        <p class="pr-list-empty">No cards to display</p>
      </div>
    );
  }
  return (
    <div class="pr-list">
      {BUCKET_ORDER.map(b => {
        const items = data.buckets[b].filter(board.match);
        if (!items.length) return null;
        const droppable = DROPPABLE.includes(b);
        return (
          <section
            key={b}
            id={b}
            class={`pr-section ${droppable && board.dragOverBucket === b ? 'drop-target-active' : ''}`}
            onDragEnter={droppable ? () => board.onSectionDragEnter(b) : undefined}
            onDragLeave={droppable ? () => board.onSectionDragLeave(b) : undefined}
            onDragOver={droppable ? board.onSectionDragOver : undefined}
            onDrop={droppable ? (e: DragEvent) => board.onSectionDrop(e, b) : undefined}
          >
            <div class="pr-section-header">
              <span class={`pr-section-dot ${DOT_COLOR[b]}`} />
              <span class="pr-section-title">{BUCKET_LABEL[b]}</span>
              <span class="pr-section-count">{items.length}</span>
            </div>
            {items.map(i => {
              const p = pill(i);
              return (
                <div
                  key={i.key}
                  class={`pr-row ${selectedKey === i.key ? 'pr-row--selected' : ''}`}
                  draggable
                  onDragStart={(e: DragEvent) => board.onRowDragStart(e, i.key)}
                  onClick={() => onSelect(i.key)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(i.key);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <span class="pr-row-id">{i.key}</span>
                  <span class="pr-row-title">{i.summary}</span>
                  {i.pr && (
                    <a class="pr-row-id" href={i.pr.url} target="_blank" onClick={e => e.stopPropagation()}>
                      {i.pr.repo.split('/')[1]}#{i.pr.number}
                    </a>
                  )}
                  {p && <span class={p.cls}>{p.text}</span>}
                  <span class="pr-row-age">{ago(i.updatedAt)}</span>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
