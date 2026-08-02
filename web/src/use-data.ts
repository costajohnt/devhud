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
  // Ref (not state) so the 3s/10-min scheduled callbacks — closed over at
  // effect-setup time — always see the current in-flight status rather than
  // a stale snapshot from whenever the effect ran.
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
        onRefreshed.current(d);
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

  useEffect(() => {
    get().catch(() => setLoading(false));
    const t0 = setTimeout(() => { if (!refreshInFlight.current) refresh(); }, 3000); // silent refresh shortly after load
    const t = setInterval(() => { if (!refreshInFlight.current) refresh(); }, 10 * 60 * 1000); // every 10 min while tab open
    return () => { clearTimeout(t0); clearInterval(t); };
  }, []);

  const clearActionError = () => setActionError(null);

  return { data, loading, refreshing, connError, actionError, actionInFlight, refresh, act, onRefreshed, clearActionError };
}
