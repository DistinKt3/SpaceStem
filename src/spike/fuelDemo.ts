/**
 * Fuel lab (fuel.html): the hyper-fuel and star-scooping model (src/game/ship/fuel.ts) with the HUD gauge, for four
 * real stars. Sliders pick the star, the distance in stellar radii, the throttle and the next jump; the model runs
 * live; charts show scoop rate, equilibrium heat and jump cost. DOM and 2D canvas only (no WebGPU).
 *
 * Star values are measured (sources in the page and in docs/FUEL.md). The fuel mechanic itself is fiction and the
 * page says so. Exposes window.__ksFuel for tests/e2e/fuel.spec.ts.
 *
 * URL parameters: star=0..3|sun|alphaCenA|proxima|siriusA, r=<stellar radii>, throttle=0..1, fuel=0..1, heat=0..1,
 * jump=<ly>|none, paused=1, speed=1|5|20, climb=0 (no automatic emergency climb), colorblind=<mode>,
 * textScale=0.8..2, reducedMotion=1|0.
 */
import '../game/styles.css';
import '../game/ui/ui.css';
import { LIGHT_YEAR_M, PARSEC_M, SUN_RADIUS_M } from '../core/constants';
import { formatDistance, formatDuration } from '../game/format';
import { formatNumber, t } from '../game/i18n';
import { bindingLabel } from '../game/input/labels';
import type { Binding } from '../game/input/bindings';
import { COLORBLIND_MODES, Settings, type ColorblindMode } from '../game/settings/settings';
import {
  FUEL,
  FuelSystem,
  distanceForFlux,
  equilibriumHeat,
  fluxForHeat,
  fluxSolar,
  inScoopBand,
  jumpCost,
  rangeFor,
  scoopRate,
  type FuelEvent,
  type StarEnv,
} from '../game/ship/fuel';
import { FuelGauge } from '../game/ship/fuelGauge';

// --- Data ----------------------------------------------------------------------------------------------------------

interface StarDef {
  key: 'sun' | 'alphaCenA' | 'proxima' | 'siriusA';
  radiusSun: number;
  luminositySun: number;
  teffK: number;
}

/**
 * Measured values:
 * - Sun: IAU 2015 Resolution B3 nominal R, L, T_eff (Prša et al. 2016, AJ 152, 41).
 * - alpha Cen A: R = 1.2234 +/- 0.0053 R_sun (VLTI/PIONIER), L = 1.521 +/- 0.015 L_sun, T_eff = 5795 +/- 19 K
 *   (Kervella et al. 2017, A&A 597, A137, Sect. 4.3).
 * - Proxima Centauri: R = 0.146 +/- 0.007 R_sun, L = 0.00151 +/- 0.00008 L_sun, T_eff = 2980 +/- 80 K
 *   (Ribas et al. 2017, A&A 603, A58).
 * - Sirius A: R = 1.713 +/- 0.009 R_sun (SUSI + VLTI), L = 24.7 +/- 0.7 L_sun, T_eff = 9845 +/- 64 K
 *   (Davis et al. 2011, PASA 28, 58).
 */
const STARS: readonly StarDef[] = [
  { key: 'sun', radiusSun: 1, luminositySun: 1, teffK: 5772 },
  { key: 'alphaCenA', radiusSun: 1.2234, luminositySun: 1.521, teffK: 5795 },
  { key: 'proxima', radiusSun: 0.146, luminositySun: 0.00151, teffK: 2980 },
  { key: 'siriusA', radiusSun: 1.713, luminositySun: 24.7, teffK: 9845 },
];

/** Distances from parallaxes: alpha Cen 747.17 mas (Kervella et al. 2016), Sirius 379.21 mas (van Leeuwen 2007). */
const lyFromParallaxMas = (mas: number): number => ((1000 / mas) * PARSEC_M) / LIGHT_YEAR_M;
const PRESETS: readonly { key: string; ly: number | null }[] = [
  { key: 'alphaCen', ly: lyFromParallaxMas(747.17) },
  { key: 'sirius', ly: lyFromParallaxMas(379.21) },
  { key: 'range', ly: FUEL.rangeLy },
  { key: 'none', ly: null },
];

const R_MIN = 1.05;
const R_MAX = 100;
const SPEEDS = [1, 5, 20] as const;
/** Simulation step for the model (s); matches FUEL.maxSubstepS. */
const STEP = 0.1;

// --- State and URL parameters ----------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const num = (k: string, lo: number, hi: number, fallback: number): number => {
  const v = Number(params.get(k));
  return params.has(k) && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};
const starParam = params.get('star');
const starIndex = Math.max(
  0,
  starParam === null ? 0 : /^\d$/.test(starParam) ? Math.min(3, Number(starParam)) : STARS.findIndex((s) => s.key === starParam),
);

const settings = new Settings({ autoSave: false });
const cb = params.get('colorblind');
if (cb && (COLORBLIND_MODES as readonly string[]).includes(cb)) settings.set({ colorblind: cb as ColorblindMode });
if (params.has('textScale')) settings.set({ textScale: num('textScale', 0.8, 2, 1) });
if (params.has('reducedMotion')) settings.set({ reducedMotion: params.get('reducedMotion') === '1' });
settings.applyToDocument();

