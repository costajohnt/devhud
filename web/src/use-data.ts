import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardData } from './types.js';

export function useData() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState(false);
  const onRefreshed = useRef<(d: DashboardData) => void>(() => {});
  // Guards two manual refreshes from overlapping (rapid double-click).
  const refreshInFlight = useRef(false);
  // Monotonic request counter: get()/refresh() each grab the next value
  // before awaiting their fetch, then compare against the current value
  // right before applying the result. refreshInFlight only stops two
  // refreshes from overlapping each other — it says nothing about a plain
  // get() racing a refresh() (or a second get()). Without this, a slow
  // get() that started before a refresh() but resolves after it completes
  // would overwrite the fresh refreshed snapshot with stale data, and the
  // UI would silently revert until the next poll. If a newer request has
  // been issued by the time this one resolves, its result is discarded.
  const requestSeq = useRef(0);

  const get = async () => {
    const seq = ++requestSeq.current;
    const d = await (await fetch('/api/data')).json();
    if (seq !== requestSeq.current) return; // superseded by a newer request
    setData(d);
    setLoading(false);
  };

  const refresh = async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    const seq = ++requestSeq.current;
    try {
      const res = await fetch('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' } });
      if (!res.ok) throw new Error(`refresh ${res.status}`);
      const d: DashboardData = await res.json();
      if (seq === requestSeq.current) {
        setData(d);
        setConnError(null);
        // onRefreshed (confetti) is NOT fired here: the server broadcasts
        // this same refresh over /api/events, and the SSE handler fires it
        // exactly once per new updatedAt. Firing here too would double it.
      }
    } catch (e) {
      if (seq === requestSeq.current) setConnError((e as Error).message);
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
      setLoading(false);
    }
  };

  const act = async (body: object) => {
    setActionInFlight(true);
    try {
      const res = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        let message = `action ${res.status}`;
        try {
          const j = await res.json();
          if (j.error) message = j.error;
        } catch { /* non-JSON error body, keep the status-based message */ }
        throw new Error(message);
      }
      await get();
      setActionError(null);
    } catch (e) {
      setActionError(`Action failed: ${(e as Error).message}`);
    } finally {
      setActionInFlight(false);
    }
  };

  // updatedAt of the last SSE event that fired onRefreshed. The server
  // re-broadcasts the same snapshot on actions and on reconnect (the
  // connect event replays current state), and its newlyMerged field only
  // resets on the next real refresh — so firing onRefreshed (confetti) on
  // every event would replay the celebration. Only a changed updatedAt
  // means a genuinely fresh refresh.
  const lastEventAt = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    // Server pushes the current snapshot on connect and after every
    // refresh/mutation, replacing the old client-side poll timers (which
    // throttled in background tabs). EventSource reconnects on its own
    // after laptop sleep or a server restart.
    const es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      const d = JSON.parse(ev.data) as DashboardData;
      ++requestSeq.current; // supersede any in-flight get()/refresh()
      setData(d);
      setLoading(false);
      setConnError(null);
      if (d.updatedAt !== lastEventAt.current) {
        lastEventAt.current = d.updatedAt;
        onRefreshed.current(d);
      }
    };
    // Fires on every reconnect attempt too; the banner clears on the next
    // successful message.
    es.onerror = () => setConnError('connection lost — retrying');
    return () => es.close();
  }, []);

  const clearActionError = () => setActionError(null);

  return { data, loading, refreshing, connError, actionError, actionInFlight, refresh, act, onRefreshed, clearActionError };
}
