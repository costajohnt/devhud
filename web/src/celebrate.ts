async function loadConfetti() {
  return (await import('canvas-confetti')).default;
}

let confettiFn: Awaited<ReturnType<typeof loadConfetti>> | null = null;

/**
 * Why the burst did or did not happen. The auto-fire path pairs confetti with
 * a "done" toast, so a silent no-op there still leaves a visible signal — but
 * the manual header button has no such partner, and used to swallow both the
 * reduced-motion return and a failed chunk load with no feedback at all (#54).
 * Reporting the outcome lets each caller decide whether it needs to say
 * something.
 */
export type ConfettiOutcome = 'fired' | 'reduced-motion' | 'failed';

export async function fireConfetti(): Promise<ConfettiOutcome> {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 'reduced-motion';
  try {
    confettiFn ??= await loadConfetti();
    const confetti = confettiFn;
    // Stacked bursts from both sides with randomized origins, ~800ms total —
    // matches oss-autopilot's use-celebration.ts fireConfetti.
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 9999 };
    const end = Date.now() + 800;
    (function frame() {
      for (const xOffset of [0, 0.7]) {
        confetti({ ...defaults, particleCount: 50, origin: { x: xOffset + Math.random() * 0.3, y: Math.random() - 0.2 } });
      }
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
    return 'fired';
  } catch (err) {
    // canvas-confetti is a dynamic import, so it lands in its own
    // content-hashed chunk. A 404 on that chunk (stale cached index.html,
    // partial deploy, rebuild under a live page) rejects here. Never swallow
    // it silently: the console line is what turns "the button is broken" into
    // a diagnosable report.
    console.warn('[simon-dash] confetti failed to load', err);
    return 'failed';
  }
}
