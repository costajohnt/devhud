import { useEffect, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';
import type { MergedLogEntry } from './chart-panel.js';

/**
 * Lazy loader for the Chart.js-backed charts panel.
 *
 * Chart.js is tens of KB gzip; shipping it in the initial chunk forces every
 * user to download the charting library before first paint even though the
 * dashboard renders perfectly well without it. This wrapper defers the
 * import to mount time so Vite emits a separate chunk that only loads when
 * this component is actually rendered.
 *
 * While the chunk fetches, we render a minimal skeleton in the same slot —
 * the user sees "charts loading" rather than a layout shift.
 */

interface ChartPanelProps {
  mergedLog: MergedLogEntry[];
  theme: string;
}

// Module-scope cache so the dynamic import runs once per page load, not on
// every mount. Subsequent renders reuse the resolved module.
let cached: ComponentType<ChartPanelProps> | null = null;
let inflight: Promise<ComponentType<ChartPanelProps>> | null = null;

function loadChartPanel(): Promise<ComponentType<ChartPanelProps>> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = import('./chart-panel.js').then((mod) => {
    cached = mod.ChartPanel as ComponentType<ChartPanelProps>;
    return cached;
  });
  return inflight;
}

function ChartSkeleton() {
  return (
    <div class="chart-panel" aria-busy="true" aria-label="Loading charts">
      <div class="chart-card">
        <h3 class="chart-card-title">Merged per Month</h3>
        <div class="chart-canvas-wrapper" style={{ minHeight: 240 }} />
      </div>
      <div class="chart-card">
        <h3 class="chart-card-title">Merged by Repo</h3>
        <div class="chart-canvas-wrapper" style={{ minHeight: 240 }} />
      </div>
    </div>
  );
}

export function LazyChartPanel(props: ChartPanelProps) {
  // Wrap `cached` in an initializer: useState treats a bare function initial
  // value as a lazy initializer and calls it once as `fn(undefined)`. After
  // the dynamic import resolves, `cached` is the ChartPanel function, so on
  // any subsequent mount the unwrapped form would evaluate `ChartPanel(undefined)`
  // during init and crash on the props destructure.
  const [Component, setComponent] = useState<ComponentType<ChartPanelProps> | null>(() => cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (Component) return;
    let cancelled = false;
    loadChartPanel()
      .then((C) => {
        if (!cancelled) setComponent(() => C);
        return;
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          console.error('[jira-dash] failed to load chart-panel chunk:', err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [Component]);

  if (error) {
    // Non-fatal: the rest of the dashboard stays functional. Surface a
    // minimal in-slot message so users know the charts specifically failed
    // rather than the whole page.
    return (
      <div class="chart-panel" role="status">
        <p style={{ margin: '1rem 0', opacity: 0.8 }}>
          Charts failed to load ({error}). The rest of the dashboard is unaffected.
        </p>
      </div>
    );
  }

  if (!Component) return <ChartSkeleton />;
  return <Component {...props} />;
}
