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

// The single most useful "what do I do next" line, derived from the same
// attention signals that put the card where it is. Shown prominently so the
// current state reads before any activity history.
function nextAction(item: Item): string {
  const a = item.attention;
  const n = item.newComments.length;
  if (a.includes('ci_failing')) return 'CI is failing — fix the build';
  if (n > 0) return `Respond to ${n} new comment${n > 1 ? 's' : ''}`;
  if (a.includes('merged_not_in_test')) return 'PR merged — move the card to QA / In Test';
  switch (item.bucket) {
    case 'waiting_review': return 'Waiting on reviewers';
    case 'in_qa': return 'In QA — awaiting test sign-off';
    case 'needs_attention': return 'Needs triage';
    default: return 'In progress — keep it moving';
  }
}

function CommentRow({ c, reason }: { c: Item['comments'][number]; reason?: string }) {
  return (
    <div class="pr-detail-comment">
      <div class="pr-detail-comment-header">
        <div class="pr-detail-comment-avatar" />
        <span class="pr-detail-comment-author">
          {c.source === 'jira' ? 'Jira' : 'GitHub'} · {c.author}
        </span>
        <span class="pr-detail-comment-date">{ago(c.createdAt)}</span>
      </div>
      {reason && <span class="pr-detail-comment-reason">{reason}</span>}
      <p class="pr-detail-comment-body">{c.body}</p>
    </div>
  );
}

export function Detail({ item, onClose, act, actionInFlight }:
  { item: Item; onClose: () => void; act: (b: object) => Promise<void>; actionInFlight: boolean }) {
  const fixVersions = item.fixVersions ?? [];
  const unread = item.newComments;
  const history = item.comments ?? [];

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

      {/* Status + next action, up top: what's true now and what to do about it,
          before any activity scrolling. */}
      <div class="pr-detail-summary">
        <div class="pr-detail-summary-row">
          <span class="pr-detail-status-chip">{item.jiraStatus}</span>
          {item.pr?.state === 'merged' && <span class="pr-detail-status-chip pr-detail-status-chip--muted">PR merged</span>}
        </div>
        <div class="pr-detail-nextaction">
          <span class="pr-detail-nextaction-label">Next</span>
          <span class="pr-detail-nextaction-text">{nextAction(item)}</span>
        </div>
      </div>

      <div class="pr-detail-fields">
        <div class="pr-detail-field">
          <span class="pr-detail-field-label">Fix Version</span>
          <span class="pr-detail-field-value">
            {fixVersions.length > 0
              ? fixVersions.join(', ')
              : <span class="pr-detail-missing">⚠ Not set</span>}
          </span>
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

        {/* Actionable unread queue: only comments that need a response (John and
            Rovo already filtered out server-side). Not duplicated below. */}
        {unread.length > 0 && (
          <div class="pr-detail-field">
            <span class="pr-detail-field-label">New Comments <span class="pr-detail-badge">{unread.length}</span></span>
            {unread.map(c => (
              <CommentRow key={`new-${c.source}-${c.createdAt}-${c.author}`} c={c} reason={`Unread · ${c.author}`} />
            ))}
          </div>
        )}

        {/* Full history behind one disclosure so the same comments aren't shown
            twice in the initial view; complete Jira/PR history stays reachable. */}
        {history.length > 0 && (
          <details class="pr-detail-history">
            <summary class="pr-detail-history-summary">All activity ({history.length})</summary>
            <div class="pr-detail-history-body">
              {history.map(c => (
                <CommentRow key={`all-${c.source}-${c.createdAt}-${c.author}`} c={c} />
              ))}
            </div>
          </details>
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
