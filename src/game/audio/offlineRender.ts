/**
 * Faster-than-real-time rendering of the real engine graph with an OfflineAudioContext, for automated checks (we
 * cannot listen in CI). A scenario is a timeline of state changes, cues and mix changes; the render suspends the
 * offline context at every update tick and calls engine.update() exactly as the game would each frame.
 * Browser only (OfflineAudioContext).
 */
import { AudioEngine, type AudioCue, type AudioState, type AudioStats } from './audioEngine';
import { clickScore, countNonFinite, fractionAbove, mixDown, peak, rms, spectralCentroid, subtract, bandEnergyFraction } from './analysis';
import { DEFAULT_STATE, sanitizeState } from './mappings';
import type { Volumes } from './graph';

export interface ScenarioStep {
  /** Seconds from the start of the render. */
  at: number;
  state?: Partial<AudioState>;
  cue?: AudioCue;
  muted?: boolean;
  volumes?: Partial<Volumes>;
  /** Call engine.dispose() at this time. */
  dispose?: boolean;
}

export interface Scenario {
  seconds: number;
  seed?: number;
  sampleRate?: number;
  volumes?: Partial<Volumes>;
  muted?: boolean;
  state?: Partial<AudioState>;
  steps?: ScenarioStep[];
  /** engine.update() calls per second (default 30). */
  updateHz?: number;
  /** Start the score this many seconds in. */
  scoreOffset?: number;
}

export interface CaptionEvent {
  key: string;
  duration: number;
  at: number;
}

export interface Rendered {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  captions: CaptionEvent[];
  stats: AudioStats;
}

export const DEFAULT_VOLUMES: Volumes = { master: 0.85, music: 0.7, sfx: 0.85 };

export async function renderScenario(sc: Scenario): Promise<Rendered> {
  const sampleRate = sc.sampleRate ?? 48_000;
  const length = Math.max(128, Math.ceil(sampleRate * sc.seconds));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const captions: CaptionEvent[] = [];
  const engine = new AudioEngine({
    seed: sc.seed ?? 1,
    scoreOffset: sc.scoreOffset ?? 0,
    createContext: () => ctx,
    onCaption: (key, duration) => captions.push({ key, duration, at: ctx.currentTime }),
  });
  let volumes: Volumes = { ...DEFAULT_VOLUMES, ...sc.volumes };
  engine.setVolumes(volumes);
  engine.setMuted(sc.muted ?? false);
  let state: AudioState = sanitizeState({ ...DEFAULT_STATE, ...sc.state });
  engine.update(0, state);
  await engine.unlock();

  const quantum = 128 / sampleRate;
  const q = (t: number): number => Math.round(t / quantum) * quantum;
  const steps = [...(sc.steps ?? [])].map((s) => ({ ...s, at: q(Math.max(0, s.at)) })).sort((a, b) => a.at - b.at);
  let next = 0;
  let last = 0;
  const tick = (t: number): void => {
    while (next < steps.length && steps[next]!.at <= t + 1e-9) {
      const s = steps[next++]!;
      if (s.state) state = sanitizeState({ ...state, ...s.state });
      if (s.volumes) {
        volumes = { ...volumes, ...s.volumes };
        engine.setVolumes(volumes);
      }
      if (s.muted !== undefined) engine.setMuted(s.muted);
      if (s.dispose) engine.dispose();
      if (s.cue) engine.play(s.cue);
    }
    engine.update(t - last, state);
    last = t;
  };
  tick(0);

  const hz = sc.updateHz ?? 30;
  const times = new Set<number>();
  for (let t = 1 / hz; t < sc.seconds; t += 1 / hz) times.add(q(t));
  for (const s of steps) times.add(s.at);
  const end = (length - 128) / sampleRate;
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t <= 0 || t >= end) continue;
    void ctx.suspend(t).then(() => {
      tick(t);
      void ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  const stats = engine.stats();
  engine.dispose();
  return { left: buf.getChannelData(0), right: buf.getChannelData(1), sampleRate, captions, stats };
}

export interface Measurement {
  seconds: number;
  rms: number;
  peak: number;
  nonFinite: number;
  /** Fraction of samples in the limiter's shoulder (|x| > 0.6); near zero for a well-staged mix. */
  shoulder: number;
  click: number;
  centroidHz: number;
  /** Energy fraction above 2 kHz. */
  hfFraction: number;
  /** RMS of consecutive 0.5 s windows (detects gaps and dropouts). */
  windowRms: number[];
  captions: CaptionEvent[];
  lastError: string | null;
  /** Present with a baseline: the same measurements on (render - baseline), i.e. what the change added. */
  diff?: { rms: number; peak: number; centroidHz: number; hfFraction: number; rmsEarly: number; rmsLate: number; rmsTail: number };
}

/**
 * Render a scenario and measure it. With a baseline scenario (same seed, without the thing under test), the
 * difference signal isolates the contribution of a cue or layer: rendering is deterministic, so everything else
 * cancels exactly.
 */
export async function measureScenario(sc: Scenario, baseline?: Scenario): Promise<Measurement> {
  const r = await renderScenario(sc);
  const m = mixDown(r.left, r.right);
  const both = [r.left, r.right];
  const out: Measurement = {
    seconds: sc.seconds,
    rms: rms(m),
    peak: Math.max(peak(r.left), peak(r.right)),
    nonFinite: both.reduce((n, ch) => n + countNonFinite(ch), 0),
    shoulder: Math.max(fractionAbove(r.left, 0.6), fractionAbove(r.right, 0.6)),
    click: Math.max(clickScore(r.left), clickScore(r.right)),
    centroidHz: spectralCentroid(m, r.sampleRate),
    hfFraction: bandEnergyFraction(m, r.sampleRate, 2000, r.sampleRate / 2),
    windowRms: [],
    captions: r.captions,
    lastError: r.stats.lastError,
  };
  const win = Math.floor(r.sampleRate * 0.5);
  for (let i = 0; i + win <= m.length; i += win) out.windowRms.push(rms(m, i, i + win));
  if (baseline) {
    const b = await renderScenario(baseline);
    const d = subtract(m, mixDown(b.left, b.right));
    const half = Math.floor(d.length / 2);
    out.diff = {
      rms: rms(d),
      peak: peak(d),
      centroidHz: spectralCentroid(d, r.sampleRate),
      hfFraction: bandEnergyFraction(d, r.sampleRate, 2000, r.sampleRate / 2),
      rmsEarly: rms(d, 0, half),
      rmsLate: rms(d, half, d.length),
      rmsTail: rms(d, d.length - Math.floor(r.sampleRate * 0.5), d.length),
    };
  }
  return out;
}
