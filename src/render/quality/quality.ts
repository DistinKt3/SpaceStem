/**
 * Adaptive quality: four rendering levels and a controller that picks one from measured frame times.
 *
 * The controller is fed one frame interval per rendered frame (the time between consecutive animation frames, which is
 * what the player experiences). It groups samples into 0.5 s buckets, takes each bucket's p90 (so up to 10% of slow
 * frames are tolerated as noise), and moves between levels with asymmetric hysteresis:
 *
 *   - degrade after ~2 s of buckets over budget (two levels at once when far over),
 *   - upgrade after ~8 s of buckets within budget, as a probe that must survive a probation period; every degrade
 *     from a level doubles the quiet time needed to probe it again, and repeated failed probes lock it for a while,
 *   - a degrade that does not make frames faster (CPU-bound, or capped by the display) is undone, and the controller
 *     stops degrading there, so it never cycles between two levels,
 *   - frames that cannot get faster (a 50 Hz panel, a 30 fps power-saving cap, a CPU limit) set the budget: once a
 *     degrade has proved useless, or a probe from the lowest level has shown that the next level costs nothing, the
 *     frame time found is the "limit" and budgets are judged against it, so such machines still climb back up.
 *
 * Hitches (single frames over 250 ms: shader compiles, chunk uploads, GC), pauses (tab switches, hidden windows) and
 * the first frames after boot or a level change are not evidence and are ignored. See docs/QUALITY.md for the design
 * and the reasoning behind every constant.
 *
 * This module is pure logic (no DOM, no three.js); the clock is injectable for tests.
 */

export type QualityName = 'low' | 'medium' | 'high' | 'ultra';
/** Player-facing preset (settings.data.quality). 'ultra' is only reached by 'auto' on fast hardware. */
export type QualityPreset = 'auto' | 'low' | 'medium' | 'high';

export interface QualityLevel {
  readonly name: QualityName;
  /** Fraction (0.5..1) of the pixel-ratio-capped canvas size used for the HDR scene buffer; upscaled bilinearly. */
  readonly renderScale: number;
  /** Cap on window.devicePixelRatio for the canvas and the scene buffer (HiDPI screens). */
  readonly maxPixelRatio: number;
  /** MSAA samples on the HDR scene buffer. */
  readonly msaa: 0 | 4;
  readonly bloom: boolean;
  /** PlanetTerrain screen-space error threshold, pixels (higher = coarser terrain, fewer chunks). */
  readonly terrainErrorPx: number;
  /** Cockpit geometry and glass texture detail. */
  readonly cockpit: 'low' | 'high';
  /** Faintest apparent magnitude drawn by the starfield (fainter sprites become zero-area quads). */
  readonly starMagLimit: number;
  /** Atmosphere ray-march samples along the view ray (sky shell); surface aerial perspective uses about 2/3. */
  readonly viewSamples: number;
}

export const QUALITY_NAMES: readonly QualityName[] = ['low', 'medium', 'high', 'ultra'];

/**
 * The levels, cheapest first. 'high' reproduces the renderer's defaults before adaptive quality existed (MSAA 4,
 * terrain error 2 px, star limit 7.5, 12 sky samples) except that HiDPI rendering is capped at 1.5x; 'ultra' restores
 * the full 2x. Values are presentation choices aimed at an integrated laptop GPU at 1080p (TECH_PLAN Section 9).
 */
export const QUALITY_LEVELS: readonly QualityLevel[] = Object.freeze(
  (
    [
      { name: 'low', renderScale: 0.67, maxPixelRatio: 1, msaa: 0, bloom: false, terrainErrorPx: 6, cockpit: 'low', starMagLimit: 6.5, viewSamples: 6 },
      { name: 'medium', renderScale: 0.85, maxPixelRatio: 1, msaa: 0, bloom: true, terrainErrorPx: 3, cockpit: 'high', starMagLimit: 7, viewSamples: 8 },
      { name: 'high', renderScale: 1, maxPixelRatio: 1.5, msaa: 4, bloom: true, terrainErrorPx: 2, cockpit: 'high', starMagLimit: 7.5, viewSamples: 12 },
      { name: 'ultra', renderScale: 1, maxPixelRatio: 2, msaa: 4, bloom: true, terrainErrorPx: 1.5, cockpit: 'high', starMagLimit: 8, viewSamples: 16 },
    ] satisfies QualityLevel[]
  ).map((l) => Object.freeze(l)),
);