const jumpParam = params.get('jump');
const state = {
  star: starIndex,
  radii: num('r', R_MIN, R_MAX, 4),
  throttle: num('throttle', 0, 1, 1),
  jumpLy: jumpParam === 'none' ? null : num('jump', 0, 80, PRESETS[0]!.ly!),
  speed: SPEEDS.includes(Number(params.get('speed')) as 1) ? Number(params.get('speed')) : 1,
  running: params.get('paused') !== '1',
  autoClimb: params.get('climb') !== '0',
  simTime: 0,
  /** Emergency climb in progress: target distance (stellar radii), or null. */
  climbTo: null as number | null,
};
const fuel = new FuelSystem({ hyperFuel: num('fuel', 0, 1, 0.35), heat: num('heat', 0, 1, 0) });
const eventLog: { time: number; event: FuelEvent }[] = [];

const star = (): StarDef => STARS[state.star]!;
const radiusM = (s: StarDef = star()): number => s.radiusSun * SUN_RADIUS_M;
const envAt = (radii: number, s: StarDef = star()): StarEnv => ({
  distanceM: radii * radiusM(s),
  radiusM: radiusM(s),
  luminositySun: s.luminositySun,
  teffK: s.teffK,
});
/** Distance (stellar radii) where the flux equals `flux`, for the current star. */
const radiiForFlux = (flux: number): number => distanceForFlux(envAt(1), flux) / radiusM();
const ratePerMin = (radii: number): number => scoopRate(fluxSolar(envAt(radii)), state.throttle) * 6000;

// --- DOM helpers -----------------------------------------------------------------------------------------------------

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  e.append(...children);
  return e;
}

