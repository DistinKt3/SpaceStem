/**
 * Known Sky audio engine: fully procedural Web Audio. There are no audio files; every sound is synthesized here from
 * oscillators, generated noise buffers, filters and a convolver with a generated impulse response.
 *
 * Sound design (PRD Q9, "scored ambient music and honest silence"):
 * - The cabin always hums softly and the avionics make small instrument tones.
 * - Space is silent outside. The drive is heard only as vibration carried by the hull: low and low-passed.
 * - Wind exists only in an atmosphere and scales with outside density x airspeed (zero in vacuum).
 * - A generative ambient score (score.ts, deterministic from the seed) sits underneath: slow pad chords, soft bells,
 *   long reverb, a seamless loop.
 *
 * Usage: construct once, call unlock() from a user gesture (click/key), then update(dt, state) every frame and
 * play(cue) for events. Every cue and every significant change in the continuous sound calls onCaption(key, seconds)
 * with an i18n key from src/game/locales/en.audio.json, so captions can be shown for deaf and hard-of-hearing players.
 *
 * Robustness: without Web Audio, or before unlock(), every method is a safe no-op. Inputs are sanitized (NaN, out of
 * range), all level changes are ramps, and the output passes a compressor and a soft clipper that caps |sample| at
 * 0.95. dispose() stops and disconnects everything and closes the context it created.
 */
import { CUE_CAPTIONS, CaptionGate, STATE_CAPTIONS, StateCaptioner, type CaptionDef } from './captions';
import { playCue } from './cues';
import { MixGraph, type Volumes } from './graph';
import { CabinLayer, EngineLayer, HeatLayer, HyperLayer, RcsLayer, WindLayer, type Layer } from './layers';
import { DEFAULT_STATE, clamp01, finite, sanitizeState } from './mappings';
import { ScorePlayer } from './music';
import { NodeGroup, createKit, envelope, type Kit } from './nodes';
import { composeScore, instrumentBlips, type Blip, type Score } from './score';

export type AudioCue =
  | 'ui-hover'
  | 'ui-select'
  | 'ui-back'
  | 'target-lock'
  | 'mode-change'
  | 'hyperspeed-spool'
  | 'hyperspeed-engage'
  | 'hyperspeed-exit'
  | 'scoop-warning'
  | 'heat-critical'
  | 'landing-contact'
  | 'alert'
  | 'codex-unlock'
  | 'fuel-low';

export const AUDIO_CUES: readonly AudioCue[] = [
  'ui-hover',
  'ui-select',
  'ui-back',
  'target-lock',
  'mode-change',
  'hyperspeed-spool',
  'hyperspeed-engage',
  'hyperspeed-exit',
  'scoop-warning',
  'heat-critical',
  'landing-contact',
  'alert',
  'codex-unlock',
  'fuel-low',
];

export interface AudioState {
  /** 0..1 main engine. */
  thrust: number;
  /** 0..1 attitude jets. */
  rcs: number;
  mode: 'thrusters' | 'impulse' | 'cruise' | 'hyperspeed';
  /** 0..1 fraction of the current mode's top speed. */
  speedFraction: number;
  /** 0..1 spool (rising) / engaged (1). */
  hyperspeed: number;
  /** 0..1 outside air (1 = Earth sea level). */
  atmosphereDensity: number;
  /** m/s relative to the air. */
  airspeed: number;
  /** 0..1. */
  scoopHeat: number;
  landed: boolean;
}

export interface AudioEngineOptions {
  onCaption?: (key: string, durationS: number) => void;
  /** Seed for the generative score and all noise (default 1). */
  seed?: number;
  /**
   * Integration/test hook: supply the context, e.g. an OfflineAudioContext to render the exact same graph faster than
   * real time. Default: a new AudioContext created inside unlock().
   */
  createContext?: () => BaseAudioContext;
  /** Start the score this many seconds in (previews and tests of the loop seam). Default 0. */
  scoreOffset?: number;
}

