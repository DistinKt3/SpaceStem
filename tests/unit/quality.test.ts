/**
 * Adaptive quality controller and benchmark statistics. The controller is driven by synthetic frame-time traces with
 * a fake clock: a "load" gives the work per frame at each level, and frames are quantised to a 60 Hz display (vsync)
 * with deterministic jitter, as a browser's requestAnimationFrame intervals are.
 */
import { describe, expect, it } from 'vitest';
import {
  QUALITY_LEVELS,
  QUALITY_NAMES,
  QUALITY_TUNING,
  QualityController,
  levelIndex,
  percentile,
  qualityDiff,
  qualityLevel,
  relativeCost,
  type QualityControllerOptions,
  type QualityLevel,
  type QualityName,
} from '../../src/render/quality/quality';
import { applyQuality, type QualityTarget } from '../../src/render/quality/applyQuality';
import {
  BENCH_FORMAT,
  BENCH_VERSION,
  DEFAULT_BENCH_VIEWS,
  SCENE_BUDGET,
  drawCallBudget,
  estimateP95,
  reportJson,
  runBench,
  suggestPreset,
  summarizeView,
  verdictFor,
  type BenchDriver,
  type BenchFrame,
  type BenchViewResult,
} from '../../src/game/bench/bench';
import { viewLabel } from '../../src/game/bench/benchPanel';
import { t } from '../../src/game/i18n';

/** Deterministic uniform [0, 1) (LCG), so traces are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Change {
  t: number;
  from: QualityName;
  to: QualityName;
  reason: string;
}

interface SimOptions {
  /** Display refresh interval (ms); frames are quantised to it. 0 = no vsync. */
  vsyncMs?: number;
  jitterMs?: number;
  seed?: number;
  /** Exact frame intervals to inject at given frame numbers (hitches, pauses). */
  inject?: (frame: number, t: number) => number | null;
  /** Called before each frame (to drive the controller's API during a trace). */
  before?: (ctrl: QualityController, t: number) => void;
}

/** Work per frame (ms) for a level at time t (ms). */
type Load = (level: QualityName, t: number) => number;

function sim(opts: Partial<QualityControllerOptions>, load: Load, durationMs: number, s: SimOptions = {}) {
  let t = 0;
  const ctrl = new QualityController({ preset: 'auto', now: () => t, ...opts });
  const rnd = lcg(s.seed ?? 1);
  const vsync = s.vsyncMs ?? 1000 / 60;
  const jitter = s.jitterMs ?? 0.3;
  const changes: Change[] = [];
  const timeAt = new Map<QualityName, number>();
  let frame = 0;
  while (t < durationMs) {
    s.before?.(ctrl, t);
    let ms = s.inject?.(frame, t) ?? null;
    if (ms === null) {
      const work = load(ctrl.level.name, t);
      ms = (vsync > 0 ? Math.max(1, Math.ceil(work / vsync - 1e-9)) * vsync : work) + (rnd() * 2 - 1) * jitter;
    }
    frame++;
    t += ms;
    timeAt.set(ctrl.level.name, (timeAt.get(ctrl.level.name) ?? 0) + ms);
    const from = ctrl.level.name;
    const r = ctrl.sample(ms);
    if (r) changes.push({ t, from, to: r.name, reason: ctrl.lastChange?.reason ?? '' });
  }
  const share = (n: QualityName): number => (timeAt.get(n) ?? 0) / t;
  return { ctrl, changes, share, end: t };
}

/** GPU-bound load: `highMs` of work at 'high', scaled by the level's estimated relative cost (1080p, DPR 1). */
const gpu =
  (highMs: number): Load =>
  (level) =>
    highMs * relativeCost(qualityLevel(level));

const reasons = (c: Change[]): string[] => c.map((x) => `${x.reason}:${x.to}`);
const MIN = 60_000;

