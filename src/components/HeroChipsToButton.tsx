"use client";

import React, {useEffect, useMemo, useRef, useState} from "react";
import { useScrollProgress } from "@/hooks/useScrollProgress";
import OrganicParticlesGL from "@/components/OrganicParticlesGL";

type Chip = {
  id: string;
  label: string;
};

/**
 * A full-screen hero with floating chips that disintegrate into particles and coalesce
 * into a CTA-shaped rounded rectangle as the user scrolls. A real button fades in
 * exactly where the particles form and the canvas fades away.
 *
 * No external animation libs. One requestAnimationFrame loop that reads a single
 * scroll progress value [0..1] derived from window.scrollY over one viewport height.
 */
export default function HeroChipsToButton(): React.ReactElement {
  const chips: Chip[] = useMemo(
    () => [
      { id: "banking", label: "Banking" },
      { id: "payments", label: "Payments" },
      { id: "company", label: "Company cards" },
      { id: "personal", label: "Personal banking" },
      { id: "accounting", label: "Accounting automations" },
      { id: "expense", label: "Expense management" },
      { id: "capital", label: "Capital" },
      { id: "invoicing", label: "Invoicing" },
    ],
    []
  );

  // sceneRef = scrollable section; stageRef = sticky viewport-sized stage
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const headlineRef = useRef<HTMLHeadingElement | null>(null);
  const [ctaState, setCtaState] = useState<{ x: number; y: number; w: number; h: number; r: number } | null>(null);
  const chipRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const [mounted, setMounted] = useState(false);

  // Progress is 0..1 based on how much the hero fills the viewport.
  const progress = useScrollProgress(sceneRef as React.MutableRefObject<HTMLElement | null>);
  const progressRef = useRef(0);

  // Particle state is deterministic from seeds; we only store seeds and compute per frame.
  type Particle = {
    seed: number; // 0..1
    source: { x: number; y: number }; // chip center at spawn time (CSS px in container space)
    angle: number; // radians
    speed: number; // burst distance scale
    target: { x: number; y: number }; // target inside CTA rounded-rect
  };
  const particlesRef = useRef<Particle[] | null>(null);
  const colorsRef = useRef<string[]>(["#0b1720", "#0d1c24", "#112634", "#0b1720", "#0e1a22", "#0b1720", "#0f2028", "#0b1720"]);

  // CTA visual parameters (will be computed from layout each resize)
  const ctaRef = useRef({ x: 0, y: 0, w: 220, h: 44, r: 22 });

  useEffect(() => {
    setMounted(true);
  }, []);

  // Utility easing functions
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  // Measure layout → compute CTA placement (no canvas here; GL handles particles)
  useEffect(() => {
    if (!mounted) return;
    const container = stageRef.current;
    if (!container) return;

    const measure = () => {
      const headline = container.querySelector("[data-hero-headline]") as HTMLElement;
      if (!headline) return;
      const rect = headline.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const centerX = rect.left - containerRect.left + rect.width / 2;
      const baseY = rect.top - containerRect.top + rect.height + 32; // 32px below headline
      const w = 280, h = 64, r = 16;
      const rectCta = { x: centerX - w / 2, y: baseY - h / 2, w, h, r };
      ctaRef.current = rectCta;
      setCtaState(rectCta);
    };

    const ro = new ResizeObserver(measure);
    ro.observe(container);
    measure();
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [mounted]);

  // Mirror hook progress into a ref for the canvas loop without causing rerenders
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  // Removed old canvas utilities (GL handles drawing)

  // Sequential chip fade-in mirroring GL chip clustering timeline
  useEffect(() => {
    if (!mounted) return;
    let raf = 0;
    const ids = chips.map((c) => c.id);
    const chipStart = 0.12; // shader gating start
    const chipEnd = 0.72;   // shader gating end
    const explodeStart = 0.68; // shader explosion start
    const explodeEnd = 0.78;   // shader explosion end
    const preExplodeFadeLead = 0.04; // chips finish fading before explosion begins
    const hideStart = Math.max(0, explodeStart - preExplodeFadeLead);
    const hideEnd = explodeStart;
    const span = Math.max(0.001, chipEnd - chipStart);
    const tick = () => {
      const p = progressRef.current;
      const n = Math.max(1, ids.length);
      for (let i = 0; i < n; i++) {
        const el = chipRefs.current[ids[i]];
        if (!el) continue;
        const w0 = chipStart + (i / n) * span;
        const w1 = chipStart + ((i + 1) / n) * span;
        // Delay fade into the latter portion of the chip window
        const lateFactor = 0.7;  // start fade at 70% through the chip's window
        const postPad = 0.04;    // allow a small overrun after the window
        const f0 = w0 + (w1 - w0) * lateFactor;
        const f1 = Math.min(chipEnd - 0.02, w1 + postPad);
        let alpha = 0;
        if (p <= f0) {
          alpha = 0;
        } else if (p >= f1) {
          alpha = 1;
        } else {
          alpha = easeInOutCubic((p - f0) / Math.max(0.0001, f1 - f0));
        }

        // Pre-explosion fade: chips fade out completely before particles move to cloud
        let fadeOutFactor = 1;
        if (p <= hideStart) {
          fadeOutFactor = 1;
        } else if (p >= hideEnd) {
          fadeOutFactor = 0;
        } else {
          const tfo = (p - hideStart) / Math.max(0.0001, (hideEnd - hideStart));
          fadeOutFactor = 1 - easeInOutCubic(tfo);
        }
        // After explosion, keep hidden
        if (p >= explodeStart) fadeOutFactor = 0;
        alpha = Math.min(alpha, fadeOutFactor);
        el.style.opacity = String(alpha);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mounted, chips]);

  // Chip decorator
  const ChipEl = ({ chip, className }: { chip: Chip; className: string }) => (
    <span
      ref={(el) => {
        chipRefs.current[chip.id] = el;
      }}
      className={
        "select-none inline-flex items-center gap-2 rounded-full bg-white/70 backdrop-blur px-4 py-2 text-sm text-zinc-900 shadow-sm ring-1 ring-black/10 chip-float-a will-change-transform " +
        className
      }
      style={{
        boxShadow: "0 1px 0 rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.7)",
        opacity: 0,
      }}
    >
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900">
        <span className="block h-2.5 w-2.5 rounded-full bg-white"></span>
      </span>
      <span className="relative z-10">{chip.label}</span>
    </span>
  );

  return (
    <section
      ref={sceneRef}
      className="relative h-[220vh] w-full rounded-[28px] bg-[#B4CBBC]"
    >
      <div ref={stageRef} className="sticky top-0 h-[100vh] relative">
        {/* WebGL particles */}
        {stageRef.current && (
        <OrganicParticlesGL
          stageRef={stageRef as React.RefObject<HTMLDivElement>}
          headlineRef={headlineRef as any}
          chipRects={chips.map((c, i) => {
            const el = chipRefs.current[c.id];
            const stageRect = stageRef.current?.getBoundingClientRect();
            const r = el?.getBoundingClientRect();
            let rect = new DOMRect(0,0,0,0);
            if (r && stageRect) {
              rect = new DOMRect(
                r.left - stageRect.left,
                r.top - stageRect.top,
                r.width,
                r.height
              );
            }
            return { id: c.id, rect, color: colorsRef.current[i % colorsRef.current.length] };
          })}
          ctaRect={ctaState}
          progress={progress}
        />)}

        {/* CTA button positioned where particles coalesce. Rendered relative to stage to avoid container offset */}
        <CTAOverlay progressRef={progressRef} ctaRef={ctaRef} />

        <div className="relative z-10 mx-auto flex h-full max-w-5xl flex-col items-center justify-center px-6 text-center">
        <h1
          data-hero-headline
          ref={headlineRef}
          className="text-balance text-5xl font-semibold leading-tight text-zinc-900 md:text-7xl"
        >
          With all your money moves in one place, momentum comes standard.
        </h1>

        {/* Floating chips placed around headline */}
        <div className="pointer-events-none absolute inset-0">
          {/* top center */}
          <div className="absolute left-1/2 top-[14%] -translate-x-1/2">
            <ChipEl chip={chips[0]} className="" />
          </div>
          {/* right upper */}
          <div className="absolute right-[16%] top-[22%]">
            <ChipEl chip={chips[1]} className="" />
          </div>
          <div className="absolute right-[10%] top-[45%]">
            <ChipEl chip={chips[2]} className="chip-float-b" />
          </div>
          {/* left mid */}
          <div className="absolute left-[8%] top-[44%]">
            <ChipEl chip={chips[3]} className="chip-float-b" />
          </div>
          <div className="absolute left-[28%] top-[60%]">
            <ChipEl chip={chips[4]} className="" />
          </div>
          <div className="absolute right-[22%] top-[60%]">
            <ChipEl chip={chips[5]} className="" />
          </div>
          <div className="absolute left-[32%] top-[26%]">
            <ChipEl chip={chips[6]} className="" />
          </div>
          <div className="absolute left-1/2 top-[74%] -translate-x-1/2">
            <ChipEl chip={chips[7]} className="" />
          </div>
        </div>
      </div>
      {/* close sticky stage */}
      </div>
      {/* end sticky stage */}
    </section>
  );
}

function CTAOverlay({
  progressRef,
  ctaRef,
}: {
  progressRef: React.MutableRefObject<number>;
  ctaRef: React.MutableRefObject<{ x: number; y: number; w: number; h: number; r: number }>;
}) {
  // A tiny rAF loop to update local state for opacity without forcing the parent to rerender heavy canvas
  const [opacity, setOpacity] = useState(0);
  const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0 });
  const rafRef = useRef(0);

  useEffect(() => {
    const tick = () => {
      const p = progressRef.current;
      // Fade in between 0.95 → 1
      const t = Math.max(0, Math.min(1, (p - 0.95) / 0.05));
      const nextOpacity = t;
      const { x, y, w, h, r } = ctaRef.current;
      setOpacity(nextOpacity);
      setStyle({
        opacity: nextOpacity,
        transform: `translate(${Math.round(x)}px, ${Math.round(y)}px)`,
        width: w,
        height: h,
        borderRadius: r,
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [progressRef, ctaRef]);

  return (
    <div
      className="pointer-events-none absolute left-0 top-0"
      style={style}
      aria-hidden={opacity < 0.01}
    >
      <a
        href="#"
        className="pointer-events-auto inline-flex h-full w-full items-center justify-center rounded-full bg-white/80 px-6 text-sm font-medium text-zinc-900 shadow-sm ring-1 ring-black/10 backdrop-blur hover:bg-white"
      >
        Explore Demo
      </a>
    </div>
  );
}