export function levelIndex(name: QualityName): number {
  return QUALITY_NAMES.indexOf(name);
}

export function qualityLevel(name: QualityName): QualityLevel {
  return QUALITY_LEVELS[levelIndex(name)]!;
}

/** Knobs that differ between two levels. */
export function qualityDiff(a: QualityLevel, b: QualityLevel): (keyof QualityLevel)[] {
  return (Object.keys(b) as (keyof QualityLevel)[]).filter((k) => k !== 'name' && a[k] !== b[k]);
}

/** Assumed GPU cost multipliers (rough, see docs/QUALITY.md); used only for estimates, never for control decisions. */
export const COST_MODEL = {
  /** MSAA 4x on a half-float target, relative to no MSAA (fill and resolve bandwidth). */
  msaa4: 1.3,
  /** Bloom's mip chain at half resolution plus the composite. */
  bloom: 1.1,
  /** Change in frame cost per atmosphere view sample, relative to the 12-sample default. */
  perViewSample: 0.012,
} as const;

/**
 * Estimated GPU cost of a level relative to 'high' on the same screen (pixel count x MSAA x bloom x atmosphere).
 * An estimate for suggestions only: real costs depend on the scene and the GPU.
 */
export function relativeCost(level: QualityLevel, devicePixelRatio = 1): number {
  const cost = (l: QualityLevel): number => {
    const pr = Math.min(Math.max(devicePixelRatio, 0.5), l.maxPixelRatio) * l.renderScale;
    return pr * pr * (l.msaa === 4 ? COST_MODEL.msaa4 : 1) * (l.bloom ? COST_MODEL.bloom : 1) * (1 + (l.viewSamples - 12) * COST_MODEL.perViewSample);
  };
  return cost(level) / cost(qualityLevel('high'));
}

/** Controller constants (milliseconds unless noted). Exported for tests and docs/QUALITY.md. */
export const QUALITY_TUNING = {
  /** Samples are grouped into buckets of this length; each bucket yields one p90. */
  bucketMs: 500,
  /** Consecutive over-budget buckets before degrading (4 x 0.5 s = 2 s). */
  degradeBuckets: 4,
  /** During probation after an upgrade, a failing probe is undone after this many over-budget buckets (1 s). */
  probationDegradeBuckets: 2,
  /** Consecutive within-budget buckets before an upgrade probe (16 x 0.5 s = 8 s), times 2^backoff of that level. */
  upgradeBuckets: 16,
  /** Cap on the backoff exponent (16 x 0.5 s x 2^4 = 128 s). */
  maxBackoff: 4,
  /** A bucket is over budget when its p90 exceeds target x this (20 ms at 60 Hz: absorbs vsync jitter). */
  overFactor: 1.2,
  /**
   * Far over budget (p90 > target x this in every bucket of the evidence): drop two levels at once. 2.5 (41.7 ms at
   * 60 Hz, under 24 fps) rather than 2: on a 60 Hz display a frame that just misses vsync lasts 33.3 ms, so a threshold
   * at 2x would be decided by jitter.
   */
  severeFactor: 2.5,
  /** A bucket is within budget when its p90 is at most target x this. */
  withinFactor: 1.1,
  /** Single frames longer than this are hitches (compiles, uploads, GC) and ignored... */
  hitchMs: 250,
  /** ...unless this many arrive in a row (pause-length ones included): then they are the frame rate and count. */
  sustainedHitches: 3,
  /** An isolated frame (or a clock gap between samples) longer than this is a pause (tab switch): evidence is reset. */
  pauseMs: 1000,
  /** Samples are ignored for this long after a reset, a preset change or a level change (from the next sample)... */
  settleMs: 1000,
  /** ...or this long after construction (boot: first shader compiles and uploads)... */
  startSettleMs: 2000,
  /** ...and for at least this many frames. */
  settleFrames: 5,
  /**
   * An upgrade is a probe until it has lasted this long; falling back within it is a failed probe. Longer than typical
   * short load swings (a few seconds), so a probe cannot pass by luck during a lull.
   */
  probationMs: 10_000,
  /** Holding a level this long forgives one step of its backoff (and its failed probes). */
  forgiveMs: 60_000,
  /** Failed probes into a level before it is locked out. */
  maxProbeFailures: 2,
  /** First lock of a level lasts this long; each further lock of the same level doubles it... */
  lockMs: 120_000,
  /** ...up to this. */
  maxLockMs: 1_800_000,
  /**
   * A degrade episode (one or more steps down) must improve the p90 by at least this fraction. If the floor is reached
   * without that, the bottleneck is not the GPU (CPU-bound, or the display's refresh rate), so the episode is undone.
   */
  minImprovement: 0.08,
  /** Buckets measured at a new level before judging a degrade episode. */
  checkBuckets: 4,
  /** A floor set by an ineffective degrade is released when the p90 stays above the recorded value x this. */
  floorRelease: 1.25,
  /** Window for stats() (p50/p90 of recent counted samples). */
  statsWindowMs: 2000,
  /**
   * sceneChanged() forgets backoffs and locks at most this often (it always discards evidence). Teleports and arrivals
   * are rare, but a burst of them must not bring back the probe/fail cycling that backoff and locks prevent: when the
   * first probe after a forgetting fails anyway, the interval doubles (up to maxLockMs); a probe that holds resets it.
   */
  sceneForgetMs: 60_000,
} as const;

