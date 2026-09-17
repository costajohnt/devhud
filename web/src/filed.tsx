import type { DashboardData } from './types.js';

// The Filed page: every card this user reported, any project, newest first.
// Rows arrive from the server already ordered by created DESC; the sort here
// only guards a snapshot assembled elsewhere (tests, hand-edited state).
export function FiledPage({ data }: { data: DashboardData }) {
  const rows = [...data.filed].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  return (
    <div class="merged-view merged-view--full-width">
      <div class="merged-view-header">
        <a href="/" class="merged-view-back">← Back</a>
        <div>
          <h2 class="merged-view-title">Filed by me</h2>
          <span class="merged-view-subtitle">{rows.length} total</span>
        </div>
      </div>
      {rows.length === 0 ? (
        <div class="merged-view-empty">No cards filed yet. A card lands here once you are its Jira reporter.</div>
      ) : (
        <table class="merged-table">
          <thead>
            <tr>
              <th scope="col">Card</th>
              <th scope="col">Status</th>
              <th scope="col" aria-sort="descending">Created</th>
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
                  <span class="merged-table-date">{m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '—'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="merged-view-subtitle">Cards where you are the Jira reporter, across every project.</p>
    </div>
  );
}
