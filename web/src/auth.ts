// The browser's devhud session (server/index.ts): a random value the server
// hands out for a one-time login code, kept in localStorage (scoped to this
// origin, so to this port; a cookie would be sent to every localhost port)
// and sent as a header. `devhud open` opens the page with ?login=<code>.
import { readStorage, writeStorage } from './storage.js';

const KEY = 'devhud-session';

export const authHeaders = (): Record<string, string> => {
  const s = readStorage(KEY);
  return s ? { 'x-devhud-session': s } : {};
};

// EventSource can't send headers, so the stream takes the session as a query
// parameter (the server's request log omits query strings).
export const eventsUrl = (): string => {
  const s = readStorage(KEY);
  return s ? `/api/events?session=${encodeURIComponent(s)}` : '/api/events';
};

// The ?login=<code> this page was opened with, removed from the address bar
// either way. Null when there is none.
export function takeLoginCode(): string | null {
  const params = new URLSearchParams(location.search);
  const code = params.get('login');
  if (code === null) return null;
  params.delete('login');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  return code;
}

// Trades a login code for a session. False when the server refused it
// (expired, already used): the page then asks for `devhud open` again.
export async function claimSession(code: string): Promise<boolean> {
  try {
    const r = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    if (!r.ok) return false;
    writeStorage(KEY, ((await r.json()) as { session: string }).session);
    return true;
  } catch {
    return false;
  }
}
