import { useState } from 'preact/hooks';
import type { DashboardData } from './types.js';

type SortDir = 'asc' | 'desc';

export function ClosedPage({ data }: { data: DashboardData }) {
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const rows = [...data.closedPrs].sort((a, b) =>
    sortDir === 'desc' ? b.closedAt.localeCompare(a.closedAt) : a.closedAt.localeCompare(b.closedAt));
  const arrow = sortDir === 'asc' ? '▲' : '▼';

  return (
    <div class="merged-view merged-view--full-width">
      <div class="merged-view-header">
        <a href="/" class="merged-view-back">← Back</a>
        <div>
          <h2 class="merged-view-title">Closed</h2>
          <span class="merged-view-subtitle">{data.closedPrs.length} total</span>
        </div>
      </div>
      {rows.length === 0 ? (
        <div class="merged-view-empty">No closed-unmerged PRs found. Run a dashboard refresh to populate.</div>
      ) : (
        <table class="merged-table">
          <thead>
            <tr>
              <th scope="col">PR</th>
              <th
                scope="col"
                aria-sort={sortDir === 'asc' ? 'ascending' : 'descending'}
              >
                <span
                  class="sortable-th"
                  onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label="Sort by date closed"
                >
                  Date closed <span class="sort-arrow">{arrow}</span>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(p => (
              <tr key={p.url}>
                <td>
                  <a class="merged-table-pr-link" href={p.url} target="_blank" rel="noopener noreferrer">
                    {p.repo}#{p.number}
                  </a>
                  <div class="merged-table-pr-title">{p.title}</div>
                </td>
                <td>
                  <span class="merged-table-date">{new Date(p.closedAt).toLocaleDateString()}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
