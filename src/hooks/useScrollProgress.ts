"use client";

import { MutableRefObject, useEffect, useRef, useState } from "react";

/**
 * useScrollProgress(ref)
 * Returns a smoothed 0..1 value representing how much the element fills the viewport height.
 *
 * Implementation details:
 * - Uses IntersectionObserver to be efficient and wake on visibility changes.
 * - Computes progress with bounding-rect math as: visibleHeight / viewportHeight.
 * - Applies a small eased lerp (alpha = 0.15) each rAF so consumers get a stable value.
 */
export function useScrollProgress(
  ref: MutableRefObject<HTMLElement | null>
): number {
  const [progress, setProgress] = useState(0);
  const targetRef = useRef(0);
  const currentRef = useRef(0);
  const rafRef = useRef(0);

  // Easing for the lerp step
  const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
  const alpha = easeOut(0.15); // small eased lerp

  // Compute progress for a pinned section where inner content is sticky.
  // Progress goes 0→1 across the scrollable distance of the section:
  // scrolled = clamp(-rect.top, 0, rect.height - vh)
  // progress = scrolled / (rect.height - vh)
  const computeTarget = () => {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const h = Math.max(1, window.innerHeight);
    const total = Math.max(1, r.height - h);
    const scrolled = Math.max(0, Math.min(total, -r.top));
    return scrolled / total;
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Set initial target
    targetRef.current = computeTarget();

    // Observer triggers with fine thresholds to update target value
    const thresholds = Array.from({ length: 51 }, (_, i) => i / 50);
    const io = new IntersectionObserver(() => {
      targetRef.current = computeTarget();
    }, { threshold: thresholds });
    io.observe(el);

    // Also update on resize for accurate math
    const onResize = () => (targetRef.current = computeTarget());
    window.addEventListener("resize", onResize);

    // And on scroll to keep progress responsive while element is on screen
    const onScroll = () => (targetRef.current = computeTarget());
    window.addEventListener("scroll", onScroll, { passive: true });

    // rAF smoother
    const tick = () => {
      const current = currentRef.current + (targetRef.current - currentRef.current) * alpha;
      currentRef.current = current;
      // Commit state only if movement is visible to avoid re-render thrash
      if (Math.abs(current - progress) > 0.001) setProgress(current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      io.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll);
    };
  }, [ref]);

  return progress;
}