describe('quality levels', () => {
  it('are ordered cheapest first with monotonic knobs in documented ranges', () => {
    expect(QUALITY_LEVELS.map((l) => l.name)).toEqual(['low', 'medium', 'high', 'ultra']);
    for (let i = 0; i < QUALITY_LEVELS.length; i++) {
      const l = QUALITY_LEVELS[i]!;
      expect(l.renderScale).toBeGreaterThanOrEqual(0.5);
      expect(l.renderScale).toBeLessThanOrEqual(1);
      expect(l.maxPixelRatio).toBeGreaterThanOrEqual(1);
      expect(Object.isFrozen(l)).toBe(true);
      if (i === 0) continue;
      const p = QUALITY_LEVELS[i - 1]!;
      expect(l.renderScale).toBeGreaterThanOrEqual(p.renderScale);
      expect(l.maxPixelRatio).toBeGreaterThanOrEqual(p.maxPixelRatio);
      expect(l.msaa).toBeGreaterThanOrEqual(p.msaa);
      expect(l.terrainErrorPx).toBeLessThanOrEqual(p.terrainErrorPx);
      expect(l.starMagLimit).toBeGreaterThanOrEqual(p.starMagLimit);
      expect(l.viewSamples).toBeGreaterThanOrEqual(p.viewSamples);
      expect(relativeCost(l, 2)).toBeGreaterThan(relativeCost(p, 2));
    }
    expect(Object.isFrozen(QUALITY_LEVELS)).toBe(true);
  });

  it("keeps the renderer's pre-existing defaults at 'high'", () => {
    // FrameRenderer (MSAA 4), PlanetTerrain (errorPx 2), Starfield (magLimit 7.5), createSkyMaterial (12 samples).
    const h = qualityLevel('high');
    expect([h.msaa, h.terrainErrorPx, h.starMagLimit, h.viewSamples, h.renderScale, h.bloom, h.cockpit]).toEqual([4, 2, 7.5, 12, 1, true, 'high']);
    expect(relativeCost(h)).toBe(1);
    expect(relativeCost(qualityLevel('low'))).toBeLessThan(0.5);
  });

  it('lists the knobs that differ between levels', () => {
    expect(qualityDiff(qualityLevel('high'), qualityLevel('ultra'))).toEqual(['maxPixelRatio', 'terrainErrorPx', 'starMagLimit', 'viewSamples']);
    expect(qualityDiff(qualityLevel('low'), qualityLevel('low'))).toEqual([]);
  });

  it('computes nearest-rank percentiles', () => {
    const v = Array.from({ length: 100 }, (_, i) => 100 - i); // 100..1, unsorted
    expect(percentile(v, 0.5)).toBe(50);
    expect(percentile(v, 0.9)).toBe(90);
    expect(percentile(v, 0.95)).toBe(95);
    expect(percentile(v, 1)).toBe(100);
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([], 0.9)).toBe(0);
  });
});

