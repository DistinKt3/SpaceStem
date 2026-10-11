/**
 * Owner benchmark (`?bench=1`, TECH_PLAN Section 9): visits a fixed list of named views, waits for each to finish
 * loading, renders warm-up frames, then measures a fixed number of frames and reports frame-time percentiles, draw calls
 * and triangles per view, with an overall verdict against the 60 fps and 30 fps budgets and a suggested preset.
 *
 * The benchmark talks to the game through BenchDriver, so the statistics are testable with a synthetic driver and the
 * results panel can be shown on a DOM-only demo page (bench.html). The game's driver is in appBench.ts.
 */
import { QUALITY_NAMES, percentileSorted, qualityLevel, relativeCost, type QualityName } from '../../render/quality/quality';

export { BenchPanel } from './benchPanel';

/** Default route: orbit, low over terrain, standing on the Moon, Earthrise, a ringed giant, and the Sun up close. */
export const DEFAULT_BENCH_VIEWS: readonly string[] = ['leo', 'earth-low', 'moon-surface', 'earthrise', 'saturn', 'sun'];

/** Frame budgets (ms): 60 fps and 30 fps. */
export const FRAME_BUDGET = { smoothMs: 16.7, playableMs: 33.3 } as const;

/** Scene budgets from TECH_PLAN Section 9 (integrated laptop GPU, 1080p). */
export const SCENE_BUDGET = { drawCallsWebGpu: 600, drawCallsWebGl2: 300, triangles: 1_500_000 } as const;

export const BENCH_FORMAT = 'known-sky-bench';
export const BENCH_VERSION = 1;

export interface BenchFrame {
  /** Frame cost in ms (the game's driver: start of the frame's work until the GPU has finished it). */
  ms: number;
  drawCalls: number;
  triangles: number;
  /** CPU part of `ms` when the driver can tell (main-thread time of the frame). */
  cpuMs?: number;
}

export interface BenchInfo {
  backend: string;
  adapter: string;
  dpr: number;
  /** Canvas size in device pixels. */
  width: number;
  height: number;
  userAgent?: string;
}

export interface BenchDriver {
  setView(name: string): void;
  /** Resolves when the view has finished streaming (or the driver gives up waiting). */
  waitIdle(): Promise<void>;
  /** Renders and times one frame. */
  frame(): Promise<BenchFrame>;
  info(): BenchInfo;
}

export type BenchVerdict = 'smooth' | 'playable' | 'slow';
export type SuggestedPreset = 'low' | 'medium' | 'high';

export interface BenchViewResult {
  view: string;
  /** Frames measured (after warm-up, excluding invalid samples). */
  frames: number;
  /** Time waitIdle() took (streaming), ms. */
  loadMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
  /** Median CPU time, when the driver reports it. */
  cpuP50Ms: number | null;
  meanDrawCalls: number;
  meanTriangles: number;
  verdict: BenchVerdict;
  /** Scene budgets exceeded on average. */
  overBudget: ('drawCalls' | 'triangles')[];
}

export interface BenchReport {
  format: typeof BENCH_FORMAT;
  version: typeof BENCH_VERSION;
  /** ISO 8601 time the run finished. */
  createdAt: string;
  info: BenchInfo;
  /** Quality level the run was measured at (null when unknown). */
  quality: QualityName | null;
  framesPerView: number;
  warmup: number;
  durationMs: number;
  /** True when the numbers were made up (demo pages, tests), not measured. */
  synthetic?: true;
  views: BenchViewResult[];
  overall: {
    /** Over all measured frames of all views. */
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    /** View with the highest p95. */
    worstView: string;
    /** Verdict of the worst view. */
    verdict: BenchVerdict;
    /** Highest preset whose estimated p95 fits 60 fps in every view (an estimate: see suggestPreset). */
    suggestedPreset: SuggestedPreset;
    budgets: { smoothMs: number; playableMs: number; drawCalls: number; triangles: number };
  };
}