export type QualityChangeReason = 'degrade' | 'severe' | 'probe' | 'probe-failed' | 'ineffective' | 'preset';

export interface QualityChange {
  from: QualityName;
  to: QualityName;
  reason: QualityChangeReason;
  /** Controller clock time of the change, ms. */
  at: number;
  /** Bucket p90 that motivated the change, ms (0 for preset changes). */
  p90: number;
}

export interface QualityStats {
  preset: QualityPreset;
  level: QualityName;
  /** Counted samples in the last statsWindowMs. */
  samples: number;
  p50Ms: number;
  p90Ms: number;
  /** Lowest level auto may use right now (minLevel, or a floor set by an ineffective degrade). */
  floor: QualityName;
  /** Levels auto will not probe until their lock expires (or sceneChanged()). */
  locked: QualityName[];
  /**
   * Frame time (ms) that frames were found unable to beat (the display's refresh, a frame-rate cap, the CPU), or null.
   * Budgets are judged against max(target, limit).
   */
  limitMs: number | null;
  /** Frames ignored as hitches since construction. */
  ignoredHitches: number;
  lastChange: QualityChange | null;
}

export interface QualityControllerOptions {
  preset: QualityPreset;
  /** Frame budget, ms. Default 16.7 (60 fps). */
  targetFrameMs?: number;
  /** Clock in ms (default performance.now). */
  now?: () => number;
  /** Auto never goes below this level. Default 'low'. */
  minLevel?: QualityName;
  /** Auto never goes above this level. Default 'ultra'. */
  maxLevel?: QualityName;
  /** First level in auto. Default 'high' (the renderer's original look; degrading takes ~2 s). */
  startLevel?: QualityName;
}

/** Nearest-rank percentile of an ascending array (p in 0..1); 0 for an empty array. */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const i = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sorted[i]!;
}

/** Nearest-rank percentile of unsorted values. */
export function percentile(values: readonly number[], p: number): number {
  return percentileSorted(Float64Array.from(values).sort(), p);
}

/** Ring size for stats() (about 8 s at 120 fps). */
const STATS_CAP = 1024;

export class QualityController {
  readonly targetFrameMs: number;
  private presetValue: QualityPreset;
  private current: QualityLevel;
  private readonly now: () => number;
  private readonly minIndex: number;
  private readonly maxIndex: number;
  private readonly T = QUALITY_TUNING;

  // Evidence (discarded by reset()).
  private bucketStart: number | null = null;
  private bucket: number[] = [];
  /** End of the settle period; null = starts at the next sample. */
  private settleUntil: number | null = null;
  private settleMsNext: number = QUALITY_TUNING.startSettleMs;
  private settleFramesLeft = 0;
  private lastSampleAt: number | null = null;
  private overRun = 0;
  private severeRun = 0;
  private withinRun = 0;
  /** Bucket p90s of the current over-budget run (the "before" value of a degrade). */
  private overP90s: number[] = [];
  /** Consecutive buckets over the fail threshold of the current probe. */
  private failRun = 0;
  /** Bucket p90s of the current run clearly faster than the limit (evidence that the limit no longer holds). */
  private fastP90s: number[] = [];