export interface AudioStats {
  contextState: string;
  contextTime: number;
  /** Seconds since the score started, or null. */
  musicTime: number | null;
  loopSeconds: number;
  activeCues: number;
  activeLayers: number;
  lastError: string | null;
}

/** Concurrent one-shot cue limit (protects CPU when a UI fires many events). */
const MAX_ACTIVE_CUES = 12;
/** Minimum seconds between two starts of the same cue. */
const MIN_RETRIGGER_S: Partial<Record<AudioCue, number>> = { 'ui-hover': 0.045 };
const DEFAULT_RETRIGGER_S = 0.08;
/** unlock() resolves even if the browser keeps resume() pending (no user gesture). */
const RESUME_TIMEOUT_MS = 1500;
const BLIP_LOOKAHEAD_S = 1;
const PUMP_INTERVAL_MS = 200;

type WithWebkit = { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };

export class AudioEngine {
  /** The generative score for this engine's seed (pure data; see score.ts). */
  readonly score: Score;
  private readonly seed: number;
  private readonly onCaption: ((key: string, durationS: number) => void) | undefined;
  private readonly contextFactory: (() => BaseAudioContext) | undefined;
  private readonly scoreOffset: number;
  private ctx: BaseAudioContext | null = null;
  private ownsContext = false;
  private offline = false;
  private graph: MixGraph | null = null;
  private kit: Kit | null = null;
  private layers: Layer[] = [];
  private player: ScorePlayer | null = null;
  private state: AudioState = DEFAULT_STATE;
  private volumes: Volumes = { master: 0.85, music: 0.7, sfx: 0.85 };
  private muted = false;
  private disposed = false;
  private started = false;
  private readonly captioner = new StateCaptioner();
  private readonly gate = new CaptionGate();
  private cabinCaptioned = false;
  private musicCaptioned = false;
  private readonly lastCue = new Map<AudioCue, number>();
  private readonly liveCues = new Set<NodeGroup>();
  private readonly liveBlips = new Set<NodeGroup>();
  private blipOrigin = 0;
  private blipUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;

  constructor(opts: AudioEngineOptions = {}) {
    this.seed = Math.trunc(finite(opts.seed, 1)) >>> 0;
    this.onCaption = opts.onCaption;
    this.contextFactory = opts.createContext;
    this.scoreOffset = Math.max(0, finite(opts.scoreOffset, 0));
    this.score = composeScore(this.seed);
  }

  /** True once the context is running (or is an offline context) and the graph is built. */
  get unlocked(): boolean {
    if (this.disposed || !this.ctx || !this.graph) return false;
    return this.offline || this.ctx.state === 'running';
  }

  /**
   * Create (first call) and resume the AudioContext. Call from a user gesture. Never rejects; if Web Audio is missing
   * or the browser refuses, the engine stays a silent no-op and unlock() can be retried on the next gesture.
   */
  async unlock(): Promise<void> {
    if (this.disposed) return;
    try {
      // Synchronous part first: browsers allow starting a context only inside the gesture's task.
      if (!this.ctx) this.ctx = this.makeContext();
      const ctx = this.ctx;
      if (!ctx) return;
      if (!this.graph) this.build(ctx);
      if (!this.offline && ctx.state !== 'running') {
        const resume = (ctx as Partial<AudioContext>).resume;
        if (typeof resume === 'function') {
          await Promise.race([resume.call(ctx), new Promise<void>((r) => setTimeout(r, RESUME_TIMEOUT_MS))]);
        }
      }
      if (this.unlocked) this.goLive();
    } catch (e) {
      this.fail(e);
    }
  }

  setVolumes(v: { master: number; music: number; sfx: number }): void {
    if (this.disposed) return;
    const cur = this.volumes;
    this.volumes = {
      master: clamp01(finite(v?.master, cur.master)),
      music: clamp01(finite(v?.music, cur.music)),
      sfx: clamp01(finite(v?.sfx, cur.sfx)),
    };
    this.applyVolumes();
  }

