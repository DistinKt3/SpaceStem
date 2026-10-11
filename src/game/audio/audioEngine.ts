/**
 * Known Sky audio engine: fully procedural Web Audio. There are no audio files; every sound is synthesized here from
 * oscillators, generated noise buffers, filters and a convolver with a generated impulse response.
 *
 * Sound design (PRD Q9, "scored ambient music and honest silence"):
 * - The cabin always hums softly and the avionics make small instrument tones.
 * - Space is silent outside. The drive is heard only as vibration carried by the hull: low and low-passed (with a
 *   quieter band at 150-600 Hz, so laptop and phone speakers still carry it).
 * - Wind exists only in an atmosphere and scales with outside density x airspeed (zero in vacuum).
 * - A generative ambient score (score.ts, deterministic from the seed) sits underneath: slow pad chords, soft bells,
 *   long reverb, a seamless loop. Tonal ship sounds (hum, blips, drone, musical cues) are tuned to its key.
 *
 * Integration contract:
 * - Construct once. Call unlock() from a user gesture (click/key); it is safe to call on every gesture until
 *   `unlocked` is true. Then call update(dt, state) every frame and play(cue) for events.
 * - Hyperspeed: drive state.hyperspeed from 0 to 1 over the spool. The state layer makes the rising spool tone and,
 *   at 1 in mode 'hyperspeed', the engaged drone. Call play('hyperspeed-spool') once as the spool starts: it is a
 *   short arming transient with no stable pitch, so it never beats against the layer's tone. Call
 *   play('hyperspeed-engage') when the drive engages and play('hyperspeed-exit') when it drops out.
 * - Captions describe the game's sound, not the speakers. Every cue and every significant state change calls
 *   onCaption(i18nKey, seconds) whether or not audio is unlocked, muted or at zero volume, and even without Web Audio,
 *   so deaf and hard-of-hearing players who turn the sound off still get them. Identical captions are dropped while
 *   one is on screen. The cabin and '[Ambient music]' captions come once, when the soundscape starts. Pass
 *   captionsWhenSilent: false to caption only what is audible.
 *
 * Robustness: without Web Audio, or before unlock(), sound is a safe no-op. unlock() starts the context synchronously
 * inside the gesture and generates the noise loops and reverb in slices of a few milliseconds afterwards, so the first
 * click never stalls the page. Inputs are sanitized (NaN, out of range), all level changes are ramps, and the output
 * passes a compressor and a soft clipper that caps |sample| at 0.95. When muted (or at zero volume) the layers tear
 * down and a context this engine owns is suspended, so silence costs no audio CPU. Warnings always get a voice. dispose()
 * stops and disconnects everything and closes the context it created.
 */
import { CUE_CAPTIONS, CaptionGate, STATE_CAPTIONS, StateCaptioner, type CaptionDef } from './captions';
import { CUE_PRIORITY, fadeOutCue, playCue, voiceToSteal } from './cues';
import { runSync, type Work } from './dsp';
import { MixGraph, assetsWork, type AudioAssets, type Volumes } from './graph';
import { CabinLayer, EngineLayer, HeatLayer, HyperLayer, RcsLayer, WindLayer, type Layer } from './layers';
import { DEFAULT_STATE, clamp01, finite, sanitizeDt, sanitizeState } from './mappings';
import { ScorePlayer } from './music';
import { NodeGroup, envelope, type Kit } from './nodes';
import { composeScore, instrumentBlips, type Blip, type Score } from './score';
import { blipFrequencies, droneFrequency, humFrequency, type MusicalKey } from './tuning';

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
   * Caption even what cannot be heard (muted, zero volume, before unlock, no Web Audio). Default true: captions
   * describe the game's sound for players who cannot hear it. False captions only audible sound.
   */
  captionsWhenSilent?: boolean;
  /**
   * Integration/test hook: supply the context, e.g. an OfflineAudioContext to render the exact same graph faster than
   * real time. Default: a new AudioContext created inside unlock().
   */
  createContext?: () => BaseAudioContext;
  /** Monotonic clock in seconds for caption timing (default performance.now; offline renders pass the audio clock). */
  clock?: () => number;
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
  /** True while the engine has suspended its own context because nothing is audible (muted or zero volume). */
  suspended: boolean;
  lastError: string | null;
}

