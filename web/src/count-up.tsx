import { useEffect, useRef, useState } from 'preact/hooks';

// Ported from oss-autopilot's hooks/use-count-up.ts + components/animated-value.tsx.

function useCountUp(target: number, duration = 800): number {
  const [value, setValue] = useState(0);
  const valueRef = useRef(0);
  valueRef.current = value;
  const rafRef = useRef(0);
  const startTimeRef = useRef(0);
  const startValueRef = useRef(0);

  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (prefersReducedMotion) {
      setValue(target);
      return;
    }

    if (target === 0) {
      setValue(0);
      return;
    }

    startValueRef.current = valueRef.current;
    startTimeRef.current = 0;

    const step = (timestamp: number) => {
      if (!startTimeRef.current) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(startValueRef.current + (target - startValueRef.current) * eased);
      setValue(current);
      if (progress < 1) rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target, duration]);

  return value;
}

export function AnimatedValue({ value }: { value: number }) {
  const animated = useCountUp(value);
  return <>{animated}</>;
}
