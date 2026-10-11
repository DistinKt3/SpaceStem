/**
 * Benchmark panel demo (bench.html): runs runBench() against a synthetic driver (deterministic made-up frame times,
 * clearly labelled as sample data) and shows the progress card and the results dialog. DOM only, so page screenshots
 * work. Exposes window.__ks for tests/e2e/bench.spec.ts.
 *
 * URL parameters: profile=mixed|smooth|slow, hold=progress (stop at the progress card), textScale=<0.8..2>,
 * colorblind=<mode>, reducedMotion=1, frames=<n> (measured frames per view, 1..2000). Unknown or out-of-range values
 * fall back to the defaults, so a hostile URL cannot break the page or freeze it.
 */
import '../game/styles.css';
import '../game/ui/ui.css';
import { BenchPanel, clampCount, runBench, type BenchDriver, type BenchFrame, type BenchProgress, type BenchReport } from '../game/bench/bench';
import { COLORBLIND_MODES, Settings, type ColorblindMode } from '../game/settings/settings';
import { t } from '../game/i18n';

type Profile = 'mixed' | 'smooth' | 'slow';

const PROFILE_NAMES: readonly Profile[] = ['mixed', 'smooth', 'slow'];
/** Measured frames per view on this page (the synthetic driver resolves at once, so this bounds the page's work). */
const DEMO_FRAMES = { default: 180, min: 1, max: 2_000 } as const;

/** The profile a URL value names, or 'mixed'. */
export function profileParam(v: string | null): Profile {
  return v !== null && (PROFILE_NAMES as readonly string[]).includes(v) ? (v as Profile) : 'mixed';
}

/** Frames per view from a URL value: a whole number in 1..2000, else 180 (also for Infinity, NaN or a missing value). */
export function framesParam(v: string | null): number {
  return clampCount(v === null || v.trim() === '' ? undefined : Number(v), DEMO_FRAMES);
}

const params = new URLSearchParams(location.search);
const settings = new Settings({ storage: null });
const ts = Number(params.get('textScale'));
if (ts) settings.set({ textScale: ts });
const cb = params.get('colorblind');
if (cb && (COLORBLIND_MODES as readonly string[]).includes(cb)) settings.set({ colorblind: cb as ColorblindMode });
if (params.get('reducedMotion') === '1') settings.set({ reducedMotion: true });
settings.applyToDocument();

/** Deterministic uniform [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- Static sky backdrop -------------------------------------------------------------------------------------------

function drawSky(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = innerWidth;
  const h = innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#02040a');
  bg.addColorStop(1, '#060c1a');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const glow = g.createRadialGradient(w * 0.25, h * 0.2, 0, w * 0.25, h * 0.2, Math.max(w, h) * 0.6);
  glow.addColorStop(0, 'rgba(90, 120, 200, 0.18)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, w, h);
  const rnd = lcg(0x51a7);
  const n = Math.round((w * h) / 1100);
  for (let i = 0; i < n; i++) {
    const m = rnd() ** 3;
    g.fillStyle = `rgba(${200 + rnd() * 55}, ${210 + rnd() * 45}, 255, ${0.25 + m * 0.75})`;
    g.beginPath();
    g.arc(rnd() * w, rnd() * h, 0.35 + m * 1.3, 0, Math.PI * 2);
    g.fill();
  }
  // A ringed planet low on the left, so the glass has something bright behind it.
  const cx = w * 0.12;
  const cy = h * 0.92;
  const R = Math.min(w, h) * 0.32;
  const ring = (from: number, to: number): void => {
    g.strokeStyle = 'rgba(230, 210, 170, 0.4)';
    g.lineWidth = R * 0.05;
    g.beginPath();
    g.ellipse(cx, cy, R * 1.9, R * 0.42, -0.25, from, to);
    g.stroke();
  };
  ring(Math.PI, Math.PI * 2); // far side of the ring, behind the planet
  const body = g.createRadialGradient(cx + R * 0.35, cy - R * 0.45, R * 0.1, cx, cy, R);
  body.addColorStop(0, '#f3dfb4');
  body.addColorStop(0.6, '#a07d4c');
  body.addColorStop(1, '#2a1f12');
  g.fillStyle = body;
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fill();
  ring(0, Math.PI); // near side, in front
}

// --- Synthetic driver ----------------------------------------------------------------------------------------------

/** Made-up per-view frame costs (ms at p50), draw calls and triangles for each profile. */
const PROFILES: Record<Profile, Record<string, { ms: number; draws: number; tris: number }>> = {
  mixed: {
    leo: { ms: 9.2, draws: 182, tris: 640_000 },
    'earth-low': { ms: 19.5, draws: 340, tris: 1_620_000 },
    'earth-descent': { ms: 22.8, draws: 362, tris: 1_540_000 },
    'moon-surface': { ms: 14.1, draws: 236, tris: 1_180_000 },
    earthrise: { ms: 12.6, draws: 214, tris: 910_000 },
    saturn: { ms: 7.4, draws: 96, tris: 310_000 },
    sun: { ms: 6.1, draws: 71, tris: 180_000 },
  },
  smooth: {
    leo: { ms: 5.1, draws: 182, tris: 640_000 },
    'earth-low': { ms: 8.9, draws: 288, tris: 1_310_000 },
    'earth-descent': { ms: 10.4, draws: 301, tris: 1_250_000 },
    'moon-surface': { ms: 7.2, draws: 236, tris: 1_080_000 },
    earthrise: { ms: 6.6, draws: 214, tris: 910_000 },
    saturn: { ms: 4.2, draws: 96, tris: 310_000 },
    sun: { ms: 3.8, draws: 71, tris: 180_000 },
  },
  slow: {
    leo: { ms: 24, draws: 182, tris: 640_000 },
    'earth-low': { ms: 46, draws: 340, tris: 1_620_000 },
    'earth-descent': { ms: 52, draws: 362, tris: 1_540_000 },
    'moon-surface': { ms: 35, draws: 236, tris: 1_180_000 },
    earthrise: { ms: 31, draws: 214, tris: 910_000 },
    saturn: { ms: 18, draws: 96, tris: 310_000 },
    sun: { ms: 15, draws: 71, tris: 180_000 },
  },
};

