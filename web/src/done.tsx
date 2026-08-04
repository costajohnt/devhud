import { useState } from 'preact/hooks';
import type { DashboardData } from './types.js';

type SortDir = 'asc' | 'desc';

// The Done page: work is complete only when its Jira card is marked Done (not
// merely because a linked PR merged). Rows come from the server's doneCards,
// which already excludes Canceled and gates on the Jira Done category.
export function DonePage({ data }: { data: DashboardData }) {
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const rows = [...data.doneCards].sort((a, b) =>
    sortDir === 'desc' ? b.doneAt.localeCompare(a.doneAt) : a.doneAt.localeCompare(b.doneAt));
  const arrow = sortDir === 'asc' ? '▲' : '▼';

  return (
    <div class="merged-view merged-view--full-width">
      <div class="merged-view-header">
        <a href="/" class="merged-view-back">← Back</a>
        <div>
          <h2 class="merged-view-title">Done</h2>
          <span class="merged-view-subtitle">{data.doneTotal} total</span>
        </div>
      </div>
      {rows.length === 0 ? (
        <div class="merged-view-empty">No done cards yet. A card lands here once Jira marks it Done.</div>
      ) : (
        <table class="merged-table">
          <thead>
            <tr>
              <th scope="col">Card</th>
              <th scope="col">Status</th>
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
                  aria-label="Sort by date done"
                >
                  Date done <span class="sort-arrow">{arrow}</span>
                </span>
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
                  <span class="merged-table-status">{m.jiraStatus}</span>
                </td>
                <td>
                  {m.pr ? (
                    <a class="merged-table-pr-link" href={m.pr.url} target="_blank" rel="noopener noreferrer">
                      {m.pr.repo}#{m.pr.number}
                    </a>
                  ) : (
                    <span class="merged-table-status">—</span>
                  )}
                </td>
                <td>
                  <span class="merged-table-date">{new Date(m.doneAt).toLocaleDateString()}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="merged-view-subtitle">Completion follows the Jira card's Done status; a merged PR alone is not done.</p>
    </div>
  );
}
