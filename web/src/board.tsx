import { useState } from 'preact/hooks';
import type { DashboardData, Item, Bucket } from './types.js';
import { BUCKET_ORDER, BUCKET_LABEL } from './types.js';

export const ago = (iso: string | null) => {
  if (!iso) return '';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return d <= 0 ? 'today' : `${d}d ago`;
};

function pill(item: Item): { text: string; cls: string } | null {
  if (item.pr?.state === 'merged') return { text: 'Merged', cls: 'pill pill--muted' };
  if (item.attention.includes('ci_failing')) return { text: 'CI Failing', cls: 'pill pill--red' };
  const n = item.newComments.length;
  if (n) return { text: `${n} new comment${n > 1 ? 's' : ''}`, cls: 'pill pill--red' };
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

// .pr-section-dot only ships red/blue/amber/muted variants.
const DOT_COLOR: Record<Bucket, string> = {
  needs_attention: 'red',
  in_progress: 'muted',
  waiting_review: 'blue',
  in_qa: 'amber',
};

export function Board({ data, selectedKey, onSelect }:
  { data: DashboardData; selectedKey: string | null; onSelect: (k: string | null) => void }) {
  const [q, setQ] = useState('');
  const match = (i: Item) =>
    !q || i.key.toLowerCase().includes(q.toLowerCase()) || i.summary.toLowerCase().includes(q.toLowerCase());
  const total = BUCKET_ORDER.reduce((n, b) => n + data.buckets[b].length, 0);
  const shown = BUCKET_ORDER.reduce((n, b) => n + data.buckets[b].filter(match).length, 0);

  return (
    <div>
      <div class="stats-bar animate-in delay-1">
        {BUCKET_ORDER.map(b => (
          <a class={`stat-card ${STAT_COLOR[b]}`} href={`#${b}`}>
            <span class="stat-value">{data.buckets[b].length}</span>
            <span class="stat-label">{BUCKET_LABEL[b]}</span>
          </a>
        ))}
        <a class="stat-card muted" href="#todo">
          <span class="stat-value">{data.todo.length}</span>
          <span class="stat-label">TODO</span>
        </a>
        <a class="stat-card purple" href="/merged">
          <span class="stat-value">{data.mergedTotal}</span>
          <span class="stat-label">Merged</span>
        </a>
      </div>
      <div class="filter-bar animate-in delay-2">
        <input
          class="filter-input"
          placeholder="Search cards…"
          value={q}
          onInput={e => setQ((e.target as HTMLInputElement).value)}
        />
        <span class="filter-count">Showing {shown} of {total} cards</span>
      </div>
      <div class="animate-in delay-3">
        {BUCKET_ORDER.map(b => {
          const items = data.buckets[b].filter(match);
          if (!items.length) return null;
          return (
            <section id={b} class="pr-section">
              <div class="pr-section-header">
                <span class={`pr-section-dot ${DOT_COLOR[b]}`} />
                <span class="pr-section-title">{BUCKET_LABEL[b]}</span>
                <span class="pr-section-count">{items.length}</span>
              </div>
              {items.map(i => {
                const p = pill(i);
                return (
                  <div
                    class={`pr-row ${selectedKey === i.key ? 'pr-row--selected' : ''}`}
                    onClick={() => onSelect(i.key)}
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
    </div>
  );
}