describe('quality controller', () => {
  it('steady fast: probes up once after ~8 s within budget and stays', () => {
    const r = sim({}, () => 5, 10 * MIN);
    expect(reasons(r.changes)).toEqual(['probe:ultra']);
    const t = r.changes[0]!.t;
    // boot settle (2 s) + 16 buckets of 0.5 s
    expect(t).toBeGreaterThan(9_500);
    expect(t).toBeLessThan(11_000);
    expect(r.ctrl.level.name).toBe('ultra');
  });

  it('starts at high in auto and honours startLevel and maxLevel', () => {
    expect(new QualityController({ preset: 'auto' }).level.name).toBe('high');
    expect(new QualityController({ preset: 'auto', startLevel: 'medium' }).level.name).toBe('medium');
    const r = sim({ maxLevel: 'high' }, () => 5, 2 * MIN);
    expect(r.changes).toEqual([]);
  });

  it('steady slow: drops two levels at once when far over budget, then settles without cycling', () => {
    const r = sim({}, gpu(50), 10 * MIN);
    const first = r.changes[0]!;
    expect(first.reason).toBe('severe');
    expect(first.to).toBe('low');
    expect(first.t).toBeLessThan(4_500); // boot settle 2 s + 4 buckets
    expect(r.ctrl.level.name).toBe('low');
    expect(r.share('low')).toBeGreaterThan(0.97);
    // Probes back up fail, and each failure makes the next probe rarer (backoff, then locks of 2, 4, 8... minutes).
    const failed = r.changes.filter((c) => c.reason === 'probe-failed');
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(failed.length).toBeLessThanOrEqual(5);
    for (let i = 2; i < failed.length; i++) expect(failed[i]!.t - failed[i - 1]!.t).toBeGreaterThan(failed[i - 1]!.t - failed[i - 2]!.t);
    const lockedAt = failed[1]!.t;
    expect(r.changes.filter((c) => c.t > lockedAt && c.t < lockedAt + QUALITY_TUNING.lockMs)).toEqual([]);
    expect(r.ctrl.stats().floor).toBe('low');
  });

  it('degrades one level at a time when moderately over budget', () => {
    const r = sim({}, gpu(30), 2 * MIN);
    expect(r.changes[0]).toMatchObject({ reason: 'degrade', from: 'high', to: 'medium' });
    expect(r.ctrl.level.name).toBe('medium');
    expect(r.share('medium')).toBeGreaterThan(0.9);
  });

  it('ignores hitches, loading spikes and occasional slow frames', () => {
    const rnd = lcg(42);
    const r = sim({}, () => (rnd() < 0.05 ? 25 : 8), 5 * MIN, {
      // A 400 ms hitch every 2 s, a pair of 600 ms frames every ~3.7 s.
      inject: (f) => (f % 120 === 60 ? 400 : f % 223 === 0 || f % 223 === 1 ? 600 : null),
    });
    expect(r.changes.filter((c) => c.reason !== 'probe')).toEqual([]);
    expect(r.ctrl.stats().ignoredHitches).toBeGreaterThan(100);
    expect(r.ctrl.level.name).toBe('ultra');
  });

  it('ignores the first frames after boot (shader compiles)', () => {
    // Three compile frames of 900 ms (counted as sustained hitches, but within the boot settle), then 1.5 s of 150 ms.
    const r = sim({}, () => 8, MIN, { inject: (f) => (f < 3 ? 900 : f < 13 ? 150 : null) });
    expect(r.changes.filter((c) => c.reason !== 'probe')).toEqual([]);
  });

  it('treats a tab switch as a pause: no change, and evidence starts over', () => {
    // Over budget for 1.5 s, hidden for 8 s, over budget again: the degrade needs settle + 2 s after the pause.
    const r = sim({}, gpu(30), 30_000, { inject: (_f, t) => (t > 2_500 && t < 2_540 ? 8_000 : null) });
    const pauseEnd = 2_500 + 8_000;
    expect(r.changes[0]!.reason).toBe('degrade');
    expect(r.changes[0]!.t).toBeGreaterThan(pauseEnd + 2_900);
    const fast = sim({}, () => 5, 20_000, { inject: (f) => (f === 300 ? 5_000 : null) });
    expect(fast.changes.filter((c) => c.reason !== 'probe')).toEqual([]);
  });

  it('treats a gap in the clock (samples not fed) as a pause', () => {
    let t = 0;
    const ctrl = new QualityController({ preset: 'auto', now: () => t });
    const feed = (ms: number, n: number): void => {
      for (let i = 0; i < n; i++) {
        t += ms;
        ctrl.sample(ms);
      }
    };
    feed(33.3, 75); // ~1.5 s over budget after settle
    t += 10_000; // map open: no samples
    feed(33.3, 40); // 1.3 s: not yet 2 s of fresh evidence
    expect(ctrl.level.name).toBe('high');
    feed(33.3, 60);
    expect(ctrl.level.name).toBe('medium');
  });

  for (const halfPeriodS of [4, 10, 20]) {
    it(`does not oscillate under a load that alternates every ${halfPeriodS} s`, () => {
      const load: Load = (l, t) => (Math.floor(t / (halfPeriodS * 1000)) % 2 === 0 ? gpu(30)(l, t) : gpu(8)(l, t));
      const r = sim({}, load, 15 * MIN);
      // Mostly at the level that holds the heavy phase; upgrades are probes that become ever rarer.
      expect(r.share('medium')).toBeGreaterThan(0.9);
      const probes = r.changes.filter((c) => c.reason === 'probe' && c.t > 90_000);
      for (let i = 1; i < probes.length; i++) expect(probes[i]!.t - probes[i - 1]!.t).toBeGreaterThan(120_000);
      expect(r.changes.length).toBeLessThanOrEqual(halfPeriodS === 20 ? 18 : 10);
    });
  }

  it('follows a slow load cycle (2 min heavy, 2 min light) without flipping in between', () => {
    const load: Load = (l, t) => (Math.floor(t / 120_000) % 2 === 0 ? gpu(30)(l, t) : gpu(8)(l, t));
    const r = sim({}, load, 16 * MIN);
    const levelAt = (t: number): QualityName => r.changes.filter((c) => c.t <= t).at(-1)?.to ?? 'high';
    for (let phase = 1; phase < 8; phase++) {
      const start = phase * 120_000;
      const end = start + 120_000;
      // Each phase ends at a level that suits it, with at most two changes on the way (no flipping in between).
      const heavy = phase % 2 === 0;
      if (heavy) expect(levelAt(end - 1)).toBe('medium');
      else expect(levelIndex(levelAt(end - 1))).toBeGreaterThanOrEqual(levelIndex('high'));
      expect(r.changes.filter((c) => c.t >= start && c.t < end).length).toBeLessThanOrEqual(2);
    }
  });

  it('does not oscillate under random load (invariants over many seeds)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = lcg(seed * 7919);
      // Piecewise-constant load: a new GPU cost every 1-20 s, between 4 and 60 ms at 'high'.
      let until = 0;
      let highMs = 10;
      const load: Load = (l, t) => {
        if (t >= until) {
          until = t + 1_000 + rnd() * 19_000;
          highMs = 4 + rnd() * 56;
        }
        return gpu(highMs)(l, t);
      };
      const r = sim({ minLevel: 'low' }, load, 10 * MIN, { seed });
      for (let i = 1; i < r.changes.length; i++) {
        // No change is ever decided on the frames right after another (settle + at least one bucket of evidence).
        expect(r.changes[i]!.t - r.changes[i - 1]!.t).toBeGreaterThan(QUALITY_TUNING.settleMs + QUALITY_TUNING.bucketMs);
      }
      expect(r.changes.length).toBeLessThan(40);
      for (const c of r.changes) expect(QUALITY_NAMES).toContain(c.to);
    }
  });

  it('recovers after the load drops', () => {
    const r = sim({}, (l, t) => (t < 30_000 ? gpu(30)(l, t) : gpu(5)(l, t)), 3 * MIN);
    expect(r.changes[0]).toMatchObject({ reason: 'degrade', to: 'medium' });
    const back = r.changes.find((c) => c.t > 30_000 && c.to === 'high');
    expect(back).toBeDefined();
    expect(back!.t - 30_000).toBeLessThan(40_000);
    expect(r.ctrl.level.name).toBe('ultra');
  });

  it('sceneChanged() lifts locks so a lighter scene is probed again soon', () => {
    let changed = false;
    const r = sim({}, (l, t) => (t < 120_000 ? gpu(30)(l, t) : gpu(5)(l, t)), 4 * MIN, {
      before: (ctrl, t) => {
        if (!changed && t >= 120_000) {
          changed = true;
          expect(ctrl.stats().locked).toEqual(['high']);
          ctrl.sceneChanged();
        }
      },
    });
    const back = r.changes.find((c) => c.t > 120_000 && c.to === 'high');
    expect(back).toBeDefined();
    expect(back!.t - 120_000).toBeLessThan(11_000);
  });

  it('undoes a degrade episode that does not help (CPU-bound) and stays put', () => {
    const r = sim({}, () => 25, 10 * MIN);
    expect(reasons(r.changes)).toEqual(['degrade:medium', 'degrade:low', 'ineffective:high']);
    expect(r.ctrl.level.name).toBe('high');
    expect(r.ctrl.stats().floor).toBe('high');
  });

  it('undoes a degrade on a 50 Hz display, where 20 ms frames are the refresh rate', () => {
    const r = sim({}, () => 5, 10 * MIN, { vsyncMs: 20, jitterMs: 0.6 });
    expect(reasons(r.changes)).toEqual(['degrade:medium', 'degrade:low', 'ineffective:high']);
  });

  it('releases a floor when frames get clearly worse', () => {
    // CPU-bound at 25 ms (floor at high), then GPU-bound and far slower.
    const r = sim({}, (l, t) => (t < 60_000 ? 25 : gpu(70)(l, t)), 2 * MIN);
    expect(r.changes.slice(0, 3).map((c) => c.reason)).toEqual(['degrade', 'degrade', 'ineffective']);
    expect(r.ctrl.level.name).toBe('low');
  });

  it('counts sustained very slow frames (not hitches) and drops to the minimum', () => {
    const r = sim({}, gpu(600), MIN);
    expect(r.changes[0]).toMatchObject({ reason: 'severe', to: 'low' });
    expect(r.ctrl.level.name).toBe('low');
  });

  it('recognises a frame rate under 1 fps (repeated pause-length frames are not pauses)', () => {
    const r = sim({}, gpu(1_500), 3 * MIN);
    expect(r.changes[0]).toMatchObject({ reason: 'severe', to: 'low' });
    expect(r.ctrl.level.name).toBe('low');
    // ...while a single long frame between normal ones is still a pause.
    const tab = sim({}, () => 5, MIN, { inject: (f) => (f === 200 || f === 400 ? 3_000 : null) });
    expect(tab.changes.filter((c) => c.reason !== 'probe')).toEqual([]);
  });

  it('never goes below minLevel', () => {
    const r = sim({ minLevel: 'medium' }, gpu(80), 5 * MIN);
    expect(r.changes[0]).toMatchObject({ to: 'medium' });
    expect(r.changes.every((c) => levelIndex(c.to) >= levelIndex('medium'))).toBe(true);
    expect(r.ctrl.level.name).toBe('medium');
  });

  it('pins a fixed preset and adapts again in auto from the current level', () => {
    let t = 0;
    const ctrl = new QualityController({ preset: 'low', now: () => t });
    expect(ctrl.level.name).toBe('low');
    for (let i = 0; i < 2_000; i++) {
      t += i % 2 ? 80 : 5;
      expect(ctrl.sample(i % 2 ? 80 : 5)).toBeNull();
    }
    expect(ctrl.level.name).toBe('low');
    expect(ctrl.stats().samples).toBeGreaterThan(10);
    ctrl.setPreset('high');
    expect(ctrl.level.name).toBe('high');
    expect(ctrl.lastChange).toMatchObject({ from: 'low', to: 'high', reason: 'preset' });
    for (let i = 0; i < 1_000; i++) {
      t += 50;
      expect(ctrl.sample(50)).toBeNull();
    }
    ctrl.setPreset('auto');
    expect(ctrl.level.name).toBe('high');
    let changed: QualityLevel | null = null;
    for (let i = 0; i < 300 && !changed; i++) {
      t += 33.3;
      changed = ctrl.sample(33.3);
    }
    expect(changed?.name).toBe('medium');
    expect(ctrl.preset).toBe('auto');
  });

  it('ignores invalid samples and reports stats over the recent window', () => {
    let t = 0;
    const ctrl = new QualityController({ preset: 'auto', now: () => t });
    for (const v of [NaN, -1, 0, Infinity]) expect(ctrl.sample(v)).toBeNull();
    for (let i = 0; i < 500; i++) {
      t += 10;
      ctrl.sample(i % 10 === 0 ? 30 : 10);
    }
    const s = ctrl.stats();
    expect(s.p50Ms).toBe(10);
    expect(s.p90Ms).toBe(10);
    expect(s.samples).toBeGreaterThan(150);
    expect(s.samples).toBeLessThanOrEqual(201);
    expect(s.level).toBe('high');
  });

  it('uses the target frame time', () => {
    // 30 fps target: 25 ms frames are within budget.
    const r = sim({ targetFrameMs: 33.3 }, () => 25, 2 * MIN, { vsyncMs: 0 });
    expect(r.changes.filter((c) => c.reason !== 'probe')).toEqual([]);
  });
});

