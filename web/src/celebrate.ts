async function loadConfetti() {
  return (await import('canvas-confetti')).default;
}

let confettiFn: Awaited<ReturnType<typeof loadConfetti>> | null = null;

export async function fireConfetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  try {
    confettiFn ??= await loadConfetti();
    const confetti = confettiFn;
    const end = Date.now() + 800;
    (function frame() {
      confetti({ particleCount: 4, angle: 60, spread: 55, origin: { x: 0 } });
      confetti({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1 } });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
  } catch { /* toast is the canonical signal */ }
}
