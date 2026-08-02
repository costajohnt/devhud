import { useEffect, useRef } from 'preact/hooks';
import {
  Chart,
  LineController,
  BarController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
} from 'chart.js';

// Register only what we need — keeps the lazy chart chunk small.
Chart.register(
  LineController,
  BarController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
);

export interface PrLogEntry { id: string; repo: string; openedAt: string | null; mergedAt: string | null; closedAt: string | null; }

interface ChartPanelProps {
  prLog: PrLogEntry[];
  theme: string;
}

// Chart.js can't read CSS vars directly; map theme to explicit hex values
// mirroring oss-autopilot's dashboard chart-panel.
function getChartColors(theme: string) {
  if (theme === 'light') {
    return {
      green: '#16a34a',
      purple: '#9333ea',
      red: '#dc2626',
      blue: '#2563eb',
      gridColor: 'rgba(15, 23, 42, 0.06)',
      textColor: '#475569',
    };
  }
  return {
    green: '#4ade80',
    purple: '#c084fc',
    red: '#fb7185',
    blue: '#60a5fa',
    gridColor: 'rgba(255, 255, 255, 0.06)',
    textColor: '#94a3b8',
  };
}

/**
 * Ascending 'YYYY-MM' keys for the last `n` months, ending this month, in
 * UTC. monthlyCounts() below buckets events by `at.slice(0, 7)` — the UTC
 * year-month embedded in an ISO timestamp string — so the bucket keys built
 * here have to be computed in UTC too, not local calendar time: a local
 * getFullYear()/getMonth() version would put "this month"'s boundary at
 * local midnight instead of UTC midnight, and at a large positive UTC
 * offset an event landing just after UTC midnight but still "yesterday"
 * locally would fall one bucket earlier than monthlyCounts places it,
 * undercounting the current month (or dropping silently off the window's
 * edge).
 */