export type BenchPhase = 'loading' | 'warmup' | 'measuring';

export interface BenchProgress {
  view: string;
  /** 0-based view index. */
  index: number;
  total: number;
  phase: BenchPhase;
  /** Frames done in this phase, and the phase's frame count. */
  frame: number;
  frames: number;
}

export interface BenchOptions {
  views?: readonly string[];
  /** Measured frames per view. Default 240. */
  framesPerView?: number;
  /** Unmeasured frames per view after loading (shader compiles, LOD settling). Default 30. */
  warmup?: number;
  /** Quality level in use, recorded in the report and used for the preset suggestion. */
  quality?: QualityName;
  onProgress?: (p: BenchProgress) => void;
  signal?: AbortSignal;
  /** Clock (ms). Default performance.now. */
  now?: () => number;
  /** Wall-clock time for createdAt. Default new Date(). */
  date?: () => Date;
  /** Mark the report as synthetic (a fake driver): the panel and the JSON say so. */
  synthetic?: boolean;
}

export function verdictFor(p95Ms: number): BenchVerdict {
  if (p95Ms <= FRAME_BUDGET.smoothMs) return 'smooth';
  if (p95Ms <= FRAME_BUDGET.playableMs) return 'playable';
  return 'slow';
}

export function drawCallBudget(backend: string): number {
  return backend === 'webgpu' ? SCENE_BUDGET.drawCallsWebGpu : SCENE_BUDGET.drawCallsWebGl2;
}

const round = (v: number, digits: number): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

/** Statistics for one view. Frames with a non-finite or negative time are dropped. */
export function summarizeView(view: string, frames: readonly BenchFrame[], loadMs: number, backend: string): BenchViewResult {
  const valid = frames.filter((f) => Number.isFinite(f.ms) && f.ms >= 0);
  const ms = Float64Array.from(valid, (f) => f.ms).sort();
  const cpu = Float64Array.from(
    valid.filter((f) => f.cpuMs !== undefined && Number.isFinite(f.cpuMs)),
    (f) => f.cpuMs!,
  ).sort();
  const n = valid.length;
  const mean = (get: (f: BenchFrame) => number): number => (n ? valid.reduce((s, f) => s + get(f), 0) / n : 0);
  const p95 = percentileSorted(ms, 0.95);
  const meanDrawCalls = Math.round(mean((f) => f.drawCalls));
  const meanTriangles = Math.round(mean((f) => f.triangles));
  const overBudget: BenchViewResult['overBudget'] = [];
  if (meanDrawCalls > drawCallBudget(backend)) overBudget.push('drawCalls');
  if (meanTriangles > SCENE_BUDGET.triangles) overBudget.push('triangles');
  return {
    view,
    frames: n,
    loadMs: round(Math.max(0, loadMs), 0),
    p50Ms: round(percentileSorted(ms, 0.5), 2),
    p95Ms: round(p95, 2),
    maxMs: round(n ? ms[n - 1]! : 0, 2),
    meanMs: round(mean((f) => f.ms), 2),
    cpuP50Ms: cpu.length ? round(percentileSorted(cpu, 0.5), 2) : null,
    meanDrawCalls,
    meanTriangles,
    verdict: verdictFor(p95),
    overBudget,
  };
}

/**
 * Estimated p95 of a view at another level: the CPU part stays, the GPU part scales with relativeCost (pixel count,
 * MSAA, bloom, atmosphere samples). Without CPU timings the whole frame is assumed GPU-bound.
 */
export function estimateP95(v: BenchViewResult, measuredAt: QualityName, at: QualityName, dpr: number): number {
  const cpu = Math.min(v.cpuP50Ms ?? 0, v.p95Ms);
  const ratio = relativeCost(qualityLevel(at), dpr) / relativeCost(qualityLevel(measuredAt), dpr);
  return cpu + (v.p95Ms - cpu) * ratio;
}

