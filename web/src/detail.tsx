import type { Item, Bucket } from './types.js';
import { BUCKET_LABEL } from './types.js';
import { ago } from './board.js';

const MOVABLE: Bucket[] = ['in_progress', 'self_review', 'waiting_review', 'mergeable', 'qa_ready', 'in_qa'];

// Jira can omit created/updated (server sends null); an unguarded
// `new Date(null)` rendered a literal "Invalid Date" here.
function fmtDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

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
  // PR fact, not attention flag — an acked card with red CI still needs the
  // build fixed, even though it no longer sits in Needs Attention.
  if (item.pr?.state === 'open' && item.pr.ciStatus === 'failing') return 'CI is failing — fix the build';
  if (n > 0) return `Respond to ${n} new comment${n > 1 ? 's' : ''}`;
  if (a.includes('merged_not_in_test')) return 'PR merged — move the card to QA / In Test';
  switch (item.bucket) {
    case 'self_review': return 'Self review needed — inspect PR before requesting peer review';
    case 'waiting_review': return 'Waiting on reviewers';
    case 'mergeable': return 'Approved — merge the PR and move the card to In Test';
    case 'qa_ready': return 'QA Ready — awaiting a tester to pick it up';
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

// One "New Comments"-style section for a single source's unread queue. Only
// rendered when non-empty, so a card with e.g. only Jira activity shows only
// the Jira section.
function UnreadSection({ label, comments }: { label: string; comments: Item['newComments'] }) {
  if (comments.length === 0) return null;
  return (
    <div class="pr-detail-field">
      <span class="pr-detail-field-label">{label} <span class="pr-detail-badge">{comments.length}</span></span>
      {comments.map((c, i) => (
        // Index in the key: a review body and its inline comments from the
        // same author routinely share a source/timestamp/author triple, and
        // duplicate keys let preact reuse the wrong node.
        <CommentRow key={`new-${i}-${c.source}-${c.createdAt}-${c.author}`} c={c} reason={`Unread · ${c.author}`} />
      ))}
    </div>
  );
}

// Full per-source history behind its own disclosure, collapsed by default so
// complete Jira/GitHub activity stays reachable without rendering up front.
function HistorySection({ label, comments }: { label: string; comments: Item['comments'] }) {
  if (comments.length === 0) return null;
  return (
    <details class="pr-detail-history">
      <summary class="pr-detail-history-summary">{label} ({comments.length})</summary>
      <div class="pr-detail-history-body">
        {comments.map((c, i) => (
          <CommentRow key={`all-${i}-${c.source}-${c.createdAt}-${c.author}`} c={c} />
        ))}
      </div>
    </details>
  );
}

export function Detail({ item, onClose, act, actionInFlight }:
  { item: Item; onClose: () => void; act: (b: object) => Promise<void>; actionInFlight: boolean }) {
  const fixVersions = item.fixVersions ?? [];
  // newComments is the attention window: the comments that put (or would put)
  // the card in Needs Attention plus anything newer, already filtered by the
  // seen watermarks and the ignore-author policy server-side. Acknowledge
  // bumps the watermarks, so acked activity drops out of these on the next
  // fetch and a fresh actionable comment starts a new window.
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

        {/* Actionable unread queue, split by source (issue #13): only comments
            that need a response (ignore-authors already filtered server-side).
            Not duplicated in the history disclosures below. */}
        <UnreadSection label="New Jira Comments" comments={unread.filter(c => c.source === 'jira')} />
        <UnreadSection label="New GitHub Comments" comments={unread.filter(c => c.source === 'github')} />

        {/* Complete per-source history behind explicit disclosures so the same
            comments aren't shown twice in the initial view. */}
        <HistorySection label="All Jira activity" comments={history.filter(c => c.source === 'jira')} />
        <HistorySection label="All GitHub activity" comments={history.filter(c => c.source === 'github')} />

        {item.pinned && (
          <div class="pr-detail-field">
            <span class="pr-detail-field-label">Pinned</span>
            <span class="pr-detail-field-value">
              {item.pinnedAt ? `${BUCKET_LABEL[item.bucket]} · ${ago(item.pinnedAt)}` : BUCKET_LABEL[item.bucket]}
            </span>
          </div>
        )}

        <div class="pr-detail-field">
          <span class="pr-detail-field-label">Days Since Activity</span>
          <span class="pr-detail-field-value">{item.daysSinceActivity ?? '—'}</span>
        </div>

        <div class="pr-detail-field">
          <span class="pr-detail-field-label">Created</span>
          <span class="pr-detail-field-value">{fmtDate(item.createdAt)}</span>
        </div>

        <div class="pr-detail-field">
          <span class="pr-detail-field-label">Updated</span>
          <span class="pr-detail-field-value">{fmtDate(item.updatedAt)}</span>
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
        {/* Only offered when there's a pin to release. `pinned` comes from the
            snapshot rather than local state so it stays right across tabs —
            another tab's unpin arrives over SSE and this button disappears. */}
        {item.pinned && (
          <button
            class="action-btn action-btn--override"
            disabled={actionInFlight}
            title="Return this card to classifier control"
            onClick={() => act({ type: 'unpin', key: item.key })}
          >
            Unpin
          </button>
        )}
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