/** Concurrent one-shot cue limit (protects CPU when a UI fires many events). */
const MAX_ACTIVE_CUES = 12;
/** Minimum seconds between two starts of the same cue's sound (its caption is deduplicated separately). */
const MIN_RETRIGGER_S: Partial<Record<AudioCue, number>> = { 'ui-hover': 0.045 };
const DEFAULT_RETRIGGER_S = 0.08;
/** unlock() resolves even if the browser keeps resume() pending (no user gesture). */
const RESUME_TIMEOUT_MS = 1500;
const BLIP_LOOKAHEAD_S = 1;
const PUMP_INTERVAL_MS = 200;
/** Main-thread budget per slice of procedural generation during unlock(). */
const SLICE_MS = 4;
/** After the output fades to silence (mute or zero volume), suspend an owned context this much later. */
const SUSPEND_AFTER_MS = 450;

type WithWebkit = { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };

interface Voice {
  readonly priority: number;
  readonly bus: GainNode;
}

const wallClock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

/** Resolve on the next browser task (MessageChannel avoids setTimeout's nested-timer clamping). */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'function') {
      const ch = new MessageChannel();
      ch.port1.onmessage = (): void => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(null);
    } else setTimeout(resolve, 0);
  });
}

/** Run resumable work in slices of about SLICE_MS, yielding to the browser in between. Null if cancelled. */
async function runSliced<T>(work: Work<T>, cancelled: () => boolean): Promise<T | null> {
  for (;;) {
    const t0 = wallClock();
    for (;;) {
      const r = work.next();
      if (r.done) return r.value;
      if ((wallClock() - t0) * 1000 >= SLICE_MS) break;
    }
    await nextTask();
    if (cancelled()) return null;
  }
}

export class AudioEngine {
  /** The generative score for this engine's seed (pure data; see score.ts). */
  readonly score: Score;
  private readonly seed: number;
  private readonly onCaption: ((key: string, durationS: number) => void) | undefined;
  private readonly contextFactory: (() => BaseAudioContext) | undefined;
  private readonly clock: () => number;
  private readonly captionsWhenSilent: boolean;
  private readonly scoreOffset: number;
  private readonly key: MusicalKey;
  private readonly blipTones: readonly number[];
  private ctx: BaseAudioContext | null = null;
  private ownsContext = false;
  private offline = false;
  private building: Promise<void> | null = null;
  private graph: MixGraph | null = null;
  private kit: Kit | null = null;
  private layers: Layer[] = [];
  private player: ScorePlayer | null = null;
  private state: AudioState = DEFAULT_STATE;
  private volumes: Volumes = { master: 0.85, music: 0.7, sfx: 0.85 };
  private muted = false;
  private disposed = false;
  private started = false;
  private selfSuspended = false;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly captioner = new StateCaptioner();
  private readonly gate = new CaptionGate();
  private cabinCaptioned = false;
  private musicCaptioned = false;
  private readonly lastCue = new Map<AudioCue, number>();
  /** Playing cue voices, oldest first. */
  private readonly voices = new Map<NodeGroup, Voice>();
  private readonly liveBlips = new Set<NodeGroup>();
  private blipOrigin = 0;
  private blipUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;

  constructor(opts: AudioEngineOptions = {}) {
    this.seed = Math.trunc(finite(opts.seed, 1)) >>> 0;
    this.onCaption = opts.onCaption;
    this.contextFactory = opts.createContext;
    this.clock = opts.clock ?? wallClock;
    this.captionsWhenSilent = opts.captionsWhenSilent !== false;
    this.scoreOffset = Math.max(0, finite(opts.scoreOffset, 0));
    this.score = composeScore(this.seed);
    this.key = { tonic: this.score.tonic, steps: this.score.mode.steps };
    this.blipTones = blipFrequencies(this.key);
  }