function slider(id: string, label: string, min: number, max: number, step: number, value: number): { wrap: HTMLDivElement; input: HTMLInputElement; out: HTMLOutputElement } {
  const input = h('input', { id, type: 'range', min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  const out = h('output', { for: id });
  const wrap = h('div', { class: 'ctl' }, h('label', { for: id, text: label }), out, input);
  return { wrap, input, out };
}

function paintRange(input: HTMLInputElement): void {
  const p = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
  input.style.setProperty('--p', `${p}%`);
}

const fmt = (v: number, frac = 0): string => formatNumber(v, frac, frac);
/** Three significant figures (at least), without exponent notation. */
const sig = (v: number): string => (v >= 100 ? fmt(v) : v >= 10 ? fmt(v, 1) : v >= 1 || v === 0 ? fmt(v, 2) : fmt(v, Math.min(8, 2 - Math.floor(Math.log10(v)))));

// --- Layout ----------------------------------------------------------------------------------------------------------

document.title = `Known Sky: ${t('fuel.demo.title')}`;
const app = document.getElementById('app')!;

const mark = h('div', { class: 'lab-mark', 'aria-hidden': 'true' });
mark.innerHTML =
  '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2 3" opacity="0.6"/><path d="M27 9 20.5 13.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const simTimeEl = h('span', { class: 'simtime', 'aria-hidden': 'true' });
const runBtn = h('button', { class: 'btn', type: 'button', 'aria-pressed': 'false' });
const speedBtns = SPEEDS.map((s) => h('button', { class: 'btn', type: 'button', 'data-speed': String(s), text: t('fuel.demo.speedValue', { v: s }) }));
app.append(
  h(
    'header',
    { class: 'lab-head' },
    h(
      'div',
      { class: 'lab-title' },
      mark,
      h('div', {}, h('h1', {}, 'Known Sky · ', h('span', { class: 'accent', text: t('fuel.demo.title') })), h('p', { text: t('fuel.demo.subtitle') })),
    ),
    h(
      'div',
      { class: 'lab-actions' },
      h('span', { class: 'pill', text: t('fuel.demo.fiction') }),
      simTimeEl,
      h('div', { class: 'btns three', role: 'group', 'aria-label': t('fuel.demo.speed') }, ...speedBtns),
      runBtn,
    ),
  ),
);

const grid = h('main', { class: 'grid' });
app.append(grid);

// Controls.
const starCtl = slider('star', t('fuel.demo.star'), 0, STARS.length - 1, 1, state.star);
const starStats = h('div', { class: 'star-stats' });
starCtl.wrap.append(starStats);
const toSlider = (r: number): number => Math.round((1000 * Math.log10(r / R_MIN)) / Math.log10(R_MAX / R_MIN));
const fromSlider = (v: number): number => R_MIN * Math.pow(R_MAX / R_MIN, v / 1000);
const distCtl = slider('distance', t('fuel.demo.distance'), 0, 1000, 1, toSlider(state.radii));
const distHint = h('div', { class: 'hint' });
distCtl.wrap.append(distHint);
const thrCtl = slider('throttle', t('fuel.demo.throttle'), 0, 100, 1, Math.round(state.throttle * 100));
const jumpCtl = slider('jump', t('fuel.demo.jumpDistance'), 0, 60, 0.05, state.jumpLy ?? 0);
const presetBtns = PRESETS.map((p) => h('button', { class: 'btn', type: 'button', 'data-preset': p.key, text: t(`fuel.demo.preset.${p.key}`) }));
const jumpBtn = h('button', { class: 'btn primary', type: 'button', id: 'jump-btn' });
const flash = h('div', { class: 'flash', role: 'status', 'aria-live': 'polite' });
const fillBtn = h('button', { class: 'btn', type: 'button', text: t('fuel.demo.fill') });
const drainBtn = h('button', { class: 'btn', type: 'button', text: t('fuel.demo.drain') });
const coolBtn = h('button', { class: 'btn', type: 'button', text: t('fuel.demo.cool') });

grid.append(
  h(
    'section',
    { class: 'col col-controls' },
    h(
      'div',
      { class: 'panel' },
      h('h2', { text: t('fuel.demo.star') }),
      starCtl.wrap,
      distCtl.wrap,
      thrCtl.wrap,
      h('div', { class: 'sub-h', text: t('fuel.demo.jumpDistance') }),
      jumpCtl.wrap,
      h('div', { class: 'btns', role: 'group', 'aria-label': t('fuel.demo.jumpPresets') }, ...presetBtns),
      h('div', { style: 'margin-top:0.5rem' }, jumpBtn),
      flash,
      h('div', { class: 'btns three', style: 'margin-top:0.35rem' }, fillBtn, drainBtn, coolBtn),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', { text: t('fuel.demo.sources') }),
      h(
        'ul',
        { class: 'sources' },
        ...['sun', 'alphaCenA', 'proxima', 'siriusA', 'parallax', 'flux'].map((k) => h('li', { text: t(`fuel.demo.src.${k}`) })),
      ),
      h('p', { class: 'note', text: t('fuel.demo.sourcesNote') }),
    ),
  ),
);
jumpBtn.style.width = '100%';

// Preview with the live gauge.
const previewCanvas = h('canvas', { 'aria-hidden': 'true' });
const preview = h('div', { class: 'preview' }, previewCanvas);
const gauge = new FuelGauge(preview, { placement: 'hud' });
preview.append(h('div', { class: 'preview-tag', text: t('fuel.demo.previewNote') }));

const ro = (key: string): { el: HTMLDivElement; v: HTMLDivElement; s: HTMLDivElement } => {
  const v = h('div', { class: 'v' });
  const s = h('div', { class: 's' });
  const el = h('div', { class: 'ro', 'data-ro': key }, h('div', { class: 'k', text: t(`fuel.demo.${key}`) }), v, s);
  return { el, v, s };
};
const roFlux = ro('flux');
const roBand = ro('band');
const roRate = ro('rate');
const roHeat = ro('eqHeat');
const logList = h('ol', { class: 'log', 'aria-label': t('fuel.demo.events') });

grid.append(
  h(
    'section',
    { class: 'col col-preview' },
    h('div', { class: 'panel' }, h('h2', { text: t('fuel.demo.preview') }), preview),
    h('div', { class: 'panel' }, h('h2', { text: t('fuel.demo.readouts') }), h('div', { class: 'readouts' }, roFlux.el, roBand.el, roRate.el, roHeat.el)),
    h('div', { class: 'panel' }, h('h2', { text: t('fuel.demo.events') }), logList),
  ),
);

// Charts.
interface ChartBox {
  canvas: HTMLCanvasElement;
  tip: HTMLDivElement;
  hover: number | null;
}
function chartPanel(key: string, axis: string): { panel: HTMLDivElement; box: ChartBox } {
  const canvas = h('canvas', { role: 'img', 'aria-label': `${t(`fuel.demo.${key}`)}. ${t(`fuel.demo.${key}Sub`)}` });
  const tip = h('div', { class: 'tip' });
  const wrap = h('div', { class: 'chart' }, canvas, tip);
  const panel = h(
    'div',
    { class: 'panel' },
    h('h2', { text: t(`fuel.demo.${key}`) }),
    h('div', { class: 'chart-sub', text: t(`fuel.demo.${key}Sub`) }),
    wrap,
    h('div', { class: 'chart-sub', style: 'margin:0.3rem 0 0', text: axis }),
  );
  return { panel, box: { canvas, tip, hover: null } };
}
const rateChart = chartPanel('chartRate', t('fuel.demo.axisRadii'));
const heatChart = chartPanel('chartHeat', t('fuel.demo.axisRadii'));
const costChart = chartPanel('chartCost', t('fuel.demo.axisLy'));
const tableBody = h('tbody');
const table = h(
  'details',
  { class: 'table' },
  h('summary', { text: t('fuel.demo.table') }),
  h(
    'table',
    {},
    h(
      'thead',
      {},
      h('tr', {}, ...['r', 'flux', 'rate', 'heat'].map((k) => h('th', { scope: 'col', text: t(`fuel.demo.table.${k}`) }))),
    ),
    tableBody,
  ),
);
heatChart.panel.append(table);
grid.append(h('section', { class: 'col col-charts' }, rateChart.panel, heatChart.panel, costChart.panel));

// --- Behaviour -------------------------------------------------------------------------------------------------------

function hyperspeedBinding(): Binding | null {
  const slots = settings.data.bindings['hyperspeed'];
  return slots?.[0] ?? slots?.[1] ?? null;
}

function setJumpLabel(): void {
  const b = hyperspeedBinding();
  jumpBtn.replaceChildren();
  if (b) {
    // The key name comes from the player's current binding (labels.ts), never a hard-coded key.
    const [before, after] = t('fuel.demo.jumpWithKey', { key: '\u0000' }).split('\u0000');
    jumpBtn.append(before ?? '', h('kbd', { text: bindingLabel(b) }), after ?? '');
  } else jumpBtn.textContent = t('fuel.demo.jump');
}

function say(text: string, bad = false): void {
  flash.textContent = text;
  flash.classList.toggle('bad', bad);
}

function doJump(): void {
  const ly = state.jumpLy;
  if (ly === null) return say(t('fuel.demo.noJumpTarget'), true);
  if (!fuel.canJump(ly)) return say(t('fuel.demo.jumpRefused'), true);
  const cost = jumpCost(ly);
  fuel.consumeJump(ly);
  say(t('fuel.demo.jumpDone', { v: fmt(ly, 2), cost: Math.round(cost * 100) }));
  refresh();
}

const KIND: Record<FuelEvent, 'ok' | 'info' | 'warn' | 'danger'> = {
  'scoop-start': 'info',
  'scoop-stop': 'info',
  'tank-full': 'ok',
  'heat-warning': 'warn',
  'heat-critical': 'danger',
  'heat-emergency': 'danger',
  'fuel-low': 'warn',
};

function clock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function renderLog(): void {
  if (eventLog.length === 0) {
    logList.replaceChildren(h('li', { class: 'empty', text: t('fuel.demo.noEvents') }));
    return;
  }
  logList.replaceChildren(
    ...eventLog
      .slice(-7)
      .reverse()
      .map((e) => h('li', { 'data-kind': KIND[e.event], 'data-event': e.event }, h('time', { text: clock(e.time) }), h('span', { text: t(`fuel.demo.event.${e.event}`) }))),
  );
}

function onEvents(events: FuelEvent[]): void {
  for (const e of events) {
    eventLog.push({ time: state.simTime, event: e });
    if (e === 'heat-emergency' && state.autoClimb) {
      // As in the game: the ship climbs until the hull would settle comfortably below the warning level.
      state.climbTo = Math.min(R_MAX, Math.max(state.radii * 1.2, radiiForFlux(fluxForHeat(FUEL.heatWarning - 0.1))));
      say(t('fuel.msg.emergencyClimb'), true);
    }
  }
  if (events.length) renderLog();
}

/** Advance the simulation by `seconds` of game time in fixed steps (deterministic). */
function advance(seconds: number): FuelEvent[] {
  const all: FuelEvent[] = [];
  let left = Math.max(0, seconds);
  while (left > 1e-9) {
    const dt = Math.min(STEP, left);
    left -= dt;
    if (state.climbTo !== null) {
      // Climb outward at 40% of the remaining log-distance per second.
      const k = 1 - Math.exp(-dt / 2.5);
      state.radii = Math.min(R_MAX, state.radii * Math.pow(state.climbTo / state.radii, Math.max(k, 0.02)));
      if (state.radii >= state.climbTo * 0.995) {
        state.radii = state.climbTo;
        state.climbTo = null;
      }
    }
    state.simTime += dt;
    const ev = fuel.update(dt, envAt(state.radii), { mode: 'cruise', throttle: state.throttle, landed: false });
    onEvents(ev);
    all.push(...ev);
  }
  refresh();
  return all;
}

// --- Rendering -------------------------------------------------------------------------------------------------------

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function rootPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

function sizeCanvas(c: HTMLCanvasElement): [CanvasRenderingContext2D, number, number] | null {
  const w = c.clientWidth;
  const hgt = c.clientHeight;
  if (w === 0 || hgt === 0) return null;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = Math.round(w * dpr);
  const H = Math.round(hgt * dpr);
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const g = c.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, hgt);
  return [g, w, hgt];
}

/** Approximate sRGB colour of a black body (Helland's fit; presentation only). */
function blackbody(teffK: number): [number, number, number] {
  const tt = teffK / 100;
  const r = tt <= 66 ? 255 : 329.698727446 * Math.pow(tt - 60, -0.1332047592);
  const g = tt <= 66 ? 99.4708025861 * Math.log(tt) - 161.1195681661 : 288.1221695283 * Math.pow(tt - 60, -0.0755148492);
  const b = tt >= 66 ? 255 : tt <= 19 ? 0 : 138.5177312231 * Math.log(tt - 10) - 305.0447927307;
  const c = (v: number): number => Math.round(Math.min(255, Math.max(0, v)));
  return [c(r), c(g), c(b)];
}

const BG_STARS: [number, number, number][] = (() => {
  let s = 0x51f15e;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return Array.from({ length: 220 }, () => [rnd(), rnd(), rnd() ** 3] as [number, number, number]);
})();

function drawPreview(): void {
  const sized = sizeCanvas(previewCanvas);
  if (!sized) return;
  const [g, w, hh] = sized;
  g.fillStyle = '#01030a';
  g.fillRect(0, 0, w, hh);
  for (const [x, y, m] of BG_STARS) {
    g.fillStyle = `rgba(215, 228, 255, ${0.2 + m * 0.7})`;
    g.fillRect(x * w, y * hh, 0.6 + m * 1.4, 0.6 + m * 1.4);
  }
  // Angular radius of the star for a 60 degree vertical field of view.
  const ang = Math.asin(Math.min(1, 1 / state.radii));
  const pxR = (Math.tan(Math.min(ang, 1.45)) / Math.tan(Math.PI / 6)) * (hh / 2);
  const cx = w * 0.34;
  const cy = hh * 0.6;
  const [r, gg, b] = blackbody(star().teffK);
  const glow = g.createRadialGradient(cx, cy, pxR * 0.6, cx, cy, pxR * 4 + 30);
  glow.addColorStop(0, `rgba(${r}, ${gg}, ${b}, 0.55)`);
  glow.addColorStop(0.35, `rgba(${r}, ${gg}, ${b}, 0.16)`);
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, w, hh);
  const disc = g.createRadialGradient(cx, cy, 0, cx, cy, pxR);
  disc.addColorStop(0, '#ffffff');
  disc.addColorStop(0.7, `rgb(${Math.min(255, r + 30)}, ${Math.min(255, gg + 30)}, ${Math.min(255, b + 30)})`);
  disc.addColorStop(1, `rgb(${Math.round(r * 0.8)}, ${Math.round(gg * 0.7)}, ${Math.round(b * 0.6)})`);
  g.fillStyle = disc;
  g.beginPath();
  g.arc(cx, cy, pxR, 0, Math.PI * 2);
  g.fill();
  // Hull heat tints the canopy edges (drawing only).
  if (fuel.heat > FUEL.heatWarning - 0.1) {
    const k = Math.min(1, (fuel.heat - (FUEL.heatWarning - 0.1)) / (1 - FUEL.heatWarning + 0.1));
    const vig = g.createRadialGradient(w / 2, hh / 2, Math.min(w, hh) * 0.35, w / 2, hh / 2, Math.max(w, hh) * 0.75);
    vig.addColorStop(0, 'rgba(255, 80, 30, 0)');
    vig.addColorStop(1, `rgba(255, 80, 30, ${0.35 * k})`);
    g.fillStyle = vig;
    g.fillRect(0, 0, w, hh);
  }
}

