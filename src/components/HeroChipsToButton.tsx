"use client";

import React, {useEffect, useMemo, useRef, useState} from "react";
import { useScrollProgress } from "@/hooks/useScrollProgress";
import OrganicParticlesGL from "@/components/OrganicParticlesGL";
import { playBleepWithCooldown, resumeAudio, playChordStaggered, playGlide, markFlourishNow } from "@/utils/bleep";

type Chip = {
  id: string;
  label: string;
};

// ====== Config: Chips and Timeline (edit here to tweak labels and timings) ======
const CHIPS: Chip[] = [
  { id: "banking", label: "Business Banking" },
  { id: "payments", label: "Payments" },
  { id: "company", label: "Invoicing" },
  { id: "personal", label: "Company cards" },
  { id: "accounting", label: "Accounting automations" },
  { id: "expense", label: "Expense management" },
  { id: "capital", label: "Capital" },
  { id: "insights", label: "Insights" },
];

const TIMELINE = {
  explodeStart: 0.68,
  preExplodeFadeLead: 0.06,
  ctaLineStart: 0.92,
  lateFactor: 0.6,
  extraDelayById: {
    banking: 0.05,
    personal: 0.05,
  } as Record<string, number>,
  groups: [
    { ids: ["banking", "personal", "payments"], start: 0.00, end: 0.14 },
    { ids: ["expense", "accounting", "company"], start: 0.14, end: 0.28 },
    { ids: ["capital", "insights"], start: 0.26, end: 0.40 },
  ],
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
  const chips: Chip[] = useMemo(() => CHIPS, []);

  // Map chips to G Mixolydian notes (G A B C D E F G). 8 chips → include top G.
  // One octave lower: G3→G4
  const noteByChipId: Record<string, number> = useMemo(() => {
    const ids = chips.map(c => c.id);
    const scale = [196.00, 220.00, 246.94, 261.63, 293.66, 329.63, 349.23, 392.00];
    const map: Record<string, number> = {};
    for (let i = 0; i < ids.length; i++) {
      map[ids[i]] = scale[i % scale.length];
    }
    return map;
  }, [chips]);

  // sceneRef = scrollable section; stageRef = sticky viewport-sized stage
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
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
  const ctaVisibleRef = useRef(false);

  // Progress is 0..1 based on how much the hero fills the viewport.
  const progress = useScrollProgress(sceneRef as React.MutableRefObject<HTMLElement | null>);
  const progressRef = useRef(0);


  // CTA visual parameters (will be computed from layout each resize)
  const ctaRef = useRef({ x: 0, y: 0, w: 220, h: 44, r: 22 });

  useEffect(() => {
    setMounted(true);
  }, []);

  // Utility easing functions
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
      const w = 160, h = 40, r = h / 2;
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

  // Unified rAF loop updates both chip fades and headline sequencing
  useEffect(() => {
    if (!mounted) return;
    let raf = 0;
    const explodeStart = TIMELINE.explodeStart;
    const preExplodeFadeLead = TIMELINE.preExplodeFadeLead;
    const hideStart = Math.max(0, explodeStart - preExplodeFadeLead);
    const hideEnd = explodeStart;

    const groups: Array<{ ids: string[]; start: number; end: number }> = TIMELINE.groups;

    const extraDelayById: Record<string, number> = TIMELINE.extraDelayById;

    const timelineById: Record<string, { start: number; end: number; idx: number; count: number }> = {};
    groups.forEach((g) => {
      const count = g.ids.length;
      g.ids.forEach((id, idx) => {
        const s = g.start + (idx / count) * (g.end - g.start);
        const e = g.start + ((idx + 1) / count) * (g.end - g.start);
        timelineById[id] = { start: s, end: e, idx, count };
      });
    });

    const g1 = TIMELINE.groups[0];
    const g2 = TIMELINE.groups[1];
    const g3 = TIMELINE.groups[2];
    const ctaLineStart = TIMELINE.ctaLineStart; // ensure final line fully fades in by p=1

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
      // Chips
      chips.forEach((c) => {
        const el = chipRefs.current[c.id];
        if (!el) return;
        const tl = (timelineById as any)[c.id];
        if (!tl) { el.style.opacity = "0"; return; }
        const lateFactor = TIMELINE.lateFactor;
        const extra = extraDelayById[c.id] ?? 0;
        const start = tl.start + (tl.end - tl.start) * lateFactor + extra;
        const end = Math.min(tl.end + 0.04 + extra, groups[groups.length - 1].end);
        let alpha = 0;
        if (p <= start) alpha = 0; else if (p >= end) alpha = 1; else alpha = easeInOutCubic((p - start) / Math.max(0.0001, end - start));
        let fadeOutFactor = 1;
        if (p <= hideStart) fadeOutFactor = 1; else if (p >= hideEnd) fadeOutFactor = 0; else fadeOutFactor = 1 - easeInOutCubic((p - hideStart) / Math.max(0.0001, hideEnd - hideStart));
        if (p >= explodeStart) fadeOutFactor = 0;
        const vis = Math.min(alpha, fadeOutFactor);
        el.style.opacity = String(vis);
        // Disable hover/audio when invisible
        el.style.pointerEvents = vis > 0.05 ? "auto" : "none";
      });

      // Headline
      const platformInStart = explodeStart - 0.02;
      const platformInEnd = explodeStart + 0.06;
      const platformHoldEnd = Math.min(0.93, ctaLineStart - 0.04);
      const platformOutEnd = Math.max(platformHoldEnd + 0.03, ctaLineStart - 0.01);

      const a0 = windowAlpha(p, g1.start, g1.end);
      const a1 = windowAlpha(p, g2.start, g2.end);
      const inS3 = g3.start;
      const inE3 = g3.start + (g3.end - g3.start) * 0.25;
      const holdEnd3 = Math.max(g3.end, platformInStart - 0.01);
      let a2 = 0;
      if (p <= inS3) a2 = 0; else if (p < inE3) a2 = easeInOutCubic((p - inS3) / Math.max(0.0001, inE3 - inS3)); else if (p < holdEnd3) a2 = 1; else if (p < explodeStart) a2 = 1 - easeInOutCubic((p - holdEnd3) / Math.max(0.0001, explodeStart - holdEnd3)); else a2 = 0;
      let a3 = 0;
      if (p < platformInStart) a3 = 0; else if (p < platformInEnd) a3 = easeInOutCubic((p - platformInStart) / Math.max(0.0001, platformInEnd - platformInStart)); else if (p < platformHoldEnd) a3 = 1; else if (p < platformOutEnd) a3 = 1 - easeInOutCubic((p - platformHoldEnd) / Math.max(0.0001, platformOutEnd - platformHoldEnd)); else a3 = 0;
      let a4 = 0;
      if (p >= ctaLineStart && p < ctaLineStart + 0.08) a4 = easeInOutCubic((p - ctaLineStart) / 0.08); else if (p >= ctaLineStart + 0.08) a4 = 1;

      const alphas = [a0, a1, a2, a3, a4];
      for (let i = 0; i < headlineLines.length; i++) {
        const el = lineRefs.current[i];
        if (!el) continue;
        const a = alphas[i] ?? 0;
        el.style.opacity = String(a);
        el.setAttribute('aria-hidden', a < 0.01 ? 'true' : 'false');
      }

      // Trigger CTA flourish on each formation (rising edge over threshold)
      const threshold = TIMELINE.ctaLineStart;
      const nowVisible = p >= threshold;
      if (nowVisible && !ctaVisibleRef.current) {
        (async () => {
          try {
            await resumeAudio();
            if (markFlourishNow()) {
              playGlide(196.0, 293.66, 180, 0, 0.02, "square");
              playChordStaggered([392.00, 493.88, 587.33], 18, 90, 120, 0.018);
            }
          } catch {}
        })();
      }
      ctaVisibleRef.current = nowVisible;

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mounted, chips, headlineLines]);

  // Chip decorator
  const ChipEl = ({ chip, className }: { chip: Chip; className: string }) => (
    <span
      ref={(el) => {
        chipRefs.current[chip.id] = el;
      }}
      className={
        "select-none inline-flex items-center gap-2 rounded-full bg-[#3A3831]/90 px-4 py-2 text-white ring-1 ring-black/10 chip-float-a will-change-transform arcadia-text-17 cursor-pointer " +
        className
      }
      style={{
        boxShadow: "none",
        opacity: 0,
      }}
      onMouseEnter={async () => {
        try {
          await resumeAudio();
          const freq = noteByChipId[chip.id];
          if (freq) playBleepWithCooldown({ frequency: freq });
        } catch {}
      }}
    >
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/95">
        <span className="block h-2.5 w-2.5 rounded-full bg-[#3A3831]"></span>
      </span>
      <span className="relative z-10">{chip.label}</span>
    </span>
  );
//background color and scroll length, etc.
  return (
    <section
      ref={sceneRef}
      className="relative h-[400vh] w-full rounded-[28px] bg-[#EFEEE9]"
    >
      <div ref={stageRef} className="sticky top-0 h-[100vh] relative">
        {/* WebGL particles */}
        {stageRef.current && (
        <OrganicParticlesGL
          stageRef={stageRef as React.RefObject<HTMLDivElement>}
          headlineRef={headlineRef as React.RefObject<HTMLElement>}
          chipRects={((): Array<{ id: string; rect: DOMRect }> => {
            // Derive GL order from TIMELINE.groups for a single source of truth
            const orderIds = TIMELINE.groups.flatMap(g => g.ids);
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
              return { id, rect };
            }).filter((c) => c.rect.width > 0 && c.rect.height > 0);
          })()}
          ctaRect={ctaState}
          progress={progress}
        />)}

        {/* CTA button positioned where particles coalesce. Rendered relative to stage to avoid container offset */}
        <CTAOverlay progressRef={progressRef} ctaRef={ctaRef} />

        {/* Bottom blur overlay removed */}

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
          <div className="pointer-events-auto absolute left-1/2 top-[12%] -translate-x-1/2">
            <ChipEl chip={chips[0]} className="" />
          </div>
          {/* right upper */}
          <div className="pointer-events-auto absolute right-[3%] top-[20%]">
            <ChipEl chip={chips[1]} className="" />
          </div>
          <div className="pointer-events-auto absolute right-[2%] top-[48%]">
            <ChipEl chip={chips[2]} className="chip-float-b" />
          </div>
          {/* left mid */}
          <div className="pointer-events-auto absolute left-[2%] top-[42%]">
            <ChipEl chip={chips[3]} className="chip-float-b" />
          </div>
          <div className="pointer-events-auto absolute left-[18%] top-[63%]">
            <ChipEl chip={chips[4]} className="" />
          </div>
          <div className="pointer-events-auto absolute right-[6%] top-[63%]">
            <ChipEl chip={chips[5]} className="" />
          </div>
          <div className="pointer-events-auto absolute left-[20%] top-[22%]">
            <ChipEl chip={chips[6]} className="" />
          </div>
          <div className="pointer-events-auto absolute left-1/2 top-[78%] -translate-x-1/2">
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
  // rAF loop updates DOM styles directly to avoid per-frame React state
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const tick = () => {
      const el = containerRef.current;
      if (!el) { rafRef.current = requestAnimationFrame(tick); return; }
      const p = progressRef.current;
      // Fade in between 0.88 → 0.96
      const t = Math.max(0, Math.min(1, (p - 0.88) / 0.08));
      const { x, y, w, h, r } = ctaRef.current;
      el.style.opacity = String(t);
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.borderRadius = `${r}px`;
      el.setAttribute('aria-hidden', t < 0.01 ? 'true' : 'false');
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [progressRef, ctaRef]);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute left-0 top-0"
      aria-hidden
      style={{ opacity: 0 }}
    >
      <a
        href="#"
        role="button"
        aria-label="Launch demo"
        title="Launch demo"
        className="pointer-events-auto inline-flex h-full w-full items-center justify-center rounded-full bg-[#3A3831]/95 px-6 text-white ring-1 ring-black/10 hover:bg-[#3A3831] arcadia-text-17 cursor-pointer"
      >
        Launch Demo
      </a>
    </div>
  );
}


