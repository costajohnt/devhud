async function loadConfetti() {
  return (await import('canvas-confetti')).default;
}

let confettiFn: Awaited<ReturnType<typeof loadConfetti>> | null = null;

export async function fireConfetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
  } catch { /* toast is the canonical signal */ }
}