  setMuted(m: boolean): void {
    if (this.disposed) return;
    this.muted = m;
    this.applyVolumes();
  }

  /** Per-frame state. Cheap: parameters are only rescheduled when they change noticeably. */
  update(dt: number, s: AudioState): void {
    if (this.disposed) return;
    this.state = sanitizeState(s);
    if (!this.unlocked || !this.started) return;
    try {
      const now = this.ctx!.currentTime;
      for (const l of this.layers) l.update(this.state, now);
      this.pump();
      const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0;
      for (const c of this.captioner.update(d, this.state)) this.caption(c, 'sfx');
    } catch (e) {
      this.fail(e);
    }
  }

  play(cue: AudioCue): void {
    if (this.disposed || !this.unlocked || !this.started) return;
    const caption = CUE_CAPTIONS[cue] as CaptionDef | undefined;
    if (!caption) return; // unknown cue from untyped callers
    try {
      const now = this.ctx!.currentTime;
      const last = this.lastCue.get(cue);
      if (last !== undefined && now - last < (MIN_RETRIGGER_S[cue] ?? DEFAULT_RETRIGGER_S)) return;
      if (this.liveCues.size >= MAX_ACTIVE_CUES || !this.sfxAudible()) return;
      this.lastCue.set(cue, now);
      const { group } = playCue(
        cue,
        { kit: this.kit!, dry: this.graph!.sfx, wet: this.graph!.sfxWet, tonic: this.score.tonic, steps: this.score.mode.steps },
        now + 0.01,
      );
      this.liveCues.add(group);
      group.onEnded(() => {
        group.disconnect();
        this.liveCues.delete(group);
      });
      this.caption(caption, 'sfx');
    } catch (e) {
      this.fail(e);
    }
  }

  /** Analyser on the final output (for visualizers); null before unlock. */
  analyser(): AnalyserNode | null {
    try {
      return this.graph?.analyser() ?? null;
    } catch {
      return null;
    }
  }

