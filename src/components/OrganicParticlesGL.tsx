"use client";

import React, { useEffect, useMemo, useRef } from "react";

// Removed unused Vec2

export type OrganicParticlesGLProps = {
  stageRef: React.RefObject<HTMLDivElement>;
  headlineRef: React.RefObject<HTMLElement>;
  chipRects: Array<{ id: string; rect: DOMRect }>; // measured in stage space
  ctaRect: { x: number; y: number; w: number; h: number; r: number } | null; // stage space
  progress: number; // 0..1 timeline
};

// Minimal, dependency-free WebGL2 instanced particle renderer.
// This starts as a compact baseline we can expand. It supports ~16k points @60fps.
export default function OrganicParticlesGL({ stageRef, headlineRef, chipRects, ctaRect, progress }: OrganicParticlesGLProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const buffersReadyRef = useRef(false);
  const poolRef = useRef(22000); // total particles (increased density)
  const actorRef = useRef(22000); // all particles participate in morph; no ambient cloud
  const cssSizeRef = useRef<{ w: number; h: number }>({ w: 1, h: 1 });
  const headCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastProgressRef = useRef(0);
  const lastActiveMsRef = useRef<number>(performance.now());

  // Compute target points for CTA rounded rect using a relaxed grid
  const ctaTargets = useMemo(() => {
    if (!ctaRect) return new Float32Array();
    const spacing = 5; // px
    const pts: number[] = [];
    for (let y = ctaRect.y + spacing / 2; y <= ctaRect.y + ctaRect.h - spacing / 2; y += spacing) {
      for (let x = ctaRect.x + spacing / 2; x <= ctaRect.x + ctaRect.w - spacing / 2; x += spacing) {
        if (insideRoundRect(x, y, ctaRect)) {
          // Add slight jitter so CTA target points are not in a strict grid
          const j = 2.2;
          const jx = x + rand(-j, j);
          const jy = y + rand(-j, j);
          if (insideRoundRect(jx, jy, ctaRect)) {
            pts.push(jx, jy);
          } else {
            pts.push(x, y);
          }
        }
      }
    }
    shuffleXY(pts);
    return new Float32Array(pts);
  }, [ctaRect]);

  // Build per-chip sampled target and start point sets (kept ordered for gating by group)
  const perChipSamples = useMemo(() => {
    const spacingTarget = 5;
    const spacingStart = 6;
    const targets: Float32Array[] = [];
    const starts: Float32Array[] = [];
    chipRects.forEach((c) => {
      const r = { x: c.rect.left, y: c.rect.top, w: c.rect.width, h: c.rect.height, r: Math.min(c.rect.height / 2, 18) };
      const cx = r.x + r.w * 0.5;
      const cy = r.y + r.h * 0.5;
      // Slightly shrink radii to emphasize roundness
      const rx = (r.w * 0.5) * 0.9;
      const ry = (r.h * 0.5) * 0.9;

      const tPts: number[] = [];
      for (let y = r.y + spacingTarget / 2; y <= r.y + r.h - spacingTarget / 2; y += spacingTarget) {
        for (let x = r.x + spacingTarget / 2; x <= r.x + r.w - spacingTarget / 2; x += spacingTarget) {
          // Prefer an elliptical cluster over rounded-rect for a softer shape
          const j = 2.4; // stronger jitter for looseness
          const jx = x + rand(-j, j);
          const jy = y + rand(-j, j);
          const dx = (jx - cx) / Math.max(1, rx);
          const dy = (jy - cy) / Math.max(1, ry);
          const inside = (dx * dx + dy * dy) <= 1.0;
          if (inside) {
            // Add subtle radial pull so edges round off further
            const r2 = Math.max(0.0001, dx * dx + dy * dy);
            const pull = 0.08 * (1.0 - r2);
            tPts.push(jx - dx * pull * rx, jy - dy * pull * ry);
          }
        }
      }
      shuffleXY(tPts);
      targets.push(new Float32Array(tPts));

      const sPts: number[] = [];
      for (let y = r.y + spacingStart / 2; y <= r.y + r.h - spacingStart / 2; y += spacingStart) {
        for (let x = r.x + spacingStart / 2; x <= r.x + r.w - spacingStart / 2; x += spacingStart) {
          const jx = x + rand(-1.2, 1.2);
          const jy = y + rand(-1.2, 1.2);
          const dx = (jx - cx) / Math.max(1, rx);
          const dy = (jy - cy) / Math.max(1, ry);
          if ((dx * dx + dy * dy) <= 1.0) {
            sPts.push(jx, jy);
          }
        }
      }
      starts.push(new Float32Array(sPts));
    });
    return { targets, starts };
  }, [chipRects]);

  // Init GL (rebuild when geometry/targets change, not on scroll)
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true });
    if (!gl) return;
    // using local gl; no external ref needed

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const { clientWidth, clientHeight } = stage;
      canvas.width = Math.max(1, Math.floor(clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(clientHeight * dpr));
      canvas.style.width = `${clientWidth}px`;
      canvas.style.height = `${clientHeight}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);
      cssSizeRef.current = { w: clientWidth, h: clientHeight };
    };
    const ro = new ResizeObserver(resize);
    ro.observe(stage);
    resize();

    const program = buildProgram(gl, VERT_SRC, FRAG_SRC);
    // Validate shader program
    const vsOk = gl.getShaderParameter((program as any)._vs ?? null, gl.COMPILE_STATUS);
    const fsOk = gl.getShaderParameter((program as any)._fs ?? null, gl.COMPILE_STATUS);
    const prOk = gl.getProgramParameter(program, gl.LINK_STATUS);
    if (!prOk) {
      // eslint-disable-next-line no-console
      console.error("WebGL program link error:", gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
      
    const aStart = gl.getAttribLocation(program, "aStart");
    const aTargetChip = gl.getAttribLocation(program, "aTargetChip");
    const aTargetCTA = gl.getAttribLocation(program, "aTargetCTA");
    const aTargetCloud = gl.getAttribLocation(program, "aTargetCloud");
    const aColor = gl.getAttribLocation(program, "aColor");
    const uTime = gl.getUniformLocation(program, "uT");
    const uResolution = gl.getUniformLocation(program, "uRes");
    const uSplit = gl.getUniformLocation(program, "uSplit");
    const uTick = gl.getUniformLocation(program, "uTick");
    const uNumChips = gl.getUniformLocation(program, "uNumChips");
    const uHeadCenter = gl.getUniformLocation(program, "uHeadCenter");
    // Chip burst uniforms (centers and radii)
    const uChipCenters = gl.getUniformLocation(program, "uChipCenters[0]");
    const uChipRadii = gl.getUniformLocation(program, "uChipRadii[0]");
    const uChipCount = gl.getUniformLocation(program, "uChipCount");
    // Grouped chip gating uniforms
    const uGStart = gl.getUniformLocation(program, "uGStart");
    const uGEnd = gl.getUniformLocation(program, "uGEnd");
    const uGCount = gl.getUniformLocation(program, "uGCount");
    const uLate = gl.getUniformLocation(program, "uLate");

    // Allocate buffers (will fill on each measure)
    const startBuf = gl.createBuffer();
    const targetChipBuf = gl.createBuffer();
    const targetCtaBuf = gl.createBuffer();
    const targetCloudBuf = gl.createBuffer();
    const colorBuf = gl.createBuffer();

    // Set static enable
    if (aStart !== -1) gl.enableVertexAttribArray(aStart);
    if (aTargetChip !== -1) gl.enableVertexAttribArray(aTargetChip);
    if (aTargetCTA !== -1) gl.enableVertexAttribArray(aTargetCTA);
    if (aTargetCloud !== -1) gl.enableVertexAttribArray(aTargetCloud);
    if (aColor !== -1) gl.enableVertexAttribArray(aColor);

    const dataKeyRef = { current: "" } as React.MutableRefObject<string>;

    const makeKey = () => `${ctaTargets.length}|${perChipSamples.targets.length}|${perChipSamples.starts.length}`;

    const fillBuffers = () => {
      // If targets not ready yet, skip filling so nothing ambient renders
      if (!ctaTargets.length || !perChipSamples.targets.length) {
        buffersReadyRef.current = false;
        dataKeyRef.current = makeKey();
        return;
      }
      const pool = poolRef.current;
      const actors = pool; // render all as actors
      const cloud = 0; // no ambient cloud instances
      // actors: assign evenly per chip in sequence for gating windows
      const numChips = Math.max(1, perChipSamples.targets.length);
      const actorsPerChip = Math.floor(actors / numChips);
      const actTargetsChip = new Float32Array(actors * 2);
      const actTargetsCTA = tileTo(actors, ctaTargets);
      const actStarts = new Float32Array(actors * 2);
      const actColors  = buildMixedColors(actors, 0.15); // 15% white, 85% dark
      let writeIdx = 0;
      for (let i = 0; i < numChips; i++) {
        const chipT = perChipSamples.targets[i];
        const chipS = perChipSamples.starts[i];
        for (let k = 0; k < actorsPerChip; k++) {
          const siT = (k % (chipT.length / 2)) * 2;
          const siS = (k % (chipS.length / 2)) * 2;
          actTargetsChip[writeIdx * 2] = chipT[siT];
          actTargetsChip[writeIdx * 2 + 1] = chipT[siT + 1];
          actStarts[writeIdx * 2] = chipS[siS];
          actStarts[writeIdx * 2 + 1] = chipS[siS + 1];
          writeIdx++;
        }
      }
      // If any remaining actors due to rounding, fill from last chip
      while (writeIdx < actors) {
        const lastIdx = perChipSamples.targets.length - 1;
        const chipT = perChipSamples.targets[lastIdx];
        const chipS = perChipSamples.starts[lastIdx];
        const siT = (writeIdx % (chipT.length / 2)) * 2;
        const siS = (writeIdx % (chipS.length / 2)) * 2;
        actTargetsChip[writeIdx * 2] = chipT[siT];
        actTargetsChip[writeIdx * 2 + 1] = chipT[siT + 1];
        actStarts[writeIdx * 2] = chipS[siS];
        actStarts[writeIdx * 2 + 1] = chipS[siS + 1];
        writeIdx++;
      }
      // cloud: still generate a scatter for actor explosion target paths, but render no cloud instances
      const stage = stageRef.current!;
      const stageBox = stage.getBoundingClientRect();
      const headBox = headlineRef.current?.getBoundingClientRect();
      // Measure headline every fill to keep alignment exact
      const cx = headBox ? (headBox.left - stageBox.left + headBox.width/2) : stage.clientWidth/2;
      const cy = headBox ? (headBox.top - stageBox.top + headBox.height/2)  : stage.clientHeight/2;
      headCenterRef.current = { x: cx, y: cy };
      // Build a dense scatter equal to actor count for pathing only
      const cloudPts: number[] = [];
      for(let i=0;i<actors;i++){
        const x = Math.random() * stage.clientWidth;
        const y = Math.random() * stage.clientHeight;
        cloudPts.push(x + rand(-1,1), y + rand(-1,1));
      }
      const cloudArr = new Float32Array(cloudPts);
      const cloudColsArr = new Float32Array(0);
      const cloudTargets = new Float32Array(0); // no ambient instances to render
      const actTargetsCloud = tileTo(actors, cloudArr);
      // stitch actors only (no ambient tail)
      const targetsChip = concatFloat32(actTargetsChip, cloudTargets);
      const targetsCTA  = concatFloat32(actTargetsCTA, cloudTargets);
      const targetsCloud = concatFloat32(actTargetsCloud, cloudTargets);
      const starts  = concatFloat32(actStarts, cloudTargets);
      const colors  = concatFloat32Colors(actColors, cloudColsArr);

      gl.bindBuffer(gl.ARRAY_BUFFER, startBuf);
      gl.bufferData(gl.ARRAY_BUFFER, starts, gl.STATIC_DRAW);
      gl.vertexAttribPointer(aStart, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, targetChipBuf);
      gl.bufferData(gl.ARRAY_BUFFER, targetsChip, gl.STATIC_DRAW);
      gl.vertexAttribPointer(aTargetChip, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, targetCtaBuf);
      gl.bufferData(gl.ARRAY_BUFFER, targetsCTA, gl.STATIC_DRAW);
      gl.vertexAttribPointer(aTargetCTA, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, targetCloudBuf);
      gl.bufferData(gl.ARRAY_BUFFER, targetsCloud, gl.STATIC_DRAW);
      gl.vertexAttribPointer(aTargetCloud, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
      gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
      gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);

      buffersReadyRef.current = true;
      dataKeyRef.current = makeKey();
    };

    // Defer fill one rAF to let layout settle
    requestAnimationFrame(() => fillBuffers());

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      // If geometry/targets changed (e.g., measurements settled), refill buffers
      const currentKey = `${ctaTargets.length}|${perChipSamples.targets.length}|${perChipSamples.starts.length}`;
      if (currentKey !== dataKeyRef.current) {
        fillBuffers();
      }
      if (!buffersReadyRef.current) return;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // Upload chip burst uniforms (limit to 16)
      const MAX_CHIPS = 16;
      const chipCount = Math.min(MAX_CHIPS, chipRects.length);
      const centersArr = new Float32Array(MAX_CHIPS * 2);
      const radiiArr = new Float32Array(MAX_CHIPS);
      for (let i = 0; i < chipCount; i++) {
        const r = chipRects[i].rect;
        // chipRects are already in stage coordinates
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        centersArr[i * 2] = cx;
        centersArr[i * 2 + 1] = cy;
        radiiArr[i] = Math.min(r.width, r.height) * 0.5;
      }
      if (uChipCount) gl.uniform1i(uChipCount, chipCount);
      if (uChipCenters) gl.uniform2fv(uChipCenters, centersArr);
      if (uChipRadii) gl.uniform1fv(uChipRadii, radiiArr);
      // Set grouped gating to align with UI chip fade windows: [0.00–0.14], [0.14–0.28], [0.28–0.42]
      if (uGStart) gl.uniform3f(uGStart, 0.00, 0.14, 0.28);
      if (uGEnd) gl.uniform3f(uGEnd, 0.14, 0.28, 0.42);
      // Dynamically match actual chip count to avoid mismatches when rects are not all measured
      const chipCountDyn = Math.max(0, chipRects.length);
      const g0 = Math.min(3, chipCountDyn);
      const g1 = Math.min(3, Math.max(0, chipCountDyn - g0));
      const g2 = Math.max(0, chipCountDyn - g0 - g1);
      if (uGCount) gl.uniform3f(uGCount, g0, g1, g2);
      if (uLate) gl.uniform1f(uLate, 0.6);
      gl.uniform1f(uTime, progress);
      gl.uniform1f(uSplit, actorRef.current);
      gl.uniform1f(uTick, performance.now()*0.001);
      gl.uniform1f(uNumChips, Math.max(1, perChipSamples.targets.length));
      gl.uniform2f(uHeadCenter, headCenterRef.current.x, headCenterRef.current.y);
      // Use CSS pixel size for coordinate mapping
      gl.uniform2f(uResolution, cssSizeRef.current.w, cssSizeRef.current.h);
      gl.drawArrays(gl.POINTS, 0, poolRef.current);

      // Dynamic opacity: hide until start, fade near CTA, and fade out when idle
      const pNow = progress;
      const startThresh = 0.002;
      const visibleAlpha = pNow < 0.95 ? 1 : Math.max(0, 1 - (pNow - 0.95) / 0.05);
      const baseAlpha = pNow > startThresh ? visibleAlpha : 0;
      const nowMs = performance.now();
      const delta = Math.abs(pNow - lastProgressRef.current);
      if (delta > 0.0005) {
        lastActiveMsRef.current = nowMs;
      }
      lastProgressRef.current = pNow;
      const idleMs = nowMs - lastActiveMsRef.current;
      const idleHoldMs = 150; // fully visible for a short time after scroll stops
      const idleFadeMs = 600; // then fade out
      let activityAlpha = 1;
      if (idleMs > idleHoldMs) {
        const t = Math.min(1, (idleMs - idleHoldMs) / idleFadeMs);
        activityAlpha = 1 - t;
      }
      const finalAlpha = Math.max(0, Math.min(1, baseAlpha * activityAlpha));
      if (canvas) canvas.style.opacity = String(finalAlpha);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (startBuf) gl.deleteBuffer(startBuf);
      if (targetChipBuf) gl.deleteBuffer(targetChipBuf);
      if (targetCtaBuf) gl.deleteBuffer(targetCtaBuf);
      if (targetCloudBuf) gl.deleteBuffer(targetCloudBuf);
      if (colorBuf) gl.deleteBuffer(colorBuf);
      if (program) gl.deleteProgram(program);
    };
  }, [stageRef, ctaTargets, perChipSamples, chipRects]);

  // Opacity is controlled in the render loop for idle fade; avoid double writers here
  return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" aria-hidden />;
}

// ========== Shaders ==========
const VERT_SRC = `#version 300 es
precision highp float;
in vec2 aStart;
in vec2 aTargetChip;
in vec2 aTargetCTA;
in vec2 aTargetCloud;
in vec3 aColor;
uniform float uT;
uniform vec2 uRes;
uniform float uSplit; // number of actor particles (rest are cloud)
uniform float uTick;  // time for cloud swirl
uniform float uNumChips; // number of chips for staggered gating
uniform vec2 uHeadCenter;
// Grouped gating: three windows and counts
uniform vec3 uGStart; // start times for groups 1..3
uniform vec3 uGEnd;   // end times for groups 1..3
uniform vec3 uGCount; // counts per group (e.g., 3,3,2)
uniform float uLate;  // late factor to delay per-chip coalescence inside window
// Transitionary bursts: up to 16 chip centers/radii
uniform int uChipCount;
uniform vec2 uChipCenters[16];
uniform float uChipRadii[16];
out vec4 vColor;

// Hash noise
float hash(float n){ return fract(sin(n)*43758.5453123); }
float n2(vec2 x){ return hash(dot(x, vec2(127.1,311.7))); }

void main(){
  // Decide if this instance is an actor (morphing) or cloud based on gl_VertexID
  bool isActor = float(gl_VertexID) < uSplit;

  // Timeline: 0-0.22 burst, 0.22-0.85 coalesce, 0.85-1 settle
  float t1 = clamp(uT/0.22,0.0,1.0);
  float t2 = clamp((uT-0.22)/0.63,0.0,1.0);

  vec2 pos;
  // Burst aura needs to be visible to post-branch sizing/color
  float burstAuraGlobal = 0.0;
  float seed = n2(aStart);
  if (isActor) {
    // Burst from start with mild noise
    float ang = seed*6.2831853;
    vec2 dir = vec2(cos(ang), sin(ang));
    float burst = pow(t1,2.0) * (80.0 + seed*60.0);
    vec2 burstPos = aStart + dir*burst + (seed-0.5)*10.0*t1;
    // Add short-lived radial burst around the chip center at explosion onset
    float burstAura = 0.0;
    float auraMax = 0.0;
    vec2 auraVec = vec2(0.0);
    for (int i=0;i<16;i++){
      if (i>=uChipCount) break;
      vec2 cc = uChipCenters[i];
      float r = uChipRadii[i];
      float d = length(aStart - cc);
      float within = step(d, r*1.2);
      float tExplode = clamp((uT - 0.68)/0.10, 0.0, 1.0);
      // Strong at explosion onset, then decay a bit more slowly for better readability
      float life = 1.0 - smoothstep(0.0, 0.80, tExplode);
      float strength = within * life;
      if (strength > auraMax) {
        auraMax = strength;
        vec2 dirC = normalize(aStart - cc + vec2(0.0001, 0.0001));
        auraVec = dirC * strength;
      }
      burstAura = max(burstAura, strength);
    }
    burstPos += auraVec * 82.0;
    burstAuraGlobal = burstAura;
    // Decide phase target (chip first, then CTA, with optional cloud explosion)
    vec2 tChip = aTargetChip;
    vec2 tCTA = aTargetCTA;
    vec2 tCloud = aTargetCloud;
    // Grouped per-chip gating aligned to UI windows
    float chips = max(1.0, uNumChips);
    float actorsPerChip = max(1.0, floor(uSplit / chips));
    float chipIndex = floor(float(gl_VertexID) / actorsPerChip);
    // Determine which group this chipIndex belongs to using uGCount
    float g0count = max(1.0, uGCount.x);
    float g1count = max(1.0, uGCount.y);
    float g2count = max(1.0, uGCount.z);
    float g0endIdx = g0count - 1.0;
    float g1endIdx = g0count + g1count - 1.0;
    // default to group2
    float gStart = uGStart.z;
    float gEnd = uGEnd.z;
    if (chipIndex <= g0endIdx) { gStart = uGStart.x; gEnd = uGEnd.x; }
    else if (chipIndex <= g1endIdx) { gStart = uGStart.y; gEnd = uGEnd.y; }
    // Before a chip group's window starts, bias the initial burst position toward the loose cloud
    // so non-active chip clusters look looser at the very beginning
    float pre = 1.0 - smoothstep(gStart, gStart + 0.06, uT);
    burstPos = mix(burstPos, aTargetCloud, pre * 0.85);
    // Local progress with per-chip staggering inside its group's window
    float groupIndex = chipIndex;
    if (chipIndex > g0endIdx) groupIndex = chipIndex - g0count; // normalize to group-local index
    if (chipIndex > g1endIdx) groupIndex = chipIndex - (g0count + g1count);
    float gCount = g2count; // default
    if (chipIndex <= g0endIdx) gCount = g0count; else if (chipIndex <= g1endIdx) gCount = g1count;
    gCount = max(1.0, gCount);
    float window = max(0.0001, (gEnd - gStart));
    float baseS = gStart + (groupIndex / gCount) * window;
    float baseE = gStart + ((groupIndex + 1.0) / gCount) * window;
    float s = mix(baseS, baseE, uLate);
    float eWin = min(gEnd, baseE + 0.04);
    float local = clamp((uT - s) / max(0.0001, (eWin - s)), 0.0, 1.0);
    float tChipPhase = smoothstep(0.0, 1.0, local);
    // Start CTA coalescence slightly before explosion fully finishes for a more natural handoff
    float tCTAphase  = clamp((uT - 0.70)/0.21, 0.0, 1.0); // 0.74→0.95
    // Explosion window
    float tExplode = clamp((uT - 0.68)/0.10, 0.0, 1.0); // 0.68→0.78

    // Critically damped spring toward staged targets (reserved for future tuning)
    float k = 2.0;
    // Idle drift to keep motion alive even when scroll stops
    float idleAmp = 0.015 * (1.0 - tExplode) * (1.0 - tCTAphase);
    float idle = idleAmp * sin(uTick*0.8 + chipIndex*1.37);
    float tChipPhaseIdle = clamp(tChipPhase + idle, 0.0, 1.0);
    // Outline-first bias for chip formation
    float edgeBias = smoothstep(0.0, 0.6, tChipPhase);
    // Add slight per-frame jitter so clusters look less grid-aligned
    // Chip jitter fades during explosion and CTA phases
    float chipJamp = 2.4 * (1.0 - tExplode) * (1.0 - tCTAphase); // slightly higher jitter for looseness
    vec2 jChip = vec2(sin(uTick*1.31 + seed*4.07), cos(uTick*1.53 + seed*3.71)) * chipJamp;
    vec2 tChipJ = tChip + jChip;
    // CTA jitter is smaller and damps as CTA settles
    float ctaJamp = 1.1 * (1.0 - tCTAphase);
    vec2 jCTA = vec2(sin(uTick*1.87 + seed*2.31), cos(uTick*2.11 + seed*5.13)) * ctaJamp;
    vec2 tCTAJ = tCTA + jCTA;

    vec2 tgtChip = mix(burstPos, tChipJ, tChipPhaseIdle);
    // During explosion, move from chip back toward cloud; diminish explosion as CTA phase grows
    float explodeFactor = tExplode * (1.0 - 0.6 * tCTAphase);
    vec2 chipToCloud = mix(tgtChip, tCloud, explodeFactor);
    // Then from exploded cloud to CTA formation
    vec2 tgt = mix(chipToCloud, tCTAJ, tCTAphase);
    pos = mix(burstPos, tgt, max(max(tChipPhaseIdle, tExplode), tCTAphase));
    pos += normalize(vec2(0.0001,0.0001) + (tgt - pos)) * (1.0-edgeBias) * 2.0;
  } else {
    // Background cloud gentle drift (avoid ring look): small radial breathing + slow swirl
    float a = uTick*0.15 + seed*6.2831853;
    float breathe = 1.0 + 0.06*sin(uTick*0.33 + seed*2.0);
    vec2 fromCenter = aStart; // start already sampled as disk around headline
    pos = fromCenter + vec2(cos(a), sin(a)) * 6.0 * breathe;
  }

  // NDC
  vec2 ndc = (pos / uRes) * 2.0 - 1.0;
  ndc.y *= -1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);

  // Size and alpha scale with proximity; boost size/color briefly during burst aura
  float d = length(aTargetCTA - pos);
  float alpha = clamp(1.0 - d/140.0, 0.85, 1.0);
  float aura = burstAuraGlobal;
  // During burst, points get smaller (sharper), then return to base size
  gl_PointSize = max(2.4, 5.0 - 3.5 * aura);
  // High-contrast burst color toward near-black for visibility
  vec3 burstColor = vec3(0.02, 0.02, 0.03);
  vec3 col = mix(aColor, burstColor, min(1.0, aura*1.2));
  vColor = vec4(col, alpha);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main(){
  vec2 p = gl_PointCoord*2.0-1.0;
  float r = dot(p,p);
  float mask = smoothstep(1.0, 0.6, r);
  outColor = vec4(vColor.rgb, vColor.a*mask);
}`;

// ========== Utils ==========
function buildProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string){
  const vs = gl.createShader(gl.VERTEX_SHADER)!; gl.shaderSource(vs, vertSrc); gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!; gl.shaderSource(fs, fragSrc); gl.compileShader(fs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    // eslint-disable-next-line no-console
    console.error('Vertex shader compile error:', gl.getShaderInfoLog(vs));
  }
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    // eslint-disable-next-line no-console
    console.error('Fragment shader compile error:', gl.getShaderInfoLog(fs));
  }
  const program = gl.createProgram()!; gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
  ;(program as any)._vs = vs; ;(program as any)._fs = fs;
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    // eslint-disable-next-line no-console
    console.error('Program link error:', gl.getProgramInfoLog(program));
  }
  return program;
}

function insideRoundRect(x:number, y:number, r:{x:number;y:number;w:number;h:number;r:number}){
  const rx = Math.max(r.x + r.r, Math.min(r.x + r.w - r.r, x));
  const ry = Math.max(r.y + r.r, Math.min(r.y + r.h - r.r, y));
  if (x>=r.x+r.r && x<=r.x+r.w-r.r && y>=r.y && y<=r.y+r.h) return true;
  if (y>=r.y+r.r && y<=r.y+r.h-r.r && x>=r.x && x<=r.x+r.w) return true;
  const cx = x < r.x + r.r ? r.x + r.r : x > r.x + r.w - r.r ? r.x + r.w - r.r : rx;
  const cy = y < r.y + r.r ? r.y + r.r : y > r.y + r.h - r.r ? r.y + r.h - r.r : ry;
  const dx = x - cx, dy = y - cy; return dx*dx + dy*dy <= r.r*r.r;
}

function shuffleXY(arr:number[]){
  for(let i=arr.length/2-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1));
    const ix=i*2, jx=j*2; const ax=arr[ix], ay=arr[ix+1]; arr[ix]=arr[jx]; arr[ix+1]=arr[jx+1]; arr[jx]=ax; arr[jx+1]=ay;
  }
}

function tileTo(pool:number, source:Float32Array){
  const out = new Float32Array(pool*2);
  for(let i=0;i<pool;i++){ const si=(i% (source.length/2))*2; out[i*2]=source[si]; out[i*2+1]=source[si+1]; }
  return out;
}
// Removed unused tileToColors
function buildMixedColors(pool:number, whiteRatio:number){
  const out = new Float32Array(pool*3);
  for(let i=0;i<pool;i++){
    const isWhite = Math.random() < whiteRatio;
    const c = isWhite ? [0.95,0.96,0.98] : [0.10,0.11,0.12];
    out[i*3]=c[0]; out[i*3+1]=c[1]; out[i*3+2]=c[2];
  }
  return out;
}
function concatFloat32(a:Float32Array,b:Float32Array){
  const out = new Float32Array(a.length + b.length);
  out.set(a,0); out.set(b,a.length); return out;
}
function concatFloat32Colors(a:Float32Array,b:Float32Array){
  const out = new Float32Array(a.length + b.length);
  out.set(a,0); out.set(b,a.length); return out;
}
function rand(a:number,b:number){ return Math.random()*(b-a)+a; }
// Removed unused hexToRgb
