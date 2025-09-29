// Tiny WebAudio "bleep" synth for hover tones
// Creates a singleton AudioContext and exposes a simple play function

let audioContextSingleton: (AudioContext & { resume: () => Promise<void> }) | null = null;

function getAudioContext(): (AudioContext & { resume: () => Promise<void> }) | null {
  if (typeof window === "undefined") return null;
  if (audioContextSingleton) return audioContextSingleton;
  const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  audioContextSingleton = new AC();
  return audioContextSingleton;
}

export async function resumeAudio(): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state !== "running") {
    try {
      await ctx.resume();
    } catch {}
  }
}

export type BleepOptions = {
  frequency: number;
  durationMs?: number; // total bleep time excluding release
  volume?: number; // 0..1 (keep tiny)
  type?: OscillatorType; // default: square for 8-bit vibe
};

export function playBleep({
  frequency,
  durationMs = 120,
  volume = 0.035,
  type = "square",
}: BleepOptions): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;

  const oscillator = ctx.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(2400, now);
  filter.Q.setValueAtTime(0.0001, now);

  const gain = ctx.createGain();

  // Quick clickless envelope
  const attack = 0.005; // s
  const decay = 0.06; // s
  const sustainLevel = Math.max(1e-4, volume * 0.28);
  const release = 0.06; // s
  const dur = Math.max(0.04, durationMs / 1000);

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(volume, now + attack);
  gain.gain.exponentialRampToValueAtTime(sustainLevel, now + attack + decay);
  gain.gain.setValueAtTime(sustainLevel, now + dur);
  gain.gain.exponentialRampToValueAtTime(1e-4, now + dur + release);

  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  oscillator.start(now);
  oscillator.stop(now + dur + release + 0.02);

  oscillator.onended = () => {
    try {
      oscillator.disconnect();
      filter.disconnect();
      gain.disconnect();
    } catch {}
  };
}


export function playBleepAt(
  frequency: number,
  timeOffsetMs: number,
  opts?: Omit<BleepOptions, "frequency">
): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const when = ctx.currentTime + Math.max(0, timeOffsetMs) / 1000;

  const type = opts?.type ?? "square";
  const volume = opts?.volume ?? 0.03;
  const durationMs = opts?.durationMs ?? 100;

  const oscillator = ctx.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, when);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(2400, when);

  const gain = ctx.createGain();
  const attack = 0.005;
  const decay = 0.05;
  const sustainLevel = Math.max(1e-4, volume * 0.28);
  const release = 0.05;
  const dur = Math.max(0.04, durationMs / 1000);

  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(volume, when + attack);
  gain.gain.exponentialRampToValueAtTime(sustainLevel, when + attack + decay);
  gain.gain.setValueAtTime(sustainLevel, when + dur);
  gain.gain.exponentialRampToValueAtTime(1e-4, when + dur + release);

  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  oscillator.start(when);
  oscillator.stop(when + dur + release + 0.02);
  oscillator.onended = () => {
    try {
      oscillator.disconnect();
      filter.disconnect();
      gain.disconnect();
    } catch {}
  };
}

export function playGlide(
  startFrequency: number,
  endFrequency: number,
  durationMs: number,
  delayMs = 0,
  volume = 0.025,
  type: OscillatorType = "square"
): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const when = ctx.currentTime + Math.max(0, delayMs) / 1000;
  const dur = Math.max(0.04, durationMs / 1000);

  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(startFrequency, when);
  osc.frequency.linearRampToValueAtTime(endFrequency, when + dur * 0.85);

  const gain = ctx.createGain();
  const attack = 0.006;
  const release = 0.08;
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(volume, when + attack);
  gain.gain.exponentialRampToValueAtTime(1e-4, when + dur + release);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(when);
  osc.stop(when + dur + release + 0.02);
  osc.onended = () => {
    try { osc.disconnect(); gain.disconnect(); } catch {}
  };
}

export function playChordStaggered(
  frequencies: number[],
  betweenDelayMs = 16,
  startDelayMs = 0,
  durationMs = 100,
  volume = 0.028
): void {
  for (let i = 0; i < frequencies.length; i++) {
    playBleepAt(frequencies[i], startDelayMs + i * betweenDelayMs, {
      durationMs,
      volume,
      type: "square",
    });
  }
}