/**
 * The highest preset whose estimated p95 fits the 60 fps budget in every view; 'low' when none does. An estimate from a
 * simple cost model, not a measurement: 'auto' measures while you play and is the better default.
 */
export function suggestPreset(views: readonly BenchViewResult[], measuredAt: QualityName | null, dpr: number): SuggestedPreset {
  const from = measuredAt ?? 'high';
  const presets: SuggestedPreset[] = ['high', 'medium', 'low'];
  for (const p of presets) {
    if (views.every((v) => estimateP95(v, from, p, dpr) <= FRAME_BUDGET.smoothMs)) return p;
  }
  return 'low';
}

function abortError(): Error {
  const e = new Error('Benchmark aborted');
  e.name = 'AbortError';
  return e;
}

/** Runs the benchmark. Views run one after another; the report is built from the measured frames only. */
export async function runBench(driver: BenchDriver, opts: BenchOptions = {}): Promise<BenchReport> {
  const views = [...(opts.views ?? DEFAULT_BENCH_VIEWS)];
  const framesPerView = Math.max(1, Math.round(opts.framesPerView ?? 240));
  const warmup = Math.max(0, Math.round(opts.warmup ?? 30));
  const now = opts.now ?? (() => performance.now());
  const quality = opts.quality && QUALITY_NAMES.includes(opts.quality) ? opts.quality : null;
  const check = (): void => {
    if (opts.signal?.aborted) throw abortError();
  };
  const t0 = now();
  const info = { ...driver.info() };
  const results: BenchViewResult[] = [];
  const all: number[] = [];
  const progressEvery = Math.max(1, Math.round(framesPerView / 24));
  for (const [index, view] of views.entries()) {
    const progress = (phase: BenchPhase, frame: number, frames: number): void => opts.onProgress?.({ view, index, total: views.length, phase, frame, frames });
    check();
    progress('loading', 0, 0);
    driver.setView(view);
    const l0 = now();
    await driver.waitIdle();
    const loadMs = now() - l0;
    for (let i = 0; i < warmup; i++) {
      check();
      await driver.frame();
      if (i % progressEvery === 0) progress('warmup', i + 1, warmup);
    }
    const frames: BenchFrame[] = [];
    for (let i = 0; i < framesPerView; i++) {
      check();
      frames.push(await driver.frame());
      if ((i + 1) % progressEvery === 0 || i + 1 === framesPerView) progress('measuring', i + 1, framesPerView);
    }
    const r = summarizeView(view, frames, loadMs, info.backend);
    results.push(r);
    for (const f of frames) if (Number.isFinite(f.ms) && f.ms >= 0) all.push(f.ms);
  }
  const sorted = Float64Array.from(all).sort();
  let worst = results[0];
  for (const r of results) if (worst === undefined || r.p95Ms > worst.p95Ms) worst = r;
  return {
    format: BENCH_FORMAT,
    version: BENCH_VERSION,
    createdAt: (opts.date?.() ?? new Date()).toISOString(),
    info,
    quality,
    framesPerView,
    warmup,
    durationMs: Math.round(now() - t0),
    ...(opts.synthetic ? { synthetic: true as const } : {}),
    views: results,
    overall: {
      p50Ms: round(percentileSorted(sorted, 0.5), 2),
      p95Ms: round(percentileSorted(sorted, 0.95), 2),
      maxMs: round(sorted.length ? sorted[sorted.length - 1]! : 0, 2),
      worstView: worst?.view ?? '',
      verdict: worst?.verdict ?? 'slow',
      suggestedPreset: suggestPreset(results, quality, info.dpr),
      budgets: { smoothMs: FRAME_BUDGET.smoothMs, playableMs: FRAME_BUDGET.playableMs, drawCalls: drawCallBudget(info.backend), triangles: SCENE_BUDGET.triangles },
    },
  };
}

/** Pretty JSON for copying and downloading. */
export function reportJson(report: BenchReport): string {
  return JSON.stringify(report, null, 2);
}
