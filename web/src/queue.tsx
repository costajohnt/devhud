import type { DashboardData, QueueEntry } from './types.js';
import { ago } from './board.js';

const PRIORITY: Record<QueueEntry['priority'], { text: string; cls: string }> = {
  1: { text: 'P1', cls: 'pill pill--red' },
  2: { text: 'P2', cls: 'pill pill--amber' },
  3: { text: 'P3', cls: 'pill pill--blue' },
};

function QueueText({ e }: { e: QueueEntry }) {
  return (
    <span class="queue-text">
      <span class="pr-row-title">{e.title}</span>
      {e.detail && <span class="queue-detail">{e.detail}</span>}
    </span>
  );
}

// The ranked TODO queue: what needs the developer right now, across every
// in-flight card. Server-built (server/queue.ts); this only renders it.
// "Done" acks just that entry, so the card's other entries stay put.
export function QueuePanel({ data, onSelect, act, actionInFlight }: {
  data: DashboardData;
  onSelect: (key: string) => void;
  act: (body: object) => Promise<unknown>;
  actionInFlight: boolean;
}) {
  const queue = data.queue;
  return (
    <section id="queue" class="pr-section queue" aria-labelledby="queue-title">
      <div class="pr-section-header">
        <span class={`pr-section-dot ${queue.length ? 'red' : 'muted'}`} />
        <h2 id="queue-title" class="pr-section-title">TODO</h2>
        <span class="pr-section-count">{queue.length}</span>
      </div>
      {queue.length === 0 ? (
        <p class="queue-empty">Nothing needs you right now.</p>
      ) : (
        <ol class="queue-list">
          {queue.map(e => (
            <li key={e.id} class="pr-row queue-row">
              <span class={PRIORITY[e.priority].cls}>{PRIORITY[e.priority].text}</span>
              {e.kind === 'card' ? (
                <button type="button" class="pr-row-main queue-main" onClick={() => onSelect(e.key)} title={e.summary}>
                  <span class="pr-row-id">{e.key}</span>
                  <QueueText e={e} />
                </button>
              ) : (
                // No card to open a detail panel for: the row goes to the PR.
                <a class="pr-row-main queue-main" href={e.url} target="_blank" rel="noopener noreferrer" title={e.summary}>
                  <QueueText e={e} />
                </a>
              )}
              <span class="pr-row-age">{ago(e.at)}</span>
              <a class="queue-link" href={e.url} target="_blank" rel="noopener noreferrer" aria-label={`Open: ${e.title}`}>Open</a>
              <button
                type="button"
                class="queue-done"
                disabled={actionInFlight}
                onClick={() => { void act({ type: 'ack', key: e.key, reason: e.reason }); }}
                aria-label={`Done: ${e.title}`}
              >
                Done
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