  /** Consecutive frames longer than hitchMs (kept across resets, so a pause-length frame rate is still recognised). */
  private longRun = 0;

  // Memory (kept across resets; cleared by setPreset() and sceneChanged()).
  /** Per level: exponent of the quiet time needed before probing it (raised by every degrade from it). */
  private readonly backoff = new Map<QualityName, number>();
  /** When the current level was entered, and when holding it last earned forgiveness. */
  private heldSince = 0;
  private readonly probeFailures = new Map<QualityName, number>();
  /** Times each level has been locked (lock length doubles), and until when it is locked. */
  private readonly locks = new Map<QualityName, number>();
  private readonly lockedUntil = new Map<QualityName, number>();
  /**
   * The current probe: the level, the end of its probation, and the p90 before it when it was made from the floor
   * while over budget (a "does the next level cost anything?" probe, judged against that p90), with the p90s so far.
   */
  private probation: { level: QualityName; until: number; pre: number | null; p90s: number[] } | null = null;
  /**
   * The current degrade episode: the level it started from, the p90 there, the backoffs before it (restored if it is
   * undone), and the bucket p90s at the current level.
   */
  private episode: { start: QualityName; before: number; backoff: Map<QualityName, number>; p90s: number[] } | null = null;
  /** No degrades below this index (set by an ineffective degrade). */
  private floor: { index: number; p90: number; run: number } | null = null;
  /** Frame time frames could not beat (QualityStats.limitMs). Kept across sceneChanged(): it describes the machine. */
  private limit: number | null = null;
  /** Controller time of the last forgetting by sceneChanged(), the interval required before the next one, and whether
   *  the first probe since has yet to show whether forgetting was right. */
  private lastForget = -Infinity;
  private forgetGap: number = QUALITY_TUNING.sceneForgetMs;
  private forgetOnTrial = false;

  // Stats.
  private readonly recent = new Float64Array(STATS_CAP);
  private readonly recentAt = new Float64Array(STATS_CAP);
  private recentHead = 0;
  private recentCount = 0;
  private ignoredHitches = 0;
  private last: QualityChange | null = null;

  constructor(opts: QualityControllerOptions) {
    this.targetFrameMs = opts.targetFrameMs !== undefined && opts.targetFrameMs > 0 ? opts.targetFrameMs : 16.7;
    this.now = opts.now ?? (() => performance.now());
    this.minIndex = levelIndex(opts.minLevel ?? 'low');
    this.maxIndex = Math.max(this.minIndex, levelIndex(opts.maxLevel ?? 'ultra'));
    const start = Math.min(this.maxIndex, Math.max(this.minIndex, levelIndex(opts.startLevel ?? 'high')));
    this.presetValue = opts.preset;
    this.current = opts.preset === 'auto' ? QUALITY_LEVELS[start]! : qualityLevel(opts.preset);
    this.reset();
    this.settleMsNext = QUALITY_TUNING.startSettleMs;
    this.heldSince = this.now();
  }

  /** The level to render with. Changes only through sample() (which returns it) or setPreset(). */
  get level(): QualityLevel {
    return this.current;
  }

  get preset(): QualityPreset {
    return this.presetValue;
  }

  /** The last level change (for logs and debugging overlays). */
  get lastChange(): QualityChange | null {
    return this.last;
  }

  /**
   * Switch preset. A fixed preset pins its level; 'auto' adapts from the current level with a clean slate. This method
   * does not return the level: re-apply `level` afterwards.
   */
  setPreset(p: QualityPreset): void {
    const from = this.current.name;
    this.presetValue = p;
    this.current = p === 'auto' ? QUALITY_LEVELS[Math.min(this.maxIndex, Math.max(this.minIndex, levelIndex(from)))]! : qualityLevel(p);
    this.forget();
    this.floor = null;
    this.limit = null;
    this.forgetGap = this.T.sceneForgetMs;
    this.forgetOnTrial = false;
    this.heldSince = this.now();
    if (from !== this.current.name) this.last = { from, to: this.current.name, reason: 'preset', at: this.now(), p90: 0 };
    this.reset();
  }

