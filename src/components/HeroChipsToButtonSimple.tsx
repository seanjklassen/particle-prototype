"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useScrollProgress } from "@/hooks/useScrollProgress";
import OrganicParticlesGL from "@/components/OrganicParticlesGL";
import { playChordStaggered, playGlide, resumeAudio, markFlourishNow, playBleepWithCooldown } from "@/utils/bleep";

type Chip = {
  id: string;
  label: string;
};

const CHIPS: Chip[] = [
  { id: "banking", label: "Business Banking" },
  { id: "payments", label: "Payments" },
  { id: "company", label: "Invoicing" },
  { id: "personal", label: "Company cards" },
  { id: "accounting", label: "Accounting automations" },
  { id: "expense", label: "Expense management" },
  { id: "capital", label: "Capital" },
  { id: "insights", label: "Insights" },
  { id: "personalBanking", label: "Personal Banking" },
];

const TIMELINE = {
  // In the simple variant, chips begin fading immediately on scroll
  explodeStart: 0.0,
  // Even snappier fade so it feels like disintegration
  explodeFade: 0.04,
  // CTA reveal remains aligned with the GL timeline (mapped below)
  ctaLineStart: 0.92,
};

export default function HeroChipsToButtonSimple(): React.ReactElement {
  const chips: Chip[] = useMemo(() => CHIPS, []);

  // Map chip ids to notes for hover bleeps
  const noteByChipId: Record<string, number> = useMemo(() => {
    const ids = chips.map(c => c.id);
    const scale = [196.00, 220.00, 246.94, 261.63, 293.66, 329.63, 349.23, 392.00];
    const map: Record<string, number> = {};
    for (let i = 0; i < ids.length; i++) {
      map[ids[i]] = scale[i % scale.length];
    }
    return map;
  }, [chips]);

  const sceneRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const headlineRef = useRef<HTMLHeadingElement | null>(null);
  const headLineStartRef = useRef<HTMLSpanElement | null>(null);
  const headLineFinalRef = useRef<HTMLSpanElement | null>(null);
  const chipRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const [mounted, setMounted] = useState(false);
  const ctaVisibleRef = useRef(false);

  const progress = useScrollProgress(sceneRef as React.MutableRefObject<HTMLElement | null>);
  const progressRef = useRef(0);
  const timelineProgressRef = useRef(0);
  useEffect(() => {
    progressRef.current = progress;
    // Map simple progress [0..1] → full timeline [0.68..1] so explosion starts immediately
    const mapped = 0.68 + progress * (1 - 0.68);
    timelineProgressRef.current = mapped;
  }, [progress]);

  const ctaRef = useRef({ x: 0, y: 0, w: 220, h: 44, r: 22 });
  const [ctaState, setCtaState] = useState<{ x: number; y: number; w: number; h: number; r: number } | null>(null);

  useEffect(() => { setMounted(true); }, []);

  const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

  // Measure CTA target based on headline
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
      const baseY = rect.top - containerRect.top + rect.height + 32 + 32;
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

  // rAF: simple chip visibility — all visible until explosion, then fade away
  useEffect(() => {
    if (!mounted) return;
    let raf = 0;
    const { explodeStart, explodeFade, ctaLineStart } = TIMELINE;
    const hash01 = (id: string) => {
      let h = 0;
      for (let i = 0; i < id.length; i++) {
        h = (h * 31 + id.charCodeAt(i)) >>> 0;
      }
      return (h % 1000) / 1000;
    };
    const tick = () => {
      const p = progressRef.current;
      const tP = timelineProgressRef.current; // mapped to GL timeline
      const baseStart = explodeStart;
      const baseDur = explodeFade;
      const baseEnd = baseStart + baseDur;

      // Headline transition with no crossover, final line completes before CTA fully formed
      {
        // Fade OUT the start line even earlier, quickly
        const outS = Math.max(0, ctaLineStart - 0.14);
        const outE = Math.max(0, ctaLineStart - 0.05);
        let aStart = 1;
        if (tP <= outS) aStart = 1; else if (tP >= outE) aStart = 0; else aStart = 1 - easeOutCubic((tP - outS) / Math.max(0.0001, outE - outS));

        // Fade IN the final line immediately after, finishing before CTA fully forms
        const inS = outE;
        const inE = Math.max(inS + 0.005, ctaLineStart - 0.01);
        let aFinal = 0;
        if (tP <= inS) aFinal = 0; else if (tP >= inE) aFinal = 1; else aFinal = easeInOutCubic((tP - inS) / Math.max(0.0001, inE - inS));

        const h0 = headLineStartRef.current; const h1 = headLineFinalRef.current;
        if (h0) { h0.style.opacity = String(aStart); h0.setAttribute('aria-hidden', aStart < 0.01 ? 'true' : 'false'); }
        if (h1) { h1.style.opacity = String(aFinal); h1.setAttribute('aria-hidden', aFinal < 0.01 ? 'true' : 'false'); }
      }

      chips.forEach((c) => {
        const el = chipRefs.current[c.id];
        if (!el) return;
        const n = hash01(c.id);
        // Stronger early-start skew, still synchronized end
        const startJitter = (n - 0.85) * 0.12; // ~[-0.102 .. +0.018]
        const start = Math.max(0, baseStart + startJitter);
        const end = baseEnd;
        const dur = Math.max(0.016, end - start);
        let a = 1;
        if (p < start) a = 1;
        else if (p >= end) a = 0;
        else a = 1 - easeOutCubic((p - start) / Math.max(0.0001, dur));
        el.style.opacity = String(a);
        el.style.pointerEvents = a > 0.05 ? "auto" : "none";
      });

      // CTA flourish when it forms
      const nowVisible = tP >= ctaLineStart;
      if (nowVisible && !ctaVisibleRef.current) {
        (async () => {
          try {
            await resumeAudio();
            if (markFlourishNow()) {
              playGlide(196.0, 293.66, 180, 0, 0.02, "square");
              playChordStaggered([392.0, 493.88, 587.33], 18, 90, 120, 0.018);
            }
          } catch {}
        })();
      }
      ctaVisibleRef.current = nowVisible;

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mounted, chips]);

  const ChipEl = ({ chip, className }: { chip: Chip; className: string }) => (
    <span
      ref={(el) => {
        chipRefs.current[chip.id] = el;
      }}
      className={
        "select-none inline-flex items-center gap-2 rounded-full bg-[#3A3831]/90 px-4 py-2 text-white ring-1 ring-black/10 chip-float-a will-change-transform arcadia-text-17 cursor-pointer " +
        className
      }
      style={{ boxShadow: "none", opacity: 1 }}
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

  return (
    <section ref={sceneRef} className="relative h-[220vh] w-full rounded-[28px] bg-[#F6F5F2]">
      <div ref={stageRef} className="sticky top-0 h-[100vh] relative">
        {stageRef.current && (
          <OrganicParticlesGL
            stageRef={stageRef as React.RefObject<HTMLDivElement>}
            headlineRef={headlineRef as React.RefObject<HTMLElement>}
            chipRects={((): Array<{ id: string; rect: DOMRect }> => {
              const orderIds = CHIPS.map(c => c.id);
              const stageRect = stageRef.current?.getBoundingClientRect();
              return orderIds.map((id) => {
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
            // feed remapped progress so explosion begins at scroll start
            progress={0.68 + progress * (1 - 0.68)}
          />
        )}

        {/* Use remapped progress for CTA overlay timing too */}
        <CTAOverlay progressRef={timelineProgressRef} ctaRef={ctaRef} />

        {/* Removed bottom blur overlay per request */}

        <div className="relative z-10 mx-auto flex h-full max-w-5xl flex-col items-center justify-center px-6 text-center">
          <h1
            data-hero-headline
            ref={headlineRef}
            className="relative text-balance leading-tight text-zinc-900 text-[36px] arcadia-display"
          >
            <span className="block invisible select-none">Greater than the sum of its parts</span>
            <span
              ref={headLineStartRef}
              className="absolute inset-0 flex items-center justify-center text-center"
              style={{ opacity: 1 }}
            >
              One financial platform
            </span>
            <span
              ref={headLineFinalRef}
              className="absolute inset-0 flex items-center justify-center text-center"
              style={{ opacity: 0 }}
            >
              Greater than the sum of its parts
            </span>
          </h1>

          <div className="pointer-events-none absolute inset-0">
            <div className="pointer-events-auto absolute left-1/2 top-[12%] -translate-x-1/2">
              <ChipEl chip={chips[0]} className="" />
            </div>
            <div className="pointer-events-auto absolute right-[3%] top-[20%]">
              <ChipEl chip={chips[1]} className="" />
            </div>
            <div className="pointer-events-auto absolute right-[2%] top-[48%]">
              <ChipEl chip={chips[2]} className="chip-float-b" />
            </div>
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
            {/* Personal Banking balanced on lower-right quadrant */}
            <div className="pointer-events-auto absolute right-[22%] top-[70%]">
              <ChipEl chip={chips[8]} className="" />
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const tick = () => {
      const el = containerRef.current;
      if (!el) { rafRef.current = requestAnimationFrame(tick); return; }
      const p = progressRef.current;
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