describe('applyQuality', () => {
  function recorder(withSamples = true): { target: QualityTarget; calls: string[] } {
    const calls: string[] = [];
    const target: QualityTarget = {
      setRenderScale: (s, r) => calls.push(`scale ${s} ${r}`),
      setMsaa: (n) => calls.push(`msaa ${n}`),
      setBloom: (on) => calls.push(`bloom ${on}`),
      setTerrainErrorPx: (px) => calls.push(`terrain ${px}`),
      setCockpitQuality: (q) => calls.push(`cockpit ${q}`),
      setStarMagLimit: (m) => calls.push(`stars ${m}`),
      ...(withSamples ? { setViewSamples: (n: number) => calls.push(`samples ${n}`) } : {}),
    };
    return { target, calls };
  }

  it('applies every knob without a previous level', () => {
    const { target, calls } = recorder();
    const applied = applyQuality(target, qualityLevel('low'));
    expect(calls).toEqual(['scale 0.67 1', 'msaa 0', 'bloom false', 'terrain 6', 'cockpit low', 'stars 6.5', 'samples 6']);
    expect(applied).toHaveLength(8);
  });

  it('applies only what changed, and scale with its pixel-ratio cap', () => {
    const { target, calls } = recorder(false);
    applyQuality(target, qualityLevel('ultra'), qualityLevel('high'));
    expect(calls).toEqual(['scale 1 2', 'terrain 1.5', 'stars 8']);
    calls.length = 0;
    applyQuality(target, qualityLevel('high'), qualityLevel('high'));
    expect(calls).toEqual([]);
    applyQuality(target, qualityLevel('medium'), qualityLevel('low'));
    expect(calls).toEqual(['scale 0.85 1', 'bloom true', 'terrain 3', 'cockpit high', 'stars 7']);
  });
});