  /**
   * Discard current evidence and wait settleMs before counting samples again. Call it after anything that makes the
   * next frames unrepresentative (a resize, a teleport). Memory of failed levels is kept.
   */
  reset(): void {
    this.bucketStart = null;
    this.bucket = [];
    this.overRun = 0;
    this.severeRun = 0;
    this.withinRun = 0;
    this.overP90s = [];
    this.failRun = 0;
    this.fastP90s = [];
    this.lastSampleAt = null;
    this.settleUntil = null;
    this.settleMsNext = this.T.settleMs;
    this.settleFramesLeft = this.T.settleFrames;
    if (this.episode) this.episode.p90s = [];
  }

  /**
   * The scene's load changed in a way frame times cannot reveal under vsync (a teleport, an arrival in another star
   * system): forget backoffs and locks so higher levels may be probed again soon (at most once per sceneForgetMs), and
   * reset evidence. The floor and the limit stay: they describe the machine (a 50 Hz display is still 50 Hz), and each
   * has its own release rule for when frames get clearly worse or clearly better.
   */
  sceneChanged(): void {
    const now = this.now();
    if (now - this.lastForget >= this.forgetGap) {
      this.lastForget = now;
      this.forget();
      this.forgetOnTrial = true;
    } else {
      // A degrade cannot be judged across scenes, and a probe is judged on frames of the new scene.
      this.episode = null;
      if (this.probation) this.probation.until = now + this.T.probationMs;
    }
    this.reset();
  }

  /**
   * Feed one frame interval (ms). Returns the new level when it changes, else null. With a fixed preset the level
   * never changes here, but samples still feed stats().
   */
  sample(frameMs: number): QualityLevel | null {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return null;
    const T = this.T;
    const now = this.now();
    // Long frames are hitches (> hitchMs) or pauses (> pauseMs, a tab switch) when isolated, but the frame rate when
    // they keep coming: from the sustainedHitches-th in a row they count as samples (a machine at 1 fps degrades too).
    this.longRun = frameMs > T.hitchMs ? this.longRun + 1 : 0;
    const sustained = this.longRun >= T.sustainedHitches;
    // Pauses: a huge frame, or a gap in the clock (samples were not fed, e.g. while a menu was open).
    const gap = this.lastSampleAt === null ? 0 : now - this.lastSampleAt;
    if ((frameMs > T.pauseMs && !sustained) || gap > T.pauseMs + frameMs) {
      this.reset();
      this.lastSampleAt = now;
      // A probe is judged on frames the player saw: restart its probation after the pause.
      if (this.probation) this.probation.until = now + T.probationMs;
      return null;
    }
    this.lastSampleAt = now;
    if (frameMs > T.hitchMs && !sustained) {
      this.ignoredHitches++;
      return null;
    }
    // Settling after boot, a reset or a change: compiles and resizes make the first frames unrepresentative.
    this.settleUntil ??= now + this.settleMsNext;
    if (this.settleFramesLeft > 0 || now < this.settleUntil) {
      this.settleFramesLeft = Math.max(0, this.settleFramesLeft - 1);
      return null;
    }
    this.record(now, frameMs);
    this.bucketStart ??= now - frameMs;
    this.bucket.push(frameMs);
    if (now - this.bucketStart < T.bucketMs) return null;
    const p90 = percentile(this.bucket, 0.9);
    this.bucketStart = now;
    this.bucket = [];
    return this.presetValue === 'auto' ? this.decide(p90, now) : null;
  }

