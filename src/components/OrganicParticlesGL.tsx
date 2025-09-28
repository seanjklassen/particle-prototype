"use client";

import React, { useEffect, useMemo, useRef } from "react";

type Vec2 = { x: number; y: number };

export type OrganicParticlesGLProps = {
  stageRef: React.RefObject<HTMLDivElement>;
  headlineRef: React.RefObject<HTMLElement>;
  chipRects: Array<{ id: string; rect: DOMRect; color: string }>; // measured in stage space
  ctaRect: { x: number; y: number; w: number; h: number; r: number } | null; // stage space
  progress: number; // 0..1 timeline
  quality?: "auto" | "low" | "high";
};

// Minimal, dependency-free WebGL2 instanced particle renderer.
// This starts as a compact baseline we can expand. It supports ~16k points @60fps.
export default function OrganicParticlesGL({ stageRef, headlineRef, chipRects, ctaRect, progress, quality = "auto" }: OrganicParticlesGLProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const buffersReadyRef = useRef(false);
  const poolRef = useRef(16000); // total particles
  const actorRef = useRef(6000); // portion that participates in morph
  const cssSizeRef = useRef<{ w: number; h: number }>({ w: 1, h: 1 });
  const headCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Compute target points for CTA rounded rect using a relaxed grid
  const ctaTargets = useMemo(() => {
    if (!ctaRect) return new Float32Array();
    const spacing = 5; // px
    const pts: number[] = [];
    for (let y = ctaRect.y + spacing / 2; y <= ctaRect.y + ctaRect.h - spacing / 2; y += spacing) {
      for (let x = ctaRect.x + spacing / 2; x <= ctaRect.x + ctaRect.w - spacing / 2; x += spacing) {
        if (insideRoundRect(x, y, ctaRect)) {
          pts.push(x, y);
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
      const tPts: number[] = [];
      for (let y = r.y + spacingTarget / 2; y <= r.y + r.h - spacingTarget / 2; y += spacingTarget) {
        for (let x = r.x + spacingTarget / 2; x <= r.x + r.w - spacingTarget / 2; x += spacingTarget) {
          if (insideRoundRect(x, y, r)) tPts.push(x, y);
        }
      }
      targets.push(new Float32Array(tPts));

      const sPts: number[] = [];
      for (let y = r.y + spacingStart / 2; y <= r.y + r.h - spacingStart / 2; y += spacingStart) {
        for (let x = r.x + spacingStart / 2; x <= r.x + r.w - spacingStart / 2; x += spacingStart) {
          sPts.push(x + rand(-1, 1), y + rand(-1, 1));
        }
      }
      starts.push(new Float32Array(sPts));
    });
    return { targets, starts };
  }, [chipRects]);

  // Init GL once
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true });
    if (!gl) return;
    glRef.current = gl;

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
      gl.useProgram(program);
      
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

    // Allocate buffers (will fill on each measure)
    const startBuf = gl.createBuffer();
    const targetChipBuf = gl.createBuffer();
    const targetCtaBuf = gl.createBuffer();
    const targetCloudBuf = gl.createBuffer();
    const colorBuf = gl.createBuffer();

    // Set static enable
    gl.enableVertexAttribArray(aStart);
    gl.enableVertexAttribArray(aTargetChip);
    gl.enableVertexAttribArray(aTargetCTA);
    gl.enableVertexAttribArray(aTargetCloud);
    gl.enableVertexAttribArray(aColor);

    const fillBuffers = () => {
      if (!ctaTargets.length || !perChipSamples.targets.length) return;
      const pool = poolRef.current;
      const actors = Math.min(actorRef.current, Math.max(1000, Math.floor(pool*0.4)));
      const cloud = pool - actors;
      // actors: assign evenly per chip in sequence for gating windows
      const numChips = Math.max(1, perChipSamples.targets.length);
      const actorsPerChip = Math.floor(actors / numChips);
      const actTargetsChip = new Float32Array(actors * 2);
      const actTargetsCTA = tileTo(actors, ctaTargets);
      const actStarts = new Float32Array(actors * 2);
      const actColors  = buildMixedColors(actors, 0.65); // 65% white, 35% dark
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
      // cloud: swirl around headline center (use CTA center as temporary anchor if headline not used)
      const stage = stageRef.current!;
      const stageBox = stage.getBoundingClientRect();
      const headBox = headlineRef.current?.getBoundingClientRect();
      // Measure headline every fill to keep alignment exact
      const cx = headBox ? (headBox.left - stageBox.left + headBox.width/2) : stage.clientWidth/2;
      const cy = headBox ? (headBox.top - stageBox.top + headBox.height/2)  : stage.clientHeight/2;
      headCenterRef.current = { x: cx, y: cy };
      const cloudPts: number[] = [];
      const cloudCols: number[] = [];
      const radius = Math.min(stage.clientWidth, stage.clientHeight) * 0.48; // larger cloud
      for(let i=0;i<cloud;i++){
        // Uniform disk (not a ring): r = R * sqrt(u)
        const u = Math.random();
        const rr = radius * Math.sqrt(u);
        const a = Math.random()*Math.PI*2.0;
        cloudPts.push(cx + Math.cos(a)*rr + rand(-1,1), cy + Math.sin(a)*rr + rand(-1,1));
        // mix of dark grey and white (mostly dark)
        const isWhite = Math.random() < 0.65;
        const c = isWhite ? [0.92,0.94,0.96] : [0.10,0.11,0.12];
        cloudCols.push(c[0], c[1], c[2]);
      }
      const cloudArr = new Float32Array(cloudPts);
      const cloudColsArr = new Float32Array(cloudCols);
      const cloudTargets = cloudArr; // cloud stays as cloud (animated in shader)
      const actTargetsCloud = tileTo(actors, cloudArr);
      // stitch actors first then cloud
      const targetsChip = concatFloat32(actTargetsChip, cloudTargets);
      const targetsCTA  = concatFloat32(actTargetsCTA, cloudTargets);
      const targetsCloud = concatFloat32(actTargetsCloud, cloudTargets);
      const starts  = concatFloat32(actStarts, cloudArr);
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
    };

    fillBuffers();

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      if (!buffersReadyRef.current) return;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uTime, progress);
      gl.uniform1f(uSplit, actorRef.current);
      gl.uniform1f(uTick, performance.now()*0.001);
      gl.uniform1f(uNumChips, Math.max(1, chipRects.length));
      gl.uniform2f(uHeadCenter, headCenterRef.current.x, headCenterRef.current.y);
      // Use CSS pixel size for coordinate mapping
      gl.uniform2f(uResolution, cssSizeRef.current.w, cssSizeRef.current.h);
      gl.drawArrays(gl.POINTS, 0, poolRef.current);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.deleteBuffer(startBuf!);
        gl.deleteBuffer(targetChipBuf!);
        gl.deleteBuffer(targetCtaBuf!);
      gl.deleteBuffer(targetCloudBuf!);
      gl.deleteBuffer(colorBuf!);
      gl.deleteProgram(program!);
    };
  }, [stageRef, ctaTargets, perChipSamples, chipRects, progress]);

  // Fade out GL layer as CTA appears
  const style: React.CSSProperties = useMemo(() => {
    const p = progress;
    const alpha = p < 0.95 ? 1 : Math.max(0, 1 - (p - 0.95) / 0.05);
    return { opacity: alpha, transition: 'opacity 120ms linear' };
  }, [progress]);

  return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" style={style} />;
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
  float seed = n2(aStart);
  if (isActor) {
    // Burst from start with mild noise
    float ang = seed*6.2831853;
    vec2 dir = vec2(cos(ang), sin(ang));
    float burst = pow(t1,2.0) * (80.0 + seed*60.0);
    vec2 burstPos = aStart + dir*burst + (seed-0.5)*10.0*t1;
    // Decide phase target (chip first, then CTA, with optional cloud explosion)
    vec2 tChip = aTargetChip;
    vec2 tCTA = aTargetCTA;
    vec2 tCloud = aTargetCloud;
    // Staggered per-chip gating across timeline 0.12→0.72
    float chips = max(1.0, uNumChips);
    float chipStart = 0.12;
    float chipEnd = 0.72;
    float chipSpan = max(0.001, chipEnd - chipStart);
    float phase = clamp((uT - chipStart) / chipSpan, 0.0, 1.0);
    float activeFloat = floor(phase * chips - 0.001);
    float actorsPerChip = max(1.0, floor(uSplit / chips));
    float group = floor(float(gl_VertexID) / actorsPerChip);
    float prior = step(group, activeFloat - 0.5);
    float isCurrent = step(abs(group - (activeFloat + 0.0)), 0.5);
    float localT = clamp(fract(phase * chips), 0.0, 1.0);
    float tChipPhase = clamp(prior + isCurrent * smoothstep(0.0, 1.0, localT), 0.0, 1.0);
    float tCTAphase  = clamp((uT - 0.78)/0.17, 0.0, 1.0); // 0.78→0.95
    // Pre-CTA explosion window: send chips back to cloud together
    float tExplode = clamp((uT - 0.68)/0.10, 0.0, 1.0); // 0.68→0.78

    // Critically damped spring toward staged targets
    float k = 2.0;
    float e = exp(-k*(1.0 - (1.0 - t2)*(1.0 - t2)));
    // Outline-first bias for chip formation
    float edgeBias = smoothstep(0.0, 0.6, tChipPhase);
    vec2 tgtChip = mix(burstPos, tChip, tChipPhase);
    // During explosion, move from chip back toward cloud
    vec2 chipToCloud = mix(tgtChip, tCloud, tExplode);
    // Then from exploded cloud to CTA formation
    vec2 tgt = mix(chipToCloud, tCTA, tCTAphase);
    pos = mix(burstPos, tgt, max(max(tChipPhase, tExplode), tCTAphase));
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

  // Size and alpha scale with proximity
  float d = length(aTargetCTA - pos);
  float alpha = clamp(1.0 - d/120.0, 0.25, 1.0);
  gl_PointSize = 3.8; // larger particles
  vColor = vec4(aColor, alpha);
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
  const program = gl.createProgram()!; gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
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
function tileToColors(pool:number, source:Float32Array){
  const out = new Float32Array(pool*3);
  for(let i=0;i<pool;i++){ const si=(i% (source.length/3))*3; out[i*3]=source[si]; out[i*3+1]=source[si+1]; out[i*3+2]=source[si+2]; }
  return out;
}
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
function hexToRgb(hex:string){
  const h = hex.replace('#','');
  const num = parseInt(h.length===3 ? h.split("").map(ch=>ch+ch).join("") : h, 16);
  return [(num>>16)&255,(num>>8)&255,num&255];
}