interface Axis {
  min: number;
  max: number;
  log: boolean;
  ticks: number[];
  fmt: (v: number) => string;
}
interface Mark {
  y: number;
  label: string;
  color: string;
  /** Label side (default right). */
  align?: 'left' | 'right';
}
interface ChartSpec {
  box: ChartBox;
  x: Axis;
  y: Axis;
  curve: (x: number) => number;
  /** Shaded x-span with a label (e.g. the scoop band). */
  span?: { from: number; to: number; label: string };
  hlines?: Mark[];
  cursor?: { x: number; label: string } | null;
  tip: (x: number) => string[];
}

function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

function drawChart(spec: ChartSpec): void {
  const sized = sizeCanvas(spec.box.canvas);
  if (!sized) return;
  const [g, w, hh] = sized;
  const rem = rootPx();
  const fg = token('--ks-fg', '#d8e6ff');
  const dim = token('--ks-dim', '#8aa0c0');
  const accent = token('--ks-accent', '#7fd4ff');
  const font = `${Math.round(rem * 0.62)}px ${token('--ks-mono', 'monospace')}`;
  g.font = font;
  const padL = Math.max(...spec.y.ticks.map((v) => g.measureText(spec.y.fmt(v)).width)) + rem * 0.55;
  const padB = rem * 1.15;
  const padT = rem * 0.5;
  const padR = rem * 0.7;
  const pw = w - padL - padR;
  const ph = hh - padT - padB;
  const xf = (x: number): number => {
    const a = spec.x.log ? Math.log10(x) : x;
    const lo = spec.x.log ? Math.log10(spec.x.min) : spec.x.min;
    const hi = spec.x.log ? Math.log10(spec.x.max) : spec.x.max;
    return padL + ((a - lo) / (hi - lo)) * pw;
  };
  const xinv = (px: number): number => {
    const lo = spec.x.log ? Math.log10(spec.x.min) : spec.x.min;
    const hi = spec.x.log ? Math.log10(spec.x.max) : spec.x.max;
    const a = lo + ((px - padL) / pw) * (hi - lo);
    return spec.x.log ? Math.pow(10, a) : a;
  };
  const yf = (y: number): number => padT + ph - (Math.min(spec.y.max, Math.max(spec.y.min, y)) / spec.y.max) * ph;
  const bg = token('--ks-surface-solid', '#08111f');
  /** In-plot labels, drawn last with a surface-coloured halo so hairlines never cut through them. */
  const labels: { text: string; x: number; y: number; align: CanvasTextAlign; base: CanvasTextBaseline; color: string }[] = [];
  // Scoop band wash.
  if (spec.span && spec.span.to > spec.span.from) {
    const a = xf(Math.max(spec.x.min, spec.span.from));
    const b = xf(Math.min(spec.x.max, spec.span.to));
    g.fillStyle = hexA(accent, 0.09);
    g.fillRect(a, padT, b - a, ph);
    // Label at the band's outer edge, where both curves sit low; skipped when the band is too narrow.
    if (b - a > g.measureText(spec.span.label).width + 8) labels.push({ text: spec.span.label, x: b - 4, y: padT + 3, align: 'right', base: 'top', color: dim });
    g.strokeStyle = hexA(accent, 0.35);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(b) + 0.5, padT);
    g.lineTo(Math.round(b) + 0.5, padT + ph);
    g.stroke();
  }
  // Grid and axes (hairlines, solid).
  g.strokeStyle = hexA(fg, 0.1);
  g.lineWidth = 1;
  g.fillStyle = dim;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (const v of spec.y.ticks) {
    const y = Math.round(yf(v)) + 0.5;
    g.beginPath();
    g.moveTo(padL, y);
    g.lineTo(padL + pw, y);
    g.stroke();
    g.fillText(spec.y.fmt(v), padL - rem * 0.3, y);
  }
  g.textAlign = 'center';
  g.textBaseline = 'top';
  for (const v of spec.x.ticks) {
    const x = Math.round(xf(v)) + 0.5;
    g.beginPath();
    g.moveTo(x, padT + ph);
    g.lineTo(x, padT + ph + 3);
    g.stroke();
    g.fillText(spec.x.fmt(v), x, padT + ph + 4);
  }
  // Threshold lines with labels.
  for (const m of spec.hlines ?? []) {
    const y = Math.round(yf(m.y)) + 0.5;
    g.strokeStyle = m.color;
    g.globalAlpha = 0.85;
    g.beginPath();
    g.moveTo(padL, y);
    g.lineTo(padL + pw, y);
    g.stroke();
    g.globalAlpha = 1;
    labels.push({ text: m.label, x: m.align === 'left' ? padL + 4 : padL + pw - 2, y: y - 2, align: m.align === 'left' ? 'left' : 'right', base: 'bottom', color: fg });
  }
  // Curve with a soft area wash.
  const N = Math.max(60, Math.round(pw / 2));
  const pts: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const x = xinv(padL + (i / N) * pw);
    pts.push([padL + (i / N) * pw, yf(spec.curve(x))]);
  }
  g.beginPath();
  g.moveTo(pts[0]![0], padT + ph);
  for (const [x, y] of pts) g.lineTo(x, y);
  g.lineTo(pts.at(-1)![0], padT + ph);
  g.closePath();
  g.fillStyle = hexA(accent, 0.1);
  g.fill();
  g.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
  g.strokeStyle = accent;
  g.lineWidth = 2;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.stroke();
  // Current position.
  const dot = (x: number, label: string | null): void => {
    const px = xf(x);
    const py = yf(spec.curve(x));
    g.strokeStyle = hexA(fg, 0.55);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(px) + 0.5, padT);
    g.lineTo(Math.round(px) + 0.5, padT + ph);
    g.stroke();
    g.fillStyle = accent;
    g.strokeStyle = bg;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(px, py, 4.5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    if (label) {
      const tw = g.measureText(label).width;
      // Normally above-right of the dot. Near the top the curves here are flat to the left and fall to the right, so
      // the label goes below-left, where the plot is empty.
      const below = py < padT + rem * 1.1;
      const left = below ? px - tw - 10 > padL : px + tw + 10 >= padL + pw;
      labels.push({ text: label, x: px + (left ? -7 : 7), y: below ? py + 6 : py - 5, align: left ? 'right' : 'left', base: below ? 'top' : 'bottom', color: fg });
    }
  };
  if (spec.cursor && spec.cursor.x >= spec.x.min && spec.cursor.x <= spec.x.max) dot(spec.cursor.x, spec.cursor.label);
  g.lineJoin = 'round';
  for (const l of labels) {
    g.textAlign = l.align;
    g.textBaseline = l.base;
    g.strokeStyle = hexA(bg, 0.85);
    g.lineWidth = 3;
    g.strokeText(l.text, l.x, l.y);
    g.fillStyle = l.color;
    g.fillText(l.text, l.x, l.y);
  }
  // Hover crosshair and tooltip (values are also in the readouts and the table view).
  const hov = spec.box.hover;
  const tip = spec.box.tip;
  if (hov !== null && hov >= padL && hov <= padL + pw) {
    const x = xinv(hov);
    dot(x, null);
    tip.replaceChildren(...spec.tip(x).map((line, i) => h('div', { class: 'row' }, ...(i === 0 ? [h('span', { class: 'key' })] : []), i === 0 ? h('b', { text: line }) : line)));
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(w - tw - 2, Math.max(2, hov + 10))}px`;
    tip.style.top = `${padT}px`;
  } else tip.style.display = 'none';
}

/** Colour token with alpha (tokens are hex or rgb()). */
function hexA(color: string, a: number): string {
  const c = color.trim();
  if (c.startsWith('#')) {
    const hex = c.length === 4 ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1, 7);
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) {
    const [r, g, b] = m[1]!.split(',').map((x) => x.trim());
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return c;
}

const R_TICKS = [1, 2, 5, 10, 20, 50, 100];

function drawCharts(): void {
  const edge = radiiForFlux(FUEL.scoopMinFlux);
  const youLabel = t('fuel.demo.you');
  const maxRate = Math.max(...Array.from({ length: 40 }, (_, i) => ratePerMin(R_MIN * Math.pow(R_MAX / R_MIN, i / 39))), ratePerMin(1));
  const yMax = niceCeil(Math.max(maxRate, 5));
  const tipR = (x: number): string[] => {
    const f = fluxSolar(envAt(x));
    return [
      t('fuel.demo.rateValue', { v: fmt(ratePerMin(x), 1) }),
      t('fuel.demo.eqHeatValue', { v: Math.round(Math.min(1, equilibriumHeat(f)) * 100) }),
      t('fuel.demo.tooltip.r', { r: fmt(x, 2) }),
      t('fuel.demo.tooltip.flux', { v: sig(f) }),
    ];
  };
  const rAxis: Axis = { min: 1, max: R_MAX, log: true, ticks: R_TICKS, fmt: (v) => fmt(v) };
  drawChart({
    box: rateChart.box,
    x: rAxis,
    y: { min: 0, max: yMax, log: false, ticks: [0, yMax / 2, yMax], fmt: (v) => fmt(v) },
    curve: ratePerMin,
    span: { from: 1, to: Math.min(R_MAX, edge), label: t('fuel.demo.band.label') },
    cursor: { x: state.radii, label: youLabel },
    tip: tipR,
  });
  const warn = token('--ks-warn', '#ffb454');
  const danger = token('--ks-danger', '#ff6b6b');
  drawChart({
    box: heatChart.box,
    x: rAxis,
    y: { min: 0, max: 100, log: false, ticks: [0, 50, 100], fmt: (v) => `${fmt(v)}%` },
    curve: (x) => Math.min(1, equilibriumHeat(fluxSolar(envAt(x)))) * 100,
    span: { from: 1, to: Math.min(R_MAX, edge), label: t('fuel.demo.band.label') },
    hlines: [
      { y: FUEL.heatWarning * 100, label: t('fuel.demo.limit.warning', { v: FUEL.heatWarning * 100 }), color: warn },
      { y: FUEL.heatCritical * 100, label: t('fuel.demo.limit.critical', { v: FUEL.heatCritical * 100 }), color: danger },
    ],
    cursor: { x: state.radii, label: youLabel },
    tip: tipR,
  });
  const ly = state.jumpLy;
  const range = rangeFor(fuel.hyperFuel);
  drawChart({
    box: costChart.box,
    x: { min: 0, max: 60, log: false, ticks: [0, 10, 20, 30, 40, 50, 60], fmt: (v) => fmt(v) },
    y: { min: 0, max: 120, log: false, ticks: [0, 50, 100], fmt: (v) => `${fmt(v)}%` },
    curve: (x) => jumpCost(x) * 100,
    hlines: [
      {
        y: fuel.hyperFuel * 100,
        label: t('fuel.demo.tankLine', { v: Math.round(fuel.hyperFuel * 100), r: fmt(range, 1) }),
        color: hexA(token('--ks-fg', '#d8e6ff'), 0.5),
        // The cost curve is low on the left and high on the right: label on the side away from it.
        align: fuel.hyperFuel > 0.5 ? 'left' : 'right',
      },
    ],
    cursor: ly === null ? null : { x: ly, label: t('fuel.gauge.percent', { v: Math.round(jumpCost(ly) * 100) }) },
    tip: (x) => [t('fuel.gauge.percent', { v: fmt(jumpCost(x) * 100, 1) }), t('fuel.demo.jumpValue', { v: fmt(x, 1) })],
  });
}

function renderTable(): void {
  const rows = [1.05, 1.25, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30, 50, 100];
  tableBody.replaceChildren(
    ...rows.map((r) => {
      const f = fluxSolar(envAt(r));
      return h(
        'tr',
        { 'data-band': inScoopBand(f) ? 'in' : 'out' },
        h('td', { text: fmt(r, 2) }),
        h('td', { text: sig(f) }),
        h('td', { text: fmt(ratePerMin(r), 1) }),
        h('td', { text: fmt(Math.min(100, equilibriumHeat(f) * 100)) }),
      );
    }),
  );
}

let lastStatic = '';
function refresh(): void {
  const s = star();
  const env = envAt(state.radii);
  const f = fluxSolar(env);
  // Controls.
  starCtl.out.textContent = t(`fuel.demo.star.${s.key}`);
  starCtl.input.setAttribute('aria-valuetext', t(`fuel.demo.star.${s.key}`));
  starStats.textContent = t('fuel.demo.starStats', { l: sig(s.luminositySun), r: fmt(s.radiusSun, 3), t: fmt(s.teffK) });
  const rText = t('fuel.demo.distanceValue', { r: fmt(state.radii, state.radii < 10 ? 2 : 1) });
  distCtl.out.textContent = rText;
  distCtl.input.setAttribute('aria-valuetext', rText);
  if (document.activeElement !== distCtl.input) distCtl.input.value = String(toSlider(state.radii));
  distHint.textContent = `${t('fuel.demo.fromCentre')}: ${formatDistance(env.distanceM)}`;
  thrCtl.out.textContent = t('fuel.demo.throttleValue', { v: Math.round(state.throttle * 100) });
  jumpCtl.out.textContent = state.jumpLy === null ? t('fuel.demo.noTarget') : t('fuel.demo.jumpValue', { v: fmt(state.jumpLy, 2) });
  jumpCtl.input.setAttribute('aria-valuetext', jumpCtl.out.textContent);
  for (const input of [starCtl.input, distCtl.input, thrCtl.input, jumpCtl.input]) paintRange(input);
  for (const b of presetBtns) {
    const p = PRESETS.find((x) => x.key === b.dataset['preset']);
    b.setAttribute('aria-pressed', String(p !== undefined && (p.ly === null ? state.jumpLy === null : state.jumpLy !== null && Math.abs(p.ly - state.jumpLy) < 0.03)));
  }
  for (const b of speedBtns) b.setAttribute('aria-pressed', String(Number(b.dataset['speed']) === state.speed));
  runBtn.textContent = state.running ? t('fuel.demo.pause') : t('fuel.demo.run');
  runBtn.setAttribute('aria-pressed', String(!state.running));
  simTimeEl.textContent = t('fuel.demo.simTime', { t: clock(state.simTime) });

  // Readouts.
  roFlux.v.textContent = t('fuel.demo.fluxValue', { v: sig(f) });
  roFlux.s.textContent = `${t('fuel.demo.fromCentre')} ${formatDistance(env.distanceM)}`;
  const inBand = inScoopBand(f);
  roBand.el.dataset['band'] = inBand ? 'in' : 'out';
  const edge = radiiForFlux(FUEL.scoopMinFlux);
  roBand.v.textContent = inBand ? t('fuel.demo.inBand') : t('fuel.demo.outBand', { r: fmt(edge, 2) });
  roBand.s.textContent = t('fuel.demo.bandEdge', { r: fmt(edge, 2), v: fmt(FUEL.scoopMinFlux) });
  const rate = scoopRate(f, state.throttle);
  roRate.v.textContent = t('fuel.demo.rateValue', { v: fmt(rate * 6000, 1) });
  roRate.s.textContent = rate > 0 ? `${t('fuel.demo.timeToFull')} ${formatDuration(1 / rate)}` : t('fuel.demo.never');
  const eq = equilibriumHeat(f);
  roHeat.v.textContent = eq > 1 ? t('fuel.demo.overLimit') : t('fuel.demo.eqHeatValue', { v: Math.round(eq * 100) });
  roHeat.s.textContent = t('fuel.demo.heatNow', { v: Math.round(fuel.heat * 100), state: t(`fuel.heat.${fuel.heatState}`) });

  // Gauge (as the HUD would feed it).
  gauge.update({
    hyperFuel: fuel.hyperFuel,
    heat: fuel.heat,
    scooping: fuel.scooping,
    nextJumpCost: state.jumpLy === null ? null : jumpCost(state.jumpLy),
    secondsToFull: fuel.secondsToFull,
    heatState: fuel.heatState,
  });

  const key = `${state.star}|${state.throttle}`;
  if (key !== lastStatic) {
    lastStatic = key;
    renderTable();
  }
  drawPreview();
  drawCharts();
}

// --- Wiring ----------------------------------------------------------------------------------------------------------

starCtl.input.addEventListener('input', () => {
  state.star = Number(starCtl.input.value);
  state.climbTo = null;
  refresh();
});
distCtl.input.addEventListener('input', () => {
  state.radii = fromSlider(Number(distCtl.input.value));
  state.climbTo = null;
  refresh();
});
thrCtl.input.addEventListener('input', () => {
  state.throttle = Number(thrCtl.input.value) / 100;
  refresh();
});
jumpCtl.input.addEventListener('input', () => {
  const v = Number(jumpCtl.input.value);
  state.jumpLy = v > 0 ? v : null;
  refresh();
});
for (const b of presetBtns)
  b.addEventListener('click', () => {
    const p = PRESETS.find((x) => x.key === b.dataset['preset']);
    if (!p) return;
    state.jumpLy = p.ly;
    jumpCtl.input.value = String(p.ly ?? 0);
    refresh();
  });
for (const b of speedBtns)
  b.addEventListener('click', () => {
    state.speed = Number(b.dataset['speed']);
    refresh();
  });
runBtn.addEventListener('click', () => {
  state.running = !state.running;
  refresh();
});
jumpBtn.addEventListener('click', doJump);
fillBtn.addEventListener('click', () => {
  fuel.refuel(1);
  refresh();
});
drainBtn.addEventListener('click', () => {
  fuel.hyperFuel = 0.1;
  refresh();
});
coolBtn.addEventListener('click', () => {
  fuel.heat = 0;
  refresh();
});
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
  const slots = settings.data.bindings['hyperspeed'] ?? [null, null];
  if (slots.some((b) => b?.type === 'key' && b.code === e.code)) {
    e.preventDefault();
    doJump();
  }
});
for (const box of [rateChart.box, heatChart.box, costChart.box]) {
  box.canvas.addEventListener('pointermove', (e) => {
    box.hover = e.offsetX;
    drawCharts();
  });
  box.canvas.addEventListener('pointerleave', () => {
    box.hover = null;
    drawCharts();
  });
}
window.addEventListener('resize', () => refresh());
settings.onChange(() => refresh());

setJumpLabel();
renderLog();
refresh();

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (state.running && dt > 0) advance(dt * state.speed);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Test hooks.
(window as unknown as { __ksFuel: unknown }).__ksFuel = {
  fuel,
  gauge,
  state,
  advance,
  events: (): FuelEvent[] => eventLog.map((e) => e.event),
  setStar: (i: number): void => {
    state.star = i;
    starCtl.input.value = String(i);
    refresh();
  },
  setRadii: (r: number): void => {
    state.radii = Math.min(R_MAX, Math.max(R_MIN, r));
    state.climbTo = null;
    distCtl.input.value = String(toSlider(state.radii));
    refresh();
  },
  pause: (): void => {
    state.running = false;
    refresh();
  },
};