  /** One decision per closed bucket. */
  private decide(p90: number, now: number): QualityLevel | null {
    const T = this.T;
    const idx = levelIndex(this.current.name);
    const floorIndex = (): number => Math.max(this.minIndex, this.floor?.index ?? this.minIndex);

    // 1. A probe that lasted its probation is no longer judged as a probe. A probe made from the floor while over
    //    budget that held shows that the next level costs nothing: frames are limited by something quality does not
    //    control (the display's refresh rate, a frame-rate cap, the CPU), and their frame time becomes the limit.
    const pr = this.probation;
    if (pr && now >= pr.until) {
      this.probation = null;
      if (pr.pre !== null) this.setLimit(Math.max(pr.pre, percentile(pr.p90s.length ? pr.p90s : [p90], 0.5)));
      if (this.forgetOnTrial) {
        this.forgetOnTrial = false;
        this.forgetGap = T.sceneForgetMs;
      }
    } else if (pr) pr.p90s.push(p90);

    // 2. Frames clearly faster than the limit for a while: it was not a hard limit (the CPU load dropped), so lower it,
    //    and release the floor, which rested on the same evidence (lower levels did not make frames faster).
    if (this.limit !== null) {
      if (p90 < this.limit / (1 + T.minImprovement)) this.fastP90s.push(p90);
      else this.fastP90s = [];
      if (this.fastP90s.length >= T.degradeBuckets) {
        this.setLimit(Math.max(...this.fastP90s));
        this.floor = null;
      }
    }

    const budget = Math.max(this.targetFrameMs, this.limit ?? 0);
    const over = p90 > budget * T.overFactor;
    this.overRun = over ? this.overRun + 1 : 0;
    this.severeRun = p90 > budget * T.severeFactor ? this.severeRun + 1 : 0;
    this.withinRun = p90 <= budget * T.withinFactor ? this.withinRun + 1 : 0;
    if (over) {
      this.overP90s.push(p90);
      if (this.overP90s.length > T.degradeBuckets * 2) this.overP90s.shift();
    } else this.overP90s = [];
    // A probe fails when over budget or, for a probe from the floor, when clearly slower than before it.
    const probe = this.probation;
    const failing = probe !== null && p90 > Math.max(budget * T.overFactor, (probe.pre ?? 0) * (1 + T.minImprovement));
    this.failRun = failing ? this.failRun + 1 : 0;

    // 3. Judge the current degrade episode once the new level has been measured: if frames got measurably faster it is
    //    over; if not and there is nowhere lower to go, lower quality buys nothing (CPU-bound or refresh-bound), so it
    //    is undone, the controller stops degrading there and that frame time becomes the limit. Otherwise the normal
    //    rule may step down again.
    const ep = this.episode;
    if (ep) {
      ep.p90s.push(p90);
      if (ep.p90s.length > T.checkBuckets) ep.p90s.shift();
      if (ep.p90s.length < T.checkBuckets) return null;
      const after = percentile(ep.p90s, 0.5);
      if (after <= ep.before * (1 - T.minImprovement)) this.episode = null;
      else if (idx <= floorIndex()) {
        this.episode = null;
        this.backoff.clear();
        for (const [k, v] of ep.backoff) this.backoff.set(k, v);
        this.floor = { index: levelIndex(ep.start), p90: ep.before, run: 0 };
        this.setLimit(Math.max(ep.before, after));
        return this.change(ep.start, 'ineffective', after, now);
      }
    }

    // 4. A floor is released when frames stay clearly worse than when it was set (a different kind of load).
    if (this.floor) {
      this.floor.run = p90 > this.floor.p90 * T.floorRelease ? this.floor.run + 1 : 0;
      if (this.floor.run >= T.degradeBuckets) this.floor = null;
    }

    // 5. A probe's backoff stays after its probation: only holding a level for a long time earns that back, one step
    //    per forgiveMs, so a level that keeps being abandoned is probed ever more rarely (this is what rules out cycles
    //    under periodic load).
    if (now - this.heldSince >= T.forgiveMs) {
      this.heldSince = now;
      const name = this.current.name;
      decrement(this.backoff, name);
      decrement(this.locks, name);
      this.probeFailures.delete(name);
    }

    // 6. Degrade fast (a failing probe after only probationDegradeBuckets).
    const inProbation = this.probation !== null;
    const due = inProbation ? this.failRun >= T.probationDegradeBuckets : this.overRun >= T.degradeBuckets;
    if (due && idx > floorIndex()) {
      const steps = !inProbation && this.severeRun >= T.degradeBuckets ? 2 : 1;
      const toIndex = Math.max(floorIndex(), idx - steps);
      const from = this.current.name;
      if (inProbation) {
        // A failed probe is known to be too slow: no episode to judge.
        const fails = (this.probeFailures.get(from) ?? 0) + 1;
        this.probeFailures.set(from, fails);
        if (fails >= T.maxProbeFailures) {
          const n = (this.locks.get(from) ?? 0) + 1;
          this.locks.set(from, n);
          this.lockedUntil.set(from, now + Math.min(T.maxLockMs, T.lockMs * 2 ** (n - 1)));
          this.probeFailures.delete(from);
        }
        this.probation = null;
        // The scene change that lifted this level's memory did not make it affordable: forget less often.
        if (this.forgetOnTrial) {
          this.forgetOnTrial = false;
          this.forgetGap = Math.min(T.maxLockMs, this.forgetGap * 2);
        }
      } else {
        this.episode ??= { start: from, before: percentile(this.overP90s, 0.5), backoff: new Map(this.backoff), p90s: [] };
      }
      // Every level given up needs twice the quiet time before it is probed again.
      for (let i = idx; i > toIndex; i--) {
        const n = QUALITY_NAMES[i]!;
        this.backoff.set(n, Math.min(T.maxBackoff, (this.backoff.get(n) ?? 0) + 1));
      }
      const reason: QualityChangeReason = inProbation ? 'probe-failed' : steps === 2 ? 'severe' : 'degrade';
      return this.change(QUALITY_NAMES[toIndex]!, reason, p90, now);
    }

    // 7. Upgrade slowly, as a probe (never during a degrade episode): after a quiet period within budget or, at the
    //    floor and still over budget (nothing lower to try), to find out whether the next level costs anything at all.
    if (idx < this.maxIndex && !inProbation && !this.episode) {
      const next = QUALITY_NAMES[idx + 1]!;
      const until = this.lockedUntil.get(next);
      if (until !== undefined && now >= until) {
        this.lockedUntil.delete(next);
        // One more failure locks it again (for twice as long).
        this.probeFailures.set(next, T.maxProbeFailures - 1);
      }
      const quiet = T.upgradeBuckets * 2 ** (this.backoff.get(next) ?? 0);
      const within = this.withinRun >= quiet;
      const stuck = idx <= floorIndex() && this.overRun >= quiet;
      if (!this.lockedUntil.has(next) && (within || stuck)) {
        this.probation = { level: next, until: now + T.probationMs, pre: within ? null : percentile(this.overP90s, 0.5), p90s: [] };
        return this.change(next, 'probe', p90, now);
      }
    }
    return null;
  }