export function syntheticDriver(profile: Profile, opts: { idleMs?: number } = {}): BenchDriver {
  const table = PROFILES[profileParam(profile)];
  const rnd = lcg(profile.length * 7919 + 17);
  let view = 'leo';
  return {
    setView(name) {
      view = name;
    },
    waitIdle: () => new Promise((resolve) => setTimeout(resolve, opts.idleMs ?? 140)),
    frame(): Promise<BenchFrame> {
      const v = table[view] ?? { ms: 10, draws: 120, tris: 400_000 };
      // Log-normal-ish spread around the median plus rare hitches: a realistic shape for frame times.
      const spread = Math.exp((rnd() + rnd() + rnd() - 1.5) * 0.18);
      const hitch = rnd() < 0.015 ? 1.6 + rnd() * 1.4 : 1;
      const ms = v.ms * spread * hitch;
      return Promise.resolve({ ms, cpuMs: Math.min(ms, 2.2 + rnd() * 0.8), drawCalls: v.draws + Math.round(rnd() * 6), triangles: Math.round(v.tris * (0.98 + rnd() * 0.04)) });
    },
    info: () => ({ backend: 'webgpu', adapter: 'Synthetic GPU (demo)', dpr: 1.25, width: 1920, height: 1080 }),
  };
}

// --- Page ----------------------------------------------------------------------------------------------------------

const sky = document.getElementById('sky') as HTMLCanvasElement;
drawSky(sky);
addEventListener('resize', () => drawSky(sky));

const panel = new BenchPanel(document.body);
const state: { report: BenchReport | null; progress: BenchProgress[]; closed: number; running: boolean } = { report: null, progress: [], closed: 0, running: false };
panel.onClose = () => {
  state.closed++;
  rerun.hidden = false;
};

const rerun = document.getElementById('rerun') as HTMLButtonElement;
rerun.textContent = t('quality.bench.runAgain');
rerun.hidden = true;

// Read and validated once: the first run and every "Run again" use the same values.
const profile = profileParam(params.get('profile'));
const frames = framesParam(params.get('frames'));

async function run(which: Profile = profile, extra: { hold?: boolean; frames?: number } = {}): Promise<BenchReport | null> {
  state.running = true;
  state.progress = [];
  rerun.hidden = true;
  const driver = syntheticDriver(which, { idleMs: extra.hold ? 1e9 : 140 });
  const report = await runBench(driver, {
    framesPerView: clampCount(extra.frames ?? frames, DEMO_FRAMES),
    warmup: 20,
    quality: 'high',
    synthetic: true,
    date: () => new Date('2026-10-11T12:00:00Z'),
    onProgress: (p) => {
      state.progress.push(p);
      panel.progress(p);
    },
  });
  state.running = false;
  state.report = report;
  panel.show(report);
  return report;
}

rerun.addEventListener('click', () => void run(profile, { frames }));

(window as unknown as { __ks: unknown }).__ks = { panel, state, run, settings };

void run(profile, { hold: params.get('hold') === 'progress', frames });