  stats(): AudioStats {
    return {
      contextState: this.ctx?.state ?? 'none',
      contextTime: this.ctx?.currentTime ?? 0,
      musicTime: this.ctx && this.player ? this.player.time(this.ctx.currentTime) : null,
      loopSeconds: this.score.loopSeconds,
      activeCues: this.liveCues.size,
      activeLayers: this.layers.filter((l) => l.active).length,
      lastError: this.lastError,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const ctx = this.ctx;
    const now = ctx?.currentTime ?? 0;
    try {
      for (const l of this.layers) l.dispose(now);
      this.player?.dispose(now);
      for (const g of [...this.liveCues, ...this.liveBlips]) g.kill(now);
      this.graph?.dispose();
    } catch {
      // Best effort: the context may already be closed.
    }
    this.layers = [];
    this.liveCues.clear();
    this.liveBlips.clear();
    this.player = null;
    this.graph = null;
    this.kit = null;
    if (ctx && this.ownsContext) {
      const close = (ctx as Partial<AudioContext>).close;
      if (typeof close === 'function') close.call(ctx).catch(() => undefined);
    }
    this.ctx = null;
  }

  // --- internals -------------------------------------------------------------------------------------------------

  private makeContext(): BaseAudioContext | null {
    if (this.contextFactory) {
      const c = this.contextFactory();
      this.offline = 'startRendering' in c;
      return c;
    }
    const g = globalThis as WithWebkit;
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    if (typeof Ctor !== 'function') return null;
    this.ownsContext = true;
    return new Ctor({ latencyHint: 'interactive' });
  }

  private build(ctx: BaseAudioContext): void {
    const kit = createKit(ctx, this.seed);
    const graph = new MixGraph(ctx, this.seed, this.volumes, this.muted);
    this.kit = kit;
    this.graph = graph;
    this.layers = [
      new CabinLayer(kit, graph.sfx),
      new EngineLayer(kit, graph.sfx),
      new RcsLayer(kit, graph.sfx),
      new WindLayer(kit, graph.sfx),
      new HeatLayer(kit, graph.sfx),
      new HyperLayer(kit, graph.sfx),
    ];
    this.player = new ScorePlayer(kit, graph.music, graph.musicWet, this.score);
  }

  /** First time the context is running: start the score, the cabin and the scheduler. */
  private goLive(): void {
    if (this.started || !this.ctx) return;
    this.started = true;
    const now = this.ctx.currentTime;
    this.player!.start(now + 0.25, this.scoreOffset);
    this.blipOrigin = now + 0.5;
    this.blipUntil = this.blipOrigin;
    if (!this.offline) this.timer = setInterval(() => this.pump(), PUMP_INTERVAL_MS);
    this.introCaptions();
    this.update(0, this.state);
  }

  private applyVolumes(): void {
    if (!this.graph || !this.ctx) return;
    try {
      this.graph.setVolumes(this.volumes, this.muted, this.ctx.currentTime);
      if (this.started) {
        this.pump();
        this.introCaptions();
      }
    } catch (e) {
      this.fail(e);
    }
  }

  private musicAudible(): boolean {
    return !this.muted && this.volumes.master > 0 && this.volumes.music > 0;
  }

  private sfxAudible(): boolean {
    return !this.muted && this.volumes.master > 0 && this.volumes.sfx > 0;
  }

  /** Schedule music and avionics ahead of the audio clock (called from update() and a timer). */
  private pump(): void {
    if (!this.unlocked || !this.started) return;
    try {
      const now = this.ctx!.currentTime;
      this.player!.pump(now, this.musicAudible());
      const horizon = now + BLIP_LOOKAHEAD_S;
      if (horizon > this.blipUntil) {
        const from = Math.max(this.blipUntil, now);
        if (this.sfxAudible())
          for (const b of instrumentBlips(this.seed, from - this.blipOrigin, horizon - this.blipOrigin)) this.blip(b, this.blipOrigin + b.at);
        this.blipUntil = horizon;
      }
    } catch (e) {
      this.fail(e);
    }
  }

  /** Avionics instrument tone: one or two very soft sine blips. */
  private blip(b: Blip, at: number): void {
    const kit = this.kit!;
    const g = new NodeGroup(kit.ctx);
    const out = g.gain(1);
    out.connect(g.pan(((b.hz % 7) / 7) * 0.8 - 0.4)).connect(this.graph!.sfx);
    out.connect(g.gain(0.25)).connect(this.graph!.sfxWet);
    let end = 0;
    for (let i = 0; i < b.count; i++) {
      const o = g.osc('sine', i === 0 ? b.hz : b.hz * 1.26);
      const env = g.gain(0);
      end = envelope(env.gain, at + i * 0.09, 0.003, 0.01, 0.07, 0.016 * b.vel);
      o.connect(env).connect(out);
    }
    g.start(at);
    g.stop(end + 0.05);
    this.liveBlips.add(g);
    g.onEnded(() => {
      g.disconnect();
      this.liveBlips.delete(g);
    });
  }

  private introCaptions(): void {
    if (!this.cabinCaptioned && this.sfxAudible()) {
      this.cabinCaptioned = true;
      this.caption(STATE_CAPTIONS.cabin, 'sfx');
    }
    if (!this.musicCaptioned && this.musicAudible() && this.player?.started) {
      this.musicCaptioned = true;
      this.caption(STATE_CAPTIONS.music, 'music');
    }
  }

  private caption(def: CaptionDef, bus: 'music' | 'sfx'): void {
    if (!this.onCaption) return;
    if (bus === 'music' ? !this.musicAudible() : !this.sfxAudible()) return;
    if (!this.gate.allow(def, this.ctx?.currentTime ?? 0)) return;
    try {
      this.onCaption(def.key, def.duration);
    } catch (e) {
      // A failing caption renderer must not break audio; surface the error asynchronously.
      queueMicrotask(() => {
        throw e;
      });
    }
  }

  private fail(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    if (this.lastError === null) console.warn('[audio]', msg);
    this.lastError = msg;
  }
}