  /** Sets the limit (null when within the target budget anyway); runs judged against the old budget start over. */
  private setLimit(ms: number): void {
    const v = Number.isFinite(ms) && ms > this.targetFrameMs * this.T.withinFactor ? ms : null;
    if (v === this.limit) return;
    this.limit = v;
    this.fastP90s = [];
    this.overRun = 0;
    this.severeRun = 0;
    this.withinRun = 0;
    this.overP90s = [];
  }

  /** Forgets backoffs, failed probes and locks, and any probe or degrade episode in progress. */
  private forget(): void {
    this.backoff.clear();
    this.probeFailures.clear();
    this.locks.clear();
    this.lockedUntil.clear();
    this.probation = null;
    this.episode = null;
  }

  private change(to: QualityName, reason: QualityChangeReason, p90: number, now: number): QualityLevel {
    this.last = { from: this.current.name, to, reason, at: now, p90 };
    this.current = qualityLevel(to);
    this.heldSince = now;
    this.reset();
    return this.current;
  }

  private record(now: number, ms: number): void {
    this.recent[this.recentHead] = ms;
    this.recentAt[this.recentHead] = now;
    this.recentHead = (this.recentHead + 1) % STATS_CAP;
    this.recentCount = Math.min(STATS_CAP, this.recentCount + 1);
  }

  stats(): QualityStats {
    const now = this.now();
    const vals: number[] = [];
    for (let k = 0; k < this.recentCount; k++) {
      const i = (this.recentHead - 1 - k + STATS_CAP) % STATS_CAP;
      if (now - this.recentAt[i]! > this.T.statsWindowMs) break;
      vals.push(this.recent[i]!);
    }
    const sorted = Float64Array.from(vals).sort();
    return {
      preset: this.presetValue,
      level: this.current.name,
      samples: sorted.length,
      p50Ms: percentileSorted(sorted, 0.5),
      p90Ms: percentileSorted(sorted, 0.9),
      floor: QUALITY_NAMES[Math.max(this.minIndex, this.floor?.index ?? this.minIndex)]!,
      locked: QUALITY_NAMES.filter((n) => (this.lockedUntil.get(n) ?? -Infinity) > now),
      limitMs: this.limit,
      ignoredHitches: this.ignoredHitches,
      lastChange: this.last,
    };
  }
}

function decrement(m: Map<QualityName, number>, k: QualityName): void {
  const v = (m.get(k) ?? 0) - 1;
  if (v > 0) m.set(k, v);
  else m.delete(k);
}
