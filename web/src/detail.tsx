import type { Item, Bucket } from './types.js';
import { BUCKET_LABEL } from './types.js';
import { ago } from './board.js';

const MOVABLE: Bucket[] = ['in_progress', 'waiting_review', 'in_qa'];

function ciDotClass(status: string): string {
  switch (status) {
    case 'passing': return 'green';
    case 'failing': return 'red';
    case 'pending': return 'amber';
    default: return '';
  }
}

function reviewDotClass(state: string): string {
  switch (state) {
    case 'approved': return 'green';
    case 'changes_requested': return 'red';
    case 'review_required': return 'amber';
    default: return '';
  }
}

export function Detail({ item, onClose, act, actionInFlight }:
  { item: Item; onClose: () => void; act: (b: object) => Promise<void>; actionInFlight: boolean }) {
  return (
    <div class="pr-detail">
      <div class="pr-detail-header">
        <h2 class="pr-detail-title">{item.summary}</h2>
        <button class="pr-detail-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      <div class="pr-detail-links">
        <a href={item.jiraUrl} target="_blank" rel="noopener noreferrer">
          {item.key}
        </a>
        {item.pr && (
          <>
            {' · '}
            <a href={item.pr.url} target="_blank" rel="noopener noreferrer">
              {item.pr.repo}#{item.pr.number}
            </a>
          </>
        )}
      </div>

      <div class="pr-detail-fields">
        <div class="pr-detail-field">
          <span class="pr-detail-field-label">Jira Status</span>
          <span class="pr-detail-field-value">{item.jiraStatus}</span>
        </div>

        {item.pr && (
          <div class="pr-detail-field">
            <span class="pr-detail-field-label">CI Status</span>
            <span class="pr-detail-field-value">
              <span class={`dot ${ciDotClass(item.pr.ciStatus)}`} />
              <span>{item.pr.ciStatus}</span>
            </span>
          </div>
        )}

        {item.pr && (
          <div class="pr-detail-field">
            <span class="pr-detail-field-label">Review</span>
            <span class="pr-detail-field-value">
              <span class={`dot ${reviewDotClass(item.pr.reviewState)}`} />
              <span>{item.pr.reviewState.replace('_', ' ')}</span>
            </span>
          </div>
        )}

        {item.newComments.length > 0 && (
          <div class="pr-detail-field">
            <span class="pr-detail-field-label">New Comments</span>
            {item.newComments.map((c) => (
              <div class="pr-detail-comment" key={`${c.source}-${c.createdAt}-${c.author}`}>
                <div class="pr-detail-comment-header">
                  <div class="pr-detail-comment-avatar" />
                  <span class="pr-detail-comment-author">
                    {c.source === 'jira' ? 'Jira' : 'GitHub'} · {c.author}
                  </span>
                  <span class="pr-detail-comment-date">{ago(c.createdAt)}</span>
                </div>
                <p class="pr-detail-comment-body">{c.body}</p>
              </div>
            ))}
          </div>
        )}

        <div class="pr-detail-field">
          <span class="pr-detail-field-label">Days Since Activity</span>
          <span class="pr-detail-field-value">{item.daysSinceActivity ?? '—'}</span>
        </div>

        <div class="pr-detail-field">
          <span class="pr-detail-field-label">Created</span>
          <span class="pr-detail-field-value">{new Date(item.createdAt).toLocaleDateString()}</span>
        </div>

        <div class="pr-detail-field">
          <span class="pr-detail-field-label">Updated</span>
          <span class="pr-detail-field-value">{new Date(item.updatedAt).toLocaleDateString()}</span>
        </div>
      </div>

      <div class="action-bar">
        <button
          class="action-btn action-btn--override"
          disabled={actionInFlight}
          onClick={() => act({ type: 'ack', key: item.key })}
        >
          Acknowledge
        </button>
        <select
          class="filter-select"
          value=""
          disabled={actionInFlight}
          onChange={e => {
            const b = (e.target as HTMLSelectElement).value as Bucket;
            if (b) act({ type: 'move', key: item.key, bucket: b });
          }}
        >
          <option value="" disabled>
            Move to…
          </option>
          {MOVABLE.filter(b => b !== item.bucket).map(b => (
            <option key={b} value={b}>
              {BUCKET_LABEL[b]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
