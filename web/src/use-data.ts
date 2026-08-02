import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardData } from './types.js';

export function useData() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const onRefreshed = useRef<(d: DashboardData) => void>(() => {});

  const get = async () => {
    const d = await (await fetch('/api/data')).json();
    setData(d);
    setLoading(false);
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      if (!res.ok) throw new Error(`refresh ${res.status}`);
      const d: DashboardData = await res.json();
      setData(d);
      setConnError(null);
      onRefreshed.current(d);
    } catch (e) {
      setConnError((e as Error).message);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  };

  const act = async (body: object) => {
    const res = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      setConnError(`action ${res.status}`);
      return;
    }
    await get();
  };

  useEffect(() => {
    get().catch(() => setLoading(false));
    const t0 = setTimeout(refresh, 3000); // silent refresh shortly after load
    const t = setInterval(refresh, 10 * 60 * 1000); // every 10 min while tab open
    return () => { clearTimeout(t0); clearInterval(t); };
  }, []);

  return { data, loading, refreshing, connError, refresh, act, onRefreshed };
}
