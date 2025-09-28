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
      { id: "banking", label: "Business Banking" },
      { id: "payments", label: "Payments" },
      { id: "company", label: "Invoicing" },
      { id: "personal", label: "Company cards" },
      { id: "accounting", label: "Accounting automations" },
      { id: "expense", label: "Expense management" },
      { id: "capital", label: "Capital" },
      { id: "insights", label: "Insights" },
    ],
    []
  );

  // sceneRef = scrollable section; stageRef = sticky viewport-sized stage
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const headlineRef = useRef<HTMLHeadingElement | null>(null);
  const headlineLines = useMemo(
    () => [
      "Move money quickly",
      "Control spend automatically",
      "Fund growth intelligently",
      "In one platform designed to be",
      "Greater than the sum of its parts",
    ],
    []
  );
  const lineRefs = useRef<Array<HTMLSpanElement | null>>([]);
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
      const baseY = rect.top - containerRect.top + rect.height + 32 + 32; // 104px below headline (32 + 72 offset)
      const w = 280, h = 64, r = h / 2;
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

  // Grouped chip fade-in aligned to headline sequencing
  useEffect(() => {
    if (!mounted) return;
    let raf = 0;
    const explodeStart = 0.68;
    const explodeEnd = 0.78;
    const preExplodeFadeLead = 0.06;
    const hideStart = Math.max(0, explodeStart - preExplodeFadeLead);
    const hideEnd = explodeStart;

    const groups: Array<{ ids: string[]; start: number; end: number }> = [
      // Move money quickly → Business Banking (banking), Company cards (personal), Payments (payments)
      { ids: ["banking", "personal", "payments"], start: 0.00, end: 0.14 },
      // Control spend automatically → Expense management, Accounting automations, Invoicing
      { ids: ["expense", "accounting", "company"], start: 0.14, end: 0.28 },
      // Fund growth intelligently → Capital, Insights
      { ids: ["capital", "insights"], start: 0.28, end: 0.42 },
    ];

    // Slightly delay the first two chips to better match particle coalescence
    const extraDelayById: Record<string, number> = {
      banking: 0.05,
      personal: 0.05,
    };

    const timelineById: Record<string, { start: number; end: number; idx: number; count: number }> = {};
    groups.forEach((g) => {
      const count = g.ids.length;
      g.ids.forEach((id, idx) => {
        const s = g.start + (idx / count) * (g.end - g.start);
        const e = g.start + ((idx + 1) / count) * (g.end - g.start);
        timelineById[id] = { start: s, end: e, idx, count };
      });
    });

    const tick = () => {
      const p = progressRef.current;
      chips.forEach((c) => {
        const el = chipRefs.current[c.id];
        if (!el) return;
        const tl = (timelineById as any)[c.id];
        if (!tl) {
          el.style.opacity = "0";
          return;
        }
        const lateFactor = 0.6;
        const extra = extraDelayById[c.id] ?? 0;
        const start = tl.start + (tl.end - tl.start) * lateFactor + extra;
        const end = Math.min(tl.end + 0.04 + extra, groups[groups.length - 1].end);
        let alpha = 0;
        if (p <= start) alpha = 0;
        else if (p >= end) alpha = 1;
        else alpha = easeInOutCubic((p - start) / Math.max(0.0001, end - start));

        // Pre-explosion fade
        let fadeOutFactor = 1;
        if (p <= hideStart) fadeOutFactor = 1;
        else if (p >= hideEnd) fadeOutFactor = 0;
        else fadeOutFactor = 1 - easeInOutCubic((p - hideStart) / Math.max(0.0001, hideEnd - hideStart));
        if (p >= explodeStart) fadeOutFactor = 0;

        el.style.opacity = String(Math.min(alpha, fadeOutFactor));
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mounted, chips]);

  // Headline sequencing aligned to chip groups and later phases
  useEffect(() => {
    if (!mounted) return;
    let raf = 0;
    const g1 = { start: 0.00, end: 0.14 };
    const g2 = { start: 0.14, end: 0.28 };
    const g3 = { start: 0.28, end: 0.42 };
    const explodeStart = 0.68;
    const ctaLineStart = 0.92; // start earlier so the final line fully fades in by p=1

    const windowAlpha = (p: number, s: number, e: number) => {
      const inS = s;
      const inE = s + (e - s) * 0.25;
      const outS = e - (e - s) * 0.20;
      const outE = e;
      if (p <= inS) return 0;
      if (p < inE) return easeInOutCubic((p - inS) / Math.max(0.0001, inE - inS));
      if (p < outS) return 1;
      if (p < outE) return 1 - easeInOutCubic((p - outS) / Math.max(0.0001, outE - outS));
      return 0;
    };

    const tick = () => {
      const p = progressRef.current;
      const a0 = windowAlpha(p, g1.start, g1.end); // Move money quickly
      const a1 = windowAlpha(p, g2.start, g2.end); // Control spend automatically
      const a2 = windowAlpha(p, g3.start, g3.end); // Fund growth intelligently
      // Line 4: In one platform designed to be → appears around explosion, then fades before line 5
      let a3 = 0;
      const platformInStart = explodeStart - 0.02;
      const platformInEnd = explodeStart + 0.06;
      const platformHoldEnd = Math.min(0.93, ctaLineStart - 0.04);
      const platformOutEnd = Math.max(platformHoldEnd + 0.03, ctaLineStart - 0.01);
      if (p < platformInStart) {
        a3 = 0;
      } else if (p < platformInEnd) {
        a3 = easeInOutCubic((p - platformInStart) / Math.max(0.0001, platformInEnd - platformInStart));
      } else if (p < platformHoldEnd) {
        a3 = 1;
      } else if (p < platformOutEnd) {
        a3 = 1 - easeInOutCubic((p - platformHoldEnd) / Math.max(0.0001, platformOutEnd - platformHoldEnd));
      } else {
        a3 = 0;
      }
      let a4 = 0; // Greater than the sum of its parts
      if (p >= ctaLineStart && p < ctaLineStart + 0.08) {
        a4 = easeInOutCubic((p - ctaLineStart) / 0.08);
      } else if (p >= ctaLineStart + 0.08) {
        a4 = 1;
      }

      const alphas = [a0, a1, a2, a3, a4];
      for (let i = 0; i < headlineLines.length; i++) {
        const el = lineRefs.current[i];
        if (!el) continue;
        el.style.opacity = String(alphas[i] ?? 0);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mounted, headlineLines]);

  // Chip decorator
  const ChipEl = ({ chip, className }: { chip: Chip; className: string }) => (
    <span
      ref={(el) => {
        chipRefs.current[chip.id] = el;
      }}
      className={
        "select-none inline-flex items-center gap-2 rounded-full bg-white/70 backdrop-blur px-4 py-2 text-zinc-900 shadow-sm ring-1 ring-black/10 chip-float-a will-change-transform arcadia-text-17 " +
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
      className="relative h-[340vh] w-full rounded-[28px] bg-[#9D98C3]"
    >
      <div ref={stageRef} className="sticky top-0 h-[100vh] relative">
        {/* WebGL particles */}
        {stageRef.current && (
        <OrganicParticlesGL
          stageRef={stageRef as React.RefObject<HTMLDivElement>}
          headlineRef={headlineRef as any}
          chipRects={((): Array<{ id: string; rect: DOMRect; color: string }> => {
            // Reorder GL gating to match group sequencing and headline timing
            const orderIds = [
              // Group 1
              "banking", "personal", "payments",
              // Group 2
              "expense", "accounting", "company",
              // Group 3
              "capital", "insights",
            ];
            const stageRect = stageRef.current?.getBoundingClientRect();
            return orderIds.map((id, i) => {
              const el = chipRefs.current[id];
              const r = el?.getBoundingClientRect();
              let rect = new DOMRect(0, 0, 0, 0);
              if (r && stageRect) {
                rect = new DOMRect(
                  r.left - stageRect.left,
                  r.top - stageRect.top,
                  r.width,
                  r.height
                );
              }
              return { id, rect, color: colorsRef.current[i % colorsRef.current.length] };
            }).filter((c) => c.rect.width > 0 && c.rect.height > 0);
          })()}
          ctaRect={ctaState}
          progress={progress}
        />)}

        {/* CTA button positioned where particles coalesce. Rendered relative to stage to avoid container offset */}
        <CTAOverlay progressRef={progressRef} ctaRef={ctaRef} />

        <div className="relative z-10 mx-auto flex h-full max-w-5xl flex-col items-center justify-center px-6 text-center">
        <h1
          data-hero-headline
          ref={headlineRef}
          className="relative text-balance leading-tight text-zinc-900 text-[36px] arcadia-display"
        >
          {/* Layout keeper to preserve width/height for CTA measurement */}
          <span className="block invisible select-none">Greater than the sum of its parts</span>
          {headlineLines.map((text, idx) => (
            <span
              key={idx}
              ref={(el) => { lineRefs.current[idx] = el; }}
              className="absolute inset-0 flex items-center justify-center will-change-opacity text-center pointer-events-none"
              style={{ opacity: idx === 0 ? 1 : 0 }}
            >
              {text}
            </span>
          ))}
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
        className="pointer-events-auto inline-flex h-full w-full items-center justify-center rounded-full bg-white/80 px-6 text-zinc-900 shadow-sm ring-1 ring-black/10 backdrop-blur hover:bg-white arcadia-text-17"
      >
        Explore Demo
      </a>
    </div>
  );
}


