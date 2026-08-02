import { useState } from 'preact/hooks';
import type { DashboardData } from './types.js';

type SortDir = 'asc' | 'desc';

export function MergedPage({ data }: { data: DashboardData }) {
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const rows = [...data.mergedCards].sort((a, b) =>
    sortDir === 'desc' ? b.mergedAt.localeCompare(a.mergedAt) : a.mergedAt.localeCompare(b.mergedAt));
  const arrow = sortDir === 'asc' ? '▲' : '▼';

  return (
    <div class="merged-view merged-view--full-width">
      <div class="merged-view-header">
        <a href="/" class="merged-view-back">← Back</a>
        <div>
          <h2 class="merged-view-title">Merged</h2>
          <span class="merged-view-subtitle">{data.mergedTotal} total</span>
        </div>
      </div>
      {rows.length === 0 ? (
        <div class="merged-view-empty">No merged cards found. Run a dashboard refresh to populate.</div>
      ) : (
        <table class="merged-table">
          <thead>
            <tr>
              <th scope="col">Card</th>
              <th scope="col">PR</th>
              <th
                class="sortable-th"
                scope="col"
                onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
                  }
                }}
                tabIndex={0}
                role="button"
                aria-sort={sortDir === 'asc' ? 'ascending' : 'descending'}
              >
                Date merged <span class="sort-arrow">{arrow}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(m => (
              <tr key={m.key}>
                <td>
                  <a class="merged-table-pr-link" href={m.jiraUrl} target="_blank" rel="noopener noreferrer">{m.key}</a>
                  <div class="merged-table-pr-title">{m.summary}</div>
                </td>
                <td>
                  <a class="merged-table-pr-link" href={m.pr.url} target="_blank" rel="noopener noreferrer">
                    {m.pr.repo}#{m.pr.number}
                  </a>
                </td>
                <td>
                  <span class="merged-table-date">{new Date(m.mergedAt).toLocaleDateString()}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="merged-view-subtitle">Total counts every celebrated merge; rows show cards still in Jira's recent window.</p>
    </div>
  );
}
