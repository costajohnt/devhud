import { useEffect, useRef } from 'preact/hooks';
import {
  Chart,
  BarController,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
} from 'chart.js';

// Register only what we need — keeps the lazy chart chunk small.
Chart.register(BarController, CategoryScale, LinearScale, BarElement, Tooltip);

export interface MergedLogEntry { id: string; at: string | null; }

interface ChartPanelProps {
  mergedLog: MergedLogEntry[];
  theme: string;
}

// Chart.js can't read CSS vars directly; map theme to explicit hex values
// matching the palette in styles.css (--purple / --blue / grid/text colors).
function getChartColors(theme: string) {
  if (theme === 'light') {
    return {
      purple: '#9333ea',
      blue: '#2563eb',
      gridColor: 'rgba(15, 23, 42, 0.06)',
      textColor: '#475569',
    };
  }
  return {
    purple: '#c084fc',
    blue: '#60a5fa',
    gridColor: 'rgba(255, 255, 255, 0.06)',
    textColor: '#94a3b8',
  };
}

/** Ascending 'YYYY-MM' keys for the last `n` months, ending this month. */
function lastNMonths(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

/** id is "org/repo#number" — the repo (with org) is everything before '#'. */
function repoOf(id: string): string {
  return id.split('#')[0] ?? id;
}

function monthlyCounts(mergedLog: MergedLogEntry[], months: string[]): number[] {
  const counts = new Map<string, number>();
  for (const e of mergedLog) {
    if (!e.at) continue; // legacy pre-migration entries with no known merge time
    const key = e.at.slice(0, 7);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return months.map(m => counts.get(m) ?? 0);
}

function topRepos(mergedLog: MergedLogEntry[], limit = 8): { repo: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of mergedLog) {
    const repo = repoOf(e.id);
    counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([repo, count]) => ({ repo, count }))
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo))
    .slice(0, limit);
}

export function ChartPanel({ mergedLog, theme }: ChartPanelProps) {
  const monthlyCanvasRef = useRef<HTMLCanvasElement>(null);
  const repoCanvasRef = useRef<HTMLCanvasElement>(null);
  const monthlyChartRef = useRef<Chart | null>(null);
  const repoChartRef = useRef<Chart | null>(null);

  // Merged-per-month bar chart. Created once, then updated in place: fresh
  // array/object identities arrive on every refresh, and destroy-and-recreate
  // would replay the entrance animation on every poll (mirrors oss-autopilot
  // dashboard's chart-panel #1459 fix).
  useEffect(() => {
    const canvas = monthlyCanvasRef.current;
    if (!canvas) return;

    const colors = getChartColors(theme);
    const scaleOpts = { ticks: { color: colors.textColor }, grid: { color: colors.gridColor } };
    const months = lastNMonths(6);
    const counts = monthlyCounts(mergedLog, months);

    const data = {
      labels: months.map(monthLabel),
      datasets: [{ label: 'Merged', data: counts, backgroundColor: colors.purple, borderRadius: 4 }],
    };
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 1200, easing: 'easeOutQuart' as const },
      plugins: { legend: { display: false } },
      scales: {
        x: scaleOpts,
        y: { beginAtZero: true, ticks: { ...scaleOpts.ticks, precision: 0 }, grid: scaleOpts.grid },
      },
    };

    const existing = monthlyChartRef.current;
    if (existing) {
      existing.data = data;
      existing.options = options;
      existing.update('none');
      return;
    }
    monthlyChartRef.current = new Chart(canvas, { type: 'bar', data, options });
  }, [mergedLog, theme]);

  // Merged-by-repo horizontal bar chart — same create-once-then-update-in-place
  // pattern as the monthly chart above.
  useEffect(() => {
    const canvas = repoCanvasRef.current;
    if (!canvas) return;

    const colors = getChartColors(theme);
    const scaleOpts = { ticks: { color: colors.textColor }, grid: { color: colors.gridColor } };
    const repos = topRepos(mergedLog);

    const data = {
      labels: repos.map(r => r.repo),
      datasets: [{ label: 'Merged', data: repos.map(r => r.count), backgroundColor: colors.blue, borderRadius: 4 }],
    };
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 1200, easing: 'easeOutQuart' as const },
      indexAxis: 'y' as const,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { ...scaleOpts.ticks, precision: 0 }, grid: scaleOpts.grid },
        y: scaleOpts,
      },
    };

    const existing = repoChartRef.current;
    if (existing) {
      existing.data = data;
      existing.options = options;
      existing.update('none');
      return;
    }
    repoChartRef.current = new Chart(canvas, { type: 'bar', data, options });
  }, [mergedLog, theme]);

  // Destroy chart instances only on unmount — the effects above update
  // existing instances in place on data/theme changes.
  useEffect(
    () => () => {
      monthlyChartRef.current?.destroy();
      monthlyChartRef.current = null;
      repoChartRef.current?.destroy();
      repoChartRef.current = null;
    },
    [],
  );

  return (
    <div class="chart-panel">
      <div class="chart-card">
        <h3 class="chart-card-title">Merged per Month</h3>
        <div class="chart-canvas-wrapper">
          <canvas ref={monthlyCanvasRef} aria-label="Pull requests merged per month" role="img" />
        </div>
      </div>
      <div class="chart-card">
        <h3 class="chart-card-title">Merged by Repo</h3>
        <div class="chart-canvas-wrapper">
          <canvas ref={repoCanvasRef} aria-label="Pull requests merged by repository" role="img" />
        </div>
      </div>
    </div>
  );
}
