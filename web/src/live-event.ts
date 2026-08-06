import type { DashboardData } from './types.js';

// Decision logic for each incoming SSE snapshot, pure so it's testable in
// node without EventSource or a DOM. `prev` is the updatedAt of the last
// event that fired onRefreshed; `undefined` means "no event seen yet on
// this page load".
//
// fire rules:
// - never on the first event: the connect message is a REPLAY of current
//   state (whose persisted newlyDone can be non-empty), not a fresh
//   refresh — firing there replayed confetti on every reload/reconnect.
// - otherwise only when updatedAt changed: the server re-broadcasts the
//   same snapshot after actions, and a reconnect replays it too; neither
//   is a new refresh.
export function applyEvent(prev: string | null | undefined, d: DashboardData): { fire: boolean; next: string | null } {
  const fire = prev !== undefined && d.updatedAt !== prev;
  return { fire, next: d.updatedAt };
}