  /** True once the context runs (or is an offline context) and the graph is built. Stays true while self-suspended. */
  get unlocked(): boolean {
    if (this.disposed || !this.ctx || !this.graph) return false;
    return this.offline || this.selfSuspended || this.ctx.state === 'running';
  }

  /**
   * Create (first call) and resume the AudioContext. Call from a user gesture. Never rejects; if Web Audio is missing
   * or the browser refuses, the engine stays silent (captions still work) and unlock() can be retried on the next
   * gesture.
   */
  async unlock(): Promise<void> {
    if (this.disposed) return;
    try {
      // Synchronous part first, still inside the gesture: browsers start a context only from the gesture's task.
      if (!this.ctx) this.ctx = this.makeContext();
      const ctx = this.ctx;
      if (!ctx) return;
      const resumed = this.requestResume(ctx);
      // Then the procedural generation, sliced so the page stays responsive.
      if (!this.graph) {
        this.building ??= this.buildAssets(ctx).finally(() => {
          this.building = null;
        });
        await this.building;
      }
      if (this.disposed || !this.graph) return;
      if (!this.offline && !this.selfSuspended && ctx.state !== 'running') {
        await Promise.race([resumed, new Promise<void>((r) => setTimeout(r, RESUME_TIMEOUT_MS))]);
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
    try {
      // Captions follow the ship, not the speakers: they run muted, before unlock() and without Web Audio.
      for (const c of this.captioner.update(sanitizeDt(dt), this.state)) this.caption(c, 'sfx');
      if (!this.running()) return;
      const now = this.ctx!.currentTime;
      const audible = this.sfxAudible();
      for (const l of this.layers) l.update(this.state, now, audible);
      this.pump();
    } catch (e) {
      this.fail(e);
    }
  }

  play(cue: AudioCue): void {
    if (this.disposed) return;
    const caption = CUE_CAPTIONS[cue] as CaptionDef | undefined;
    if (!caption) return; // unknown cue from untyped callers
    // Caption first: a warning is captioned even when it cannot be heard or its sound is dropped.
    this.caption(caption, 'sfx');
    if (!this.running() || !this.sfxAudible()) return;
    try {
      const now = this.ctx!.currentTime;
      const last = this.lastCue.get(cue);
      if (last !== undefined && now - last < (MIN_RETRIGGER_S[cue] ?? DEFAULT_RETRIGGER_S)) return;
      const priority = CUE_PRIORITY[cue];
      if (this.voices.size >= MAX_ACTIVE_CUES) {
        const victim = voiceToSteal([...this.voices].map(([g, v]) => [g, v.priority] as const), priority);
        const v = victim ? this.voices.get(victim) : undefined;
        if (!victim || !v) return;
        this.voices.delete(victim);
        fadeOutCue(victim, v.bus, now);
      }
      this.lastCue.set(cue, now);
      const { group, bus } = playCue(cue, { kit: this.kit!, dry: this.graph!.sfx, wet: this.graph!.sfxWet, ...this.key }, now + 0.01);
      this.voices.set(group, { priority, bus });
      group.onEnded(() => {
        group.disconnect();
        this.voices.delete(group);
      });
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
      activeCues: this.voices.size,
      activeLayers: this.layers.filter((l) => l.active).length,
      suspended: this.selfSuspended,
      lastError: this.lastError,
    };
  }

  /**
   * Stop everything, disconnect every node and close the context this engine created. With a live context the output
   * first fades over ~40 ms so the stop does not click. Every method is a no-op afterwards.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    const ctx = this.ctx;
    const graph = this.graph;
    const layers = this.layers;
    const player = this.player;
    const groups = [...this.voices.keys(), ...this.liveBlips];
    const owns = this.ownsContext;
    this.layers = [];
    this.voices.clear();
    this.liveBlips.clear();
    this.player = null;
    this.graph = null;
    this.kit = null;
    this.ctx = null;
    const teardown = (): void => {
      try {
        const now = ctx?.currentTime ?? 0;
        ctx?.removeEventListener('statechange', this.onStateChange);
        for (const l of layers) l.dispose(now);
        player?.dispose(now);
        for (const g of groups) g.kill(now);
        graph?.dispose();
      } catch {
        // Best effort: the context may already be closed.
      }
      if (ctx && owns) {
        const close = (ctx as Partial<AudioContext>).close;
        if (typeof close === 'function') close.call(ctx).catch(() => undefined);
      }
    };
    if (ctx && graph && !this.offline && ctx.state === 'running') {
      try {
        graph.fadeOut(ctx.currentTime);
      } catch {
        // Ignore: tear down immediately below.
      }
      setTimeout(teardown, 60);
    } else teardown();
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

  /** Ask the browser to start the clock (synchronously, so it counts as part of the gesture). */
  private requestResume(ctx: BaseAudioContext): Promise<void> {
    if (this.offline || this.selfSuspended || ctx.state === 'running') return Promise.resolve();
    const resume = (ctx as Partial<AudioContext>).resume;
    if (typeof resume !== 'function') return Promise.resolve();
    return resume.call(ctx).catch(() => undefined);
  }

  /** Generate the noise loops and reverb (in slices for a live context), then build the graph. */
  private async buildAssets(ctx: BaseAudioContext): Promise<void> {
    const work = assetsWork(ctx, this.seed);
    const assets = this.offline ? runSync(work) : await runSliced(work, () => this.disposed);
    if (assets && !this.disposed && !this.graph) this.build(ctx, assets);
  }

  private build(ctx: BaseAudioContext, assets: AudioAssets): void {
    const { kit } = assets;
    const graph = new MixGraph(ctx, assets.ir, this.volumes, this.muted);
    const tuning = { humHz: humFrequency(this.key), droneHz: droneFrequency(this.key) };
    this.kit = kit;
    this.graph = graph;
    this.layers = [
      new CabinLayer(kit, graph.sfx, tuning),
      new EngineLayer(kit, graph.sfx, tuning),
      new RcsLayer(kit, graph.sfx, tuning),
      new WindLayer(kit, graph.sfx, tuning),
      new HeatLayer(kit, graph.sfx, tuning),
      new HyperLayer(kit, graph.sfx, tuning),
    ];
    this.player = new ScorePlayer(kit, graph.music, graph.musicWet, this.score);
    // A context may start later than resume() promised (browser policy); go live whenever it does.
    ctx.addEventListener('statechange', this.onStateChange);
  }

  private readonly onStateChange = (): void => {
    if (this.unlocked) this.goLive();
  };

  /** First time the context is running: start the score, the cabin and the scheduler. */
  private goLive(): void {
    if (this.started || !this.ctx || !this.player) return;
    this.started = true;
    const now = this.ctx.currentTime;
    this.player.start(now + 0.25, this.scoreOffset);
    this.blipOrigin = now + 0.5;
    this.blipUntil = this.blipOrigin;
    if (!this.offline) this.timer = setInterval(() => this.pump(), PUMP_INTERVAL_MS);
    this.introCaptions();
    this.update(0, this.state);
    this.updateSuspension();
  }

  /** The graph is live and producing sound (not before unlock, not while self-suspended). */
  private running(): boolean {
    return this.started && !this.selfSuspended && this.unlocked;
  }

  private applyVolumes(): void {
    if (!this.graph || !this.ctx) return;
    try {
      this.graph.setVolumes(this.volumes, this.muted, this.ctx.currentTime);
      if (this.started) {
        this.pump();
        this.introCaptions();
      }
      this.updateSuspension();
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

  /**
   * Nothing can be heard: suspend a context this engine owns once the output has faded (it costs no audio CPU while
   * suspended, and the score resumes where it stopped). Resume as soon as anything is audible again.
   */
  private updateSuspension(): void {
    const ctx = this.ctx as AudioContext | null;
    if (!ctx || this.offline || !this.ownsContext || !this.started || this.disposed) return;
    if (!this.musicAudible() && !this.sfxAudible()) {
      if (this.selfSuspended || this.suspendTimer !== null) return;
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        if (this.disposed || this.musicAudible() || this.sfxAudible() || ctx.state !== 'running') return;
        this.selfSuspended = true;
        ctx.suspend().catch(() => {
          this.selfSuspended = false;
        });
      }, SUSPEND_AFTER_MS);
      return;
    }
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    if (this.selfSuspended) {
      this.selfSuspended = false;
      ctx
        .resume()
        .then(() => this.update(0, this.state))
        .catch(() => undefined);
    }
  }

  /** Schedule music and avionics ahead of the audio clock (called from update() and a timer). */
  private pump(): void {
    if (!this.running()) return;
    try {
      const now = this.ctx!.currentTime;
      this.player!.pump(now, this.musicAudible());
      const horizon = now + BLIP_LOOKAHEAD_S;
      if (horizon > this.blipUntil) {
        const from = Math.max(this.blipUntil, now);
        if (this.sfxAudible())
          for (const b of instrumentBlips(this.seed, from - this.blipOrigin, horizon - this.blipOrigin, this.blipTones)) this.blip(b, this.blipOrigin + b.at);
        this.blipUntil = horizon;
      }
    } catch (e) {
      this.fail(e);
    }
  }

  /** Avionics instrument tone: one or two very soft sine blips, in the score's key. */
  private blip(b: Blip, at: number): void {
    const kit = this.kit!;
    const g = new NodeGroup(kit.ctx);
    const out = g.gain(1);
    out.connect(g.pan(b.pan)).connect(this.graph!.sfx);
    out.connect(g.gain(0.25)).connect(this.graph!.sfxWet);
    // The answering tone is the next blip pitch up (the top pitch answers one down), so both stay in key.
    const tones = this.blipTones;
    const i = tones.indexOf(b.hz);
    const second = i < 0 ? b.hz : (tones[i + 1] ?? tones[i - 1] ?? b.hz);
    let end = 0;
    for (let k = 0; k < b.count; k++) {
      const o = g.osc('sine', k === 0 ? b.hz : second);
      const env = g.gain(0);
      end = envelope(env.gain, at + k * 0.09, 0.003, 0.01, 0.07, 0.016 * b.vel);
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

  /** The cabin and '[Ambient music]' captions, once, when the soundscape starts. */
  private introCaptions(): void {
    if (!this.started) return;
    if (!this.cabinCaptioned) this.cabinCaptioned = this.caption(STATE_CAPTIONS.cabin, 'sfx');
    if (!this.musicCaptioned && this.player?.started) this.musicCaptioned = this.caption(STATE_CAPTIONS.music, 'music');
  }

  /**
   * Show a caption unless the identical one is still on screen. Returns false only when it was withheld because the
   * sound is inaudible and captionsWhenSilent is off (so it can be retried when the sound becomes audible).
   */
  private caption(def: CaptionDef, bus: 'music' | 'sfx'): boolean {
    if (!this.captionsWhenSilent && !(this.running() && (bus === 'music' ? this.musicAudible() : this.sfxAudible()))) return false;
    if (!this.onCaption) return true;
    let now: number;
    try {
      now = finite(this.clock(), wallClock());
    } catch {
      now = wallClock();
    }
    if (!this.gate.allow(def, now)) return true;
    try {
      this.onCaption(def.key, def.duration);
    } catch (e) {
      // A failing caption renderer must not break audio; surface the error asynchronously.
      queueMicrotask(() => {
        throw e;
      });
    }
    return true;
  }

  private fail(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    if (this.lastError === null) console.warn('[audio]', msg);
    this.lastError = msg;
  }
}
