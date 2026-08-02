import type { DashboardData } from './types.js';
import { ago } from './board.js';

export function Extras({ data }: { data: DashboardData }) {
  return (
    <>
      {data.todo.length > 0 && (
        <section id="todo" class="pr-section">
          <div class="pr-section-header">
            <span class="pr-section-dot muted" />
            <span class="pr-section-title">TODO</span>
            <span class="pr-section-count">{data.todo.length}</span>
          </div>
          {data.todo.map(t => (
            <div key={t.key} class="pr-row">
              <span class="pr-row-id">{t.key}</span>
              <a class="pr-row-title" href={t.jiraUrl} target="_blank" rel="noopener noreferrer">{t.summary}</a>
              <span class="pr-row-age">{ago(t.createdAt)}</span>
            </div>
          ))}
        </section>
      )}
      {data.unlinkedPrs.length > 0 && (
        <section class="pr-section">
          <div class="pr-section-header">
            <span class="pr-section-dot muted" />
            <span class="pr-section-title">Unlinked PRs</span>
            <span class="pr-section-count">{data.unlinkedPrs.length}</span>
          </div>
          {data.unlinkedPrs.map(p => (
            <div key={p.url} class="pr-row">
              <a class="pr-row-id" href={p.url} target="_blank" rel="noopener noreferrer">{p.repo}#{p.number}</a>
              <span class="pr-row-title">{p.title}</span>
            </div>
          ))}
        </section>
      )}
      {data.recentActivity.length > 0 && (
        <div class="recent-activity">
          <h3 class="recent-activity-title">Recent Activity (Last 7 Days)</h3>
          <div class="recent-activity-section">
            <h4 class="recent-activity-section-title recent-activity-section-title--merged">
              Merged ({data.recentActivity.length})
            </h4>
            <div class="recent-activity-items">
              {data.recentActivity.map(e => (
                <div key={e.url} class="recent-activity-item">
                  <span class="recent-activity-badge recent-activity-badge--merged">Merged</span>
                  <span class="recent-activity-item-title">{e.label}</span>
                  <a class="recent-activity-link" href={e.url} target="_blank" rel="noopener noreferrer">
                    {e.url.replace(/^https?:\/\/(www\.)?github\.com\//, '')}
                  </a>
                  <span class="recent-activity-date">{new Date(e.date).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