export function lastNMonths(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// Renders a 'YYYY-MM' key (already UTC, from lastNMonths above) as a short
// label. Built and formatted entirely in UTC (Date.UTC + timeZone: 'UTC')
// so there's no local-timezone round-trip that could shift the displayed
// month away from the key it's labeling — a `new Date(y, m-1, 1)` local
// constructor would render "Dec '25" for a key that's actually "2026-01"
// for anyone west of UTC.
export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

export function monthlyCounts(dates: (string | null)[], months: string[]): number[] {
  const counts = new Map<string, number>();
  for (const at of dates) {
    if (!at) continue;
    const key = at.slice(0, 7);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return months.map(m => counts.get(m) ?? 0);
}

export function topRepos(prLog: PrLogEntry[], limit = 10): { repo: string; active: number; merged: number; closed: number }[] {
  const byRepo = new Map<string, { active: number; merged: number; closed: number }>();
  for (const e of prLog) {
    const bucket = byRepo.get(e.repo) ?? { active: 0, merged: 0, closed: 0 };
    if (e.mergedAt) bucket.merged += 1;
    else if (e.closedAt) bucket.closed += 1;
    else bucket.active += 1;
    byRepo.set(e.repo, bucket);
  }
  return [...byRepo.entries()]
    .map(([repo, counts]) => ({ repo, ...counts }))
    .sort((a, b) => (b.active + b.merged + b.closed) - (a.active + a.merged + a.closed) || a.repo.localeCompare(b.repo))
    .slice(0, limit);
}

export function ChartPanel({ prLog, theme }: ChartPanelProps) {
  const lineCanvasRef = useRef<HTMLCanvasElement>(null);
  const barCanvasRef = useRef<HTMLCanvasElement>(null);
  const lineChartRef = useRef<Chart | null>(null);
  const barChartRef = useRef<Chart | null>(null);

  // Monthly activity line chart (Opened/Merged/Closed). Created once, then
  // updated in place: fresh array/object identities arrive on every refresh,
  // and destroy-and-recreate would replay the entrance animation on every
  // poll (mirrors oss-autopilot dashboard's chart-panel #1459 fix).
  useEffect(() => {
    const canvas = lineCanvasRef.current;
    if (!canvas) return;

    const colors = getChartColors(theme);
    const scaleOpts = { ticks: { color: colors.textColor }, grid: { color: colors.gridColor } };
    const legendOpts = { labels: { color: colors.textColor, boxWidth: 12 } };
    const months = lastNMonths(6);

    const opened = monthlyCounts(prLog.map(e => e.openedAt), months);
    const merged = monthlyCounts(prLog.map(e => e.mergedAt), months);
    const closed = monthlyCounts(prLog.map(e => e.closedAt), months);

    const data = {
      labels: months.map(monthLabel),
      datasets: [
        { label: 'Opened', data: opened, borderColor: colors.blue, backgroundColor: colors.blue, tension: 0.3, pointRadius: 3 },
        { label: 'Merged', data: merged, borderColor: colors.purple, backgroundColor: colors.purple, tension: 0.3, pointRadius: 3 },
        { label: 'Closed', data: closed, borderColor: colors.red, backgroundColor: colors.red, tension: 0.3, pointRadius: 3 },
      ],
    };
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 1500, easing: 'easeOutQuart' as const },
      plugins: { legend: legendOpts },
      scales: {
        x: scaleOpts,
        y: { beginAtZero: true, ...scaleOpts },
      },
    };

    const existing = lineChartRef.current;
    if (existing) {
      existing.data = data;
      existing.options = options;
      existing.update('none');
      return;
    }
    lineChartRef.current = new Chart(canvas, { type: 'line', data, options });
  }, [prLog, theme]);

  // Top repos stacked horizontal bar (Active/Merged/Closed) — same
  // create-once-then-update-in-place pattern as the line chart above.
  useEffect(() => {
    const canvas = barCanvasRef.current;
    if (!canvas) return;

    const colors = getChartColors(theme);
    const scaleOpts = { ticks: { color: colors.textColor }, grid: { color: colors.gridColor } };
    const legendOpts = { labels: { color: colors.textColor, boxWidth: 12 } };
    const repos = topRepos(prLog);
    const labels = repos.map(r => r.repo);

    const data = {
      labels,
      datasets: [
        { label: 'Active', data: repos.map(r => r.active), backgroundColor: colors.green },
        { label: 'Merged', data: repos.map(r => r.merged), backgroundColor: colors.purple },
        { label: 'Closed', data: repos.map(r => r.closed), backgroundColor: colors.red },
      ],
    };
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 1500, easing: 'easeOutQuart' as const },
      indexAxis: 'y' as const,
      plugins: { legend: legendOpts },
      scales: {
        x: { stacked: true, beginAtZero: true, ...scaleOpts },
        y: { stacked: true, ...scaleOpts },
      },
    };

    const existing = barChartRef.current;
    if (existing) {
      existing.data = data;
      existing.options = options;
      existing.update('none');
      return;
    }
    barChartRef.current = new Chart(canvas, { type: 'bar', data, options });
  }, [prLog, theme]);

  // Destroy chart instances only on unmount — the effects above update
  // existing instances in place on data/theme changes.
  useEffect(
    () => () => {
      lineChartRef.current?.destroy();
      lineChartRef.current = null;
      barChartRef.current?.destroy();
      barChartRef.current = null;
    },
    [],
  );

  return (
    <div class="chart-panel">
      <div class="chart-card">
        <h3 class="chart-card-title">Monthly Activity</h3>
        <div class="chart-canvas-wrapper">
          <canvas ref={lineCanvasRef} aria-label="Monthly PR activity chart" role="img" />
        </div>
      </div>
      <div class="chart-card">
        <h3 class="chart-card-title">Top Repos</h3>
        <div class="chart-canvas-wrapper">
          <canvas ref={barCanvasRef} aria-label="Top repositories by PR count" role="img" />
        </div>
      </div>
    </div>
  );
}
