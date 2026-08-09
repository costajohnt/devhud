// Desktop notifications for cards entering Needs Attention.
//
// The decision half is pure (same split as live-event.ts) so the rules below
// are testable in node without a Notification API or a DOM.

export interface AttentionCard {
  key: string;
  summary: string;
}

export interface NotifyOpts {
  enabled: boolean;
  permission: string;
  // Only notify for a board the user isn't looking at. A visible tab already
  // shows the card, the count in the header, and the title badge — a popup on
  // top of that is noise, not signal.
  hidden: boolean;
}

export interface NotifyDecision {
  fire: AttentionCard[];
  next: string[];
}

/**
 * Which cards warrant a notification, given the keys that were in
 * needs_attention last time.
 *
 * Keyed on card identity, not the bucket's length: a count comparison misses
 * the case where one card is acked and another arrives in the same refresh
 * (count unchanged, but there IS something new), and double-fires when a card
 * leaves and comes back.
 *
 * `next` is returned unconditionally — even when nothing fires, and even when
 * notifications are off. The baseline has to advance regardless, or enabling
 * the toggle later would dump every already-seen card into one notification,
 * and a stretch of visible-tab time would fire retroactively on the next
 * blur.
 */
export function decideNotification(
  prev: string[] | undefined,
  cards: AttentionCard[],
  { enabled, permission, hidden }: NotifyOpts,
): NotifyDecision {
  const next = cards.map(c => c.key);
  // First snapshot of a page load is a replay of existing state, not news —
  // same rule as the confetti gate in live-event.ts.
  if (prev === undefined) return { fire: [], next };
  if (!enabled || permission !== 'granted' || !hidden) return { fire: [], next };
  const before = new Set(prev);
  return { fire: cards.filter(c => !before.has(c.key)), next };
}

/** Notification copy: name the card when there's one, count them when there are several. */
export function notificationText(fire: AttentionCard[]): { title: string; body: string } {
  if (fire.length === 1) {
    return { title: `${fire[0]!.key} needs attention`, body: fire[0]!.summary };
  }
  return { title: `${fire.length} cards need attention`, body: fire.map(c => c.key).join(', ') };
}

// --- imperative half: everything below touches the Notification API ---

export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

export function notificationPermission(): string {
  return notificationsSupported() ? Notification.permission : 'denied';
}

export async function requestNotificationPermission(): Promise<string> {
  if (!notificationsSupported()) return 'denied';
  // Already decided: asking again is a no-op in every browser, and Safari
  // rejects a second call outright.
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function showAttentionNotification(fire: AttentionCard[]): void {
  if (!fire.length || !notificationsSupported()) return;
  const { title, body } = notificationText(fire);
  try {
    // One shared tag so a burst replaces itself instead of stacking N popups;
    // requireInteraction is deliberately off, since a triage nudge that has to
    // be dismissed is worse than one that fades.
    const n = new Notification(title, { body, tag: 'simon-dash-attention' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Some browsers throw when constructing notifications outside a service
    // worker (notably mobile Chrome). The board still shows the card.
  }
}