describe('benchmark statistics', () => {
  const frame = (ms: number, extra: Partial<BenchFrame> = {}): BenchFrame => ({ ms, drawCalls: 100, triangles: 200_000, ...extra });

  it('classifies p95 against the 60 and 30 fps budgets', () => {
    expect(verdictFor(16.7)).toBe('smooth');
    expect(verdictFor(16.71)).toBe('playable');
    expect(verdictFor(33.3)).toBe('playable');
    expect(verdictFor(33.31)).toBe('slow');
  });

  it('summarises a view: percentiles, means, invalid frames dropped, scene budgets per backend', () => {
    const frames = Array.from({ length: 100 }, (_, i) => frame(i + 1, { drawCalls: 350, triangles: 1_600_000, cpuMs: 2 }));
    frames.push(frame(NaN), frame(-1));
    const v = summarizeView('leo', frames, 1234.4, 'webgl2');
    expect(v).toMatchObject({ view: 'leo', frames: 100, loadMs: 1234, p50Ms: 50, p95Ms: 95, maxMs: 100, meanMs: 50.5, cpuP50Ms: 2, meanDrawCalls: 350, meanTriangles: 1_600_000, verdict: 'slow' });
    expect(v.overBudget).toEqual(['drawCalls', 'triangles']);
    // WebGPU allows 600 draw calls (TECH_PLAN Section 9); no CPU timings means cpuP50Ms is null.
    const w = summarizeView('leo', [frame(10, { drawCalls: 350 })], 0, 'webgpu');
    expect(w.overBudget).toEqual([]);
    expect(w.cpuP50Ms).toBeNull();
    expect(drawCallBudget('webgpu')).toBe(SCENE_BUDGET.drawCallsWebGpu);
    expect(drawCallBudget('webgl2')).toBe(SCENE_BUDGET.drawCallsWebGl2);
    expect(summarizeView('x', [], 0, 'webgpu')).toMatchObject({ frames: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, meanMs: 0 });
  });

  it('suggests the highest preset whose estimated p95 fits 60 fps', () => {
    const view = (p95Ms: number, cpuP50Ms: number | null = null): BenchViewResult => ({ ...summarizeView('v', [frame(p95Ms)], 0, 'webgpu'), cpuP50Ms });
    expect(suggestPreset([view(10)], 'high', 1)).toBe('high');
    expect(suggestPreset([view(10), view(25)], 'high', 1)).toBe('medium'); // GPU-bound: 25 ms x ~0.53
    expect(suggestPreset([view(40)], 'high', 1)).toBe('low');
    // CPU time does not scale with resolution: 12 ms CPU + 13 ms GPU needs 'low'.
    expect(suggestPreset([view(25, 12)], 'high', 1)).toBe('low');
    expect(suggestPreset([view(90, 80)], 'high', 1)).toBe('low');
    // Measured at 'low' with headroom: estimate upwards.
    expect(suggestPreset([view(8)], 'low', 1)).toBe('medium');
    expect(suggestPreset([view(4)], 'low', 1)).toBe('high');
    expect(estimateP95(view(20, 5), 'high', 'high', 1)).toBeCloseTo(20, 6);
    expect(suggestPreset([view(10)], null, 1)).toBe('high');
  });

  it('runs views in order, excludes warm-up frames, reports progress and builds the report', async () => {
    const calls: string[] = [];
    let clock = 0;
    let view = '';
    let n = 0;
    const driver: BenchDriver = {
      setView: (v) => {
        calls.push(`view ${v}`);
        view = v;
        n = 0;
      },
      waitIdle: () => {
        calls.push('idle');
        clock += 500;
        return Promise.resolve();
      },
      frame: () => {
        n++;
        clock += 10;
        // Warm-up frames are slow (compiles); measured frames depend on the view.
        const ms = n <= 3 ? 1000 : view === 'b' ? 40 : 10;
        return Promise.resolve(frame(ms, { cpuMs: 3, drawCalls: view === 'b' ? 700 : 50 }));
      },
      info: () => ({ backend: 'webgpu', adapter: 'test', dpr: 1, width: 1920, height: 1080 }),
    };
    const progress: string[] = [];
    const r = await runBench(driver, {
      views: ['a', 'b'],
      framesPerView: 20,
      warmup: 3,
      quality: 'high',
      synthetic: true,
      now: () => clock,
      date: () => new Date('2026-10-11T00:00:00Z'),
      onProgress: (p) => progress.push(`${p.view}:${p.phase}`),
    });
    expect(calls).toEqual(['view a', 'idle', 'view b', 'idle']);
    expect(r).toMatchObject({ format: BENCH_FORMAT, version: BENCH_VERSION, createdAt: '2026-10-11T00:00:00.000Z', quality: 'high', synthetic: true, framesPerView: 20, warmup: 3 });
    expect(r.durationMs).toBe(2 * 500 + 2 * 23 * 10);
    expect(r.views.map((v) => [v.view, v.frames, v.loadMs, v.p95Ms, v.maxMs, v.verdict])).toEqual([
      ['a', 20, 500, 10, 10, 'smooth'],
      ['b', 20, 500, 40, 40, 'slow'],
    ]);
    expect(r.views[1]!.overBudget).toEqual(['drawCalls']);
    expect(r.overall).toMatchObject({ worstView: 'b', verdict: 'slow', p50Ms: 10, maxMs: 40, suggestedPreset: 'low', budgets: { smoothMs: 16.7, playableMs: 33.3, drawCalls: 600, triangles: 1_500_000 } });
    expect(progress[0]).toBe('a:loading');
    expect(progress).toContain('a:warmup');
    expect(progress.filter((p) => p === 'b:measuring').length).toBeGreaterThan(1);
    expect(JSON.parse(reportJson(r))).toEqual(r);
  });

  it('uses the default route and stops when aborted', async () => {
    expect(DEFAULT_BENCH_VIEWS).toEqual(['leo', 'earth-low', 'moon-surface', 'earthrise', 'saturn', 'sun']);
    const ac = new AbortController();
    const seen: string[] = [];
    const driver: BenchDriver = {
      setView: (v) => seen.push(v),
      waitIdle: () => Promise.resolve(),
      frame: () => {
        if (seen.length === 2) ac.abort();
        return Promise.resolve(frame(10));
      },
      info: () => ({ backend: 'webgl2', adapter: '', dpr: 2, width: 100, height: 100 }),
    };
    await expect(runBench(driver, { framesPerView: 2, warmup: 0, signal: ac.signal })).rejects.toThrow(/aborted/);
    expect(seen).toEqual(['leo', 'earth-low']);
    const r = await runBench({ ...driver, frame: () => Promise.resolve(frame(10)) }, { framesPerView: 1, warmup: 0 });
    expect(r.views.map((v) => v.view)).toEqual(DEFAULT_BENCH_VIEWS);
    expect(r.quality).toBeNull();
    expect(r.synthetic).toBeUndefined();
  });

  it('has a message for every benchmark string the panel builds from data', () => {
    for (const v of DEFAULT_BENCH_VIEWS) expect(t(`quality.view.${v}`)).not.toBe(`quality.view.${v}`);
    for (const n of QUALITY_NAMES) expect(t(`quality.level.${n}`)).not.toBe(`quality.level.${n}`);
    for (const v of ['smooth', 'playable', 'slow']) {
      expect(t(`quality.bench.verdict.${v}`)).not.toBe(`quality.bench.verdict.${v}`);
      expect(t(`quality.bench.verdict.${v}.desc`)).not.toBe(`quality.bench.verdict.${v}.desc`);
    }
    for (const p of ['loading', 'warmup', 'measuring']) expect(t(`quality.bench.phase.${p}`)).not.toBe(`quality.bench.phase.${p}`);
    expect(viewLabel('earth-low')).toBe('Low over the Himalaya');
    expect(viewLabel('body:599')).toBe('body:599');
  });
});
