/**
 * TRAPPIST-1 data lab (exo.html): loads public/data/systems/trappist-1.json through loadSystem(), draws the orbits at
 * the current time with orbitalPosition(), lists every value with its provenance badge and a "How do we know this?"
 * panel, and previews each planet's generated surface parameters. Exposes window.__ksExo for tests/e2e/exo.spec.ts.
 */
import { AU_M } from '../core/constants';
import { fbm3, Rng } from '../core/rng';
import { tdbSecondsSinceJ2000ToUnixMs, unixMsToTdbSecondsSinceJ2000 } from '../core/time';
import { formatNumber, hasKey, t } from '../game/i18n';
import {
  atmosphereLabelKey,
  compositionLabelKey,
  INFERRED_FIELDS,
  loadSystem,
  MEASURED_FIELDS,
  orbitalPosition,
  terrainLabelKey,
  type AtmosphereClass,
  type CompositionClass,
  type ExoPlanet,
  type ExoSourced,
  type ExoSystem,
} from '../world/exo/systemData';
import type { Provenance } from '../core/provenance';

// --- DOM helpers ------------------------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) n.className = cls;
  Object.assign(n, rest);
  for (const k of kids) n.append(k);
  return n;
}

function badge(p: Provenance): HTMLSpanElement {
  const b = el('span', { cls: `exo-prov exo-prov-${p}` }, el('span', { cls: 'exo-prov-mark' }), t(`prov.${p}`));
  b.setAttribute('data-prov', p);
  return b;
}

function swatch(colour: string): HTMLElement {
  const i = el('i');
  i.style.background = colour;
  return i;
}

function panel(title: string, meta?: string): { root: HTMLElement; body: HTMLDivElement } {
  const h = el('h2', {}, title);
  if (meta) h.append(el('span', { cls: 'meta' }, meta));
  const body = el('div', { cls: 'panel-body' });
  return { root: el('section', { cls: 'panel' }, h, body), body };
}

// --- Number formatting ------------------------------------------------------------------------------------------

/** Decimal places a number is written with (handles 6e-06 style). */
function decimalsOf(x: number): number {
  const s = String(Math.abs(x));
  const m = /e-(\d+)$/.exec(s);
  if (m) {
    const frac = s.split('e')[0]!.split('.')[1]?.length ?? 0;
    return frac + Number(m[1]);
  }
  return s.split('.')[1]?.length ?? 0;
}

const MAX_DECIMALS = 7;
const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const superscript = (n: number): string => (n < 0 ? '⁻' : '') + String(Math.abs(n)).replace(/\d/g, (c) => SUPERSCRIPT[Number(c)] ?? c);

/**
 * Value with uncertainty at the precision it was catalogued with, but no more than one digit beyond the two
 * significant digits of the uncertainty. Very small values use a power-of-ten factor.
 */
function numberText(s: ExoSourced<number>): string {
  const u = s.uncertainty;
  const us = u === undefined ? [] : typeof u === 'number' ? [u] : [u[0], u[1]];
  const exp = s.value !== 0 && Math.abs(s.value) < 1e-3 ? Math.floor(Math.log10(Math.abs(s.value))) : 0;
  const k = Math.pow(10, -exp);
  const clean = (x: number): number => Number((x * k).toPrecision(12));
  // JSON drops trailing zeros (0.920 -> 0.92), so the uncertainty sets the precision when there is one.
  let d = decimalsOf(clean(s.value));
  const positive = us.filter((x) => x > 0);
  if (positive.length > 0) {
    // Two significant digits of the uncertainty (fewer if catalogued so), plus at most one more digit of the value.
    const du = Math.max(...positive.map((x) => Math.min(decimalsOf(clean(x)), 1 - Math.floor(Math.log10(clean(x))))));
    d = Math.max(du, Math.min(d, du + 1));
  }
  d = Math.max(0, Math.min(MAX_DECIMALS, d));
  const epoch = s.unit === 'BJD_TDB';
  const f = (x: number): string => (epoch ? (x * k).toFixed(d) : formatNumber(x * k, d, d));
  const v = f(s.value);
  const tiny = us.some((x) => Number((x * k).toFixed(d)) === 0);
  let text = v;
  if (u !== undefined && !tiny && !epoch) {
    text = typeof u === 'number' ? t('exo.pm.sym', { v, u: f(u) }) : t('exo.pm.asym', { v, lo: f(u[0]), hi: f(u[1]) });
  }
  if (exp !== 0) text = `(${text}) × 10${superscript(exp)}`;
  return withUnit(text, s.unit);
}

function withUnit(text: string, unit: string): string {
  if (unit === '') return text;
  const key = `exo.unit.${unit}`;
  return hasKey(key) ? t(key, { v: text }) : `${text} ${unit}`;
}

function valueText(s: ExoSourced<unknown>, field: string): string {
  const v = s.value;
  if (typeof v === 'number') return numberText(s as ExoSourced<number>);
  if (typeof v === 'boolean') return t(`exo.bool.${v}`);
  if (field === 'composition') return t(compositionLabelKey(v as CompositionClass));
  if (field === 'atmosphere') return t(atmosphereLabelKey(v as AtmosphereClass));
  return String(v);
}

function compact(v: number, digits: number): string {
  return formatNumber(v, digits, digits);
}

// --- State --------------------------------------------------------------------------------------------------------

const app = document.getElementById('app')!;
document.title = t('exo.demo.pageTitle');
const status = el('p', { cls: 'loading' }, t('exo.demo.loading'));
app.append(status);

let sys: ExoSystem;
let selected = 0;
let tSim = unixMsToTdbSecondsSinceJ2000(Date.now());
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let playing = !reduceMotion;
let speed = 86_400;
let lastFrame = performance.now();
let previewMs = 0;

interface Detail {
  label: string;
  provenance: Provenance;
  value: string;
  uncertainty: string;
  source: string;
  citation: string;
  note: string;
}

const detailBox = el('div', { cls: 'detail' });
const orbitCanvas = el('canvas', { cls: 'orbits' });
const clock = el('span', { cls: 'clock' });
const planetCard = el('div', { cls: 'planet-card' });
const tableBody = el('tbody');
const playBtn = el('button', { type: 'button', cls: 'chip-btn' });

// --- Detail panel -------------------------------------------------------------------------------------------------

function citationNode(key: string): Node {
  const c = sys.citations[key];
  if (!c) return document.createTextNode(key);
  const ref = `${c.authors} (${c.year}). ${c.title}. ${c.venue}.`;
  const span = el('span', {}, ref + ' ');
  const href = c.doi ? `https://doi.org/${c.doi}` : c.url && /^https?:/.test(c.url) ? c.url : undefined;
  if (href) span.append(el('a', { href, target: '_blank', rel: 'noopener' }, c.doi ? `doi:${c.doi}` : href));
  else if (c.url) span.append(el('code', {}, c.url));
  return span;
}

function showDetail(d: Detail): void {
  detailBox.replaceChildren(
    el('div', { cls: 'detail-head' }, el('strong', {}, d.label), badge(d.provenance)),
    el('div', { cls: 'detail-value' }, d.value),
  );
  const dl = el('dl');
  const add = (k: string, v: Node | string): void => {
    dl.append(el('dt', {}, k), el('dd', {}, v));
  };
  add(t('exo.demo.uncertainty'), d.uncertainty);
  add(t('exo.demo.source'), d.source);
  add(t('exo.demo.citation'), citationNode(d.citation));
  if (d.note) add(t('exo.demo.note'), d.note);
  detailBox.append(dl);
}

function sourcedDetail(label: string, s: ExoSourced<unknown>, field: string): Detail {
  const u = s.uncertainty;
  const uText = u === undefined ? t('exo.demo.none') : typeof u === 'number' ? `± ${u}` : `−${u[0]} / +${u[1]}`;
  return {
    label,
    provenance: s.provenance,
    value: valueText(s, field),
    uncertainty: uText,
    source: s.source,
    citation: s.citation,
    note: s.note ?? '',
  };
}

function valueRow(label: string, value: string, p: Provenance, detail: () => Detail): HTMLButtonElement {
  const b = el(
    'button',
    { type: 'button', cls: 'vrow' },
    el('span', { cls: 'k' }, label),
    el('span', { cls: 'v' }, value),
    el('span', { cls: `dot dot-${p}` }),
  );
  b.addEventListener('click', () => {
    document.querySelectorAll('.vrow.on').forEach((n) => n.classList.remove('on'));
    b.classList.add('on');
    showDetail(detail());
  });
  return b;
}

function sourcedRow(labelKey: string, s: ExoSourced<unknown>, field: string): HTMLButtonElement {
  const label = t(labelKey);
  return valueRow(label, valueText(s, field), s.provenance, () => sourcedDetail(label, s, field));
}

// --- Planet card ------------------------------------------------------------------------------------------------

const previewCanvas = el('canvas', { cls: 'preview', width: 240, height: 240 });

function section(p: Provenance, captionKey: string, rows: HTMLElement[]): HTMLElement {
  return el(
    'div',
    { cls: `sec sec-${p}` },
    el('div', { cls: 'sec-head' }, badge(p), el('span', { cls: 'sec-cap' }, t(captionKey))),
    ...rows,
  );
}

function renderPlanetCard(): void {
  const planet = sys.planets[selected]!;
  const g = planet.generated;
  const measured = MEASURED_FIELDS.map((k) => sourcedRow(`exo.field.${k}`, planet.measured[k], k));
  const inferred = INFERRED_FIELDS.map((k) => sourcedRow(`exo.field.${k}`, planet.inferred[k], k));
  const genDetail = (labelKey: string, value: string) => (): Detail => ({
    label: t(labelKey),
    provenance: 'generated',
    value,
    uncertainty: t('exo.demo.none'),
    source: g.source,
    citation: g.citation,
    note: g.rationale,
  });
  const genRow = (labelKey: string, value: string): HTMLButtonElement => valueRow(t(labelKey), value, 'generated', genDetail(labelKey, value));
  const pct = (v: number): string => t('exo.unit.percent', { v: Math.round(v * 100) });
  const generated = [
    genRow('exo.field.terrain', t(terrainLabelKey(g.terrain))),
    genRow('exo.field.albedo', compact(g.albedo, 2)),
    genRow('exo.field.iceCoverage', pct(g.iceCoverage)),
    genRow('exo.field.nightSideGlow', pct(g.nightSideGlow)),
  ];
  const swatches = el('div', { cls: 'swatches', title: t('exo.demo.palette') });
  for (const c of g.palette) swatches.append(swatch(c));

  planetCard.replaceChildren(
    el(
      'div',
      { cls: 'pc-head' },
      el('div', {}, el('h3', {}, planet.name), el('p', { cls: 'dim' }, t('exo.demo.defaultSet', { ref: planet.defaultParameterSet.label }))),
    ),
    el(
      'div',
      { cls: 'pc-top' },
      el(
        'figure',
        { cls: 'preview-fig' },
        previewCanvas,
        el('figcaption', {}, t('exo.demo.previewCaption')),
      ),
      el(
        'div',
        { cls: 'pc-gen' },
        section('generated', 'exo.demo.generatedCaption', generated),
        el('div', { cls: 'sw-row' }, el('span', { cls: 'k' }, t('exo.demo.palette')), swatches),
        el('details', { cls: 'why' }, el('summary', {}, t('exo.demo.rationale')), el('p', {}, g.rationale)),
      ),
    ),
    section('measured', 'exo.demo.measuredCaption', measured),
    section('inferred', 'exo.demo.inferredCaption', inferred),
  );
  const t0 = performance.now();
  renderSurface(previewCanvas, planet);
  previewMs = performance.now() - t0;
  const first = measured[0];
  if (first) first.click();
  for (const [i, tr] of [...tableBody.children].entries()) tr.classList.toggle('on', i === selected);
}

// --- Generated surface preview ------------------------------------------------------------------------------------

function hexToLinear(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = (v: number): number => Math.pow(v / 255, 2.2);
  return [c((n >> 16) & 255), c((n >> 8) & 255), c(n & 255)];
}

function mix3(a: readonly number[], b: readonly number[], k: number): [number, number, number] {
  return [a[0]! + (b[0]! - a[0]!) * k, a[1]! + (b[1]! - a[1]!) * k, a[2]! + (b[2]! - a[2]!) * k];
}

function ramp(cols: readonly (readonly number[])[], x: number): [number, number, number] {
  const f = Math.min(0.9999, Math.max(0, x)) * (cols.length - 1);
  const i = Math.floor(f);
  return mix3(cols[i]!, cols[Math.min(cols.length - 1, i + 1)]!, f - i);
}

const smooth = (e0: number, e1: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return k * k * (3 - 2 * k);
};

/**
 * Artist's impression from the generated parameters: palette by height (value noise), bump-shaded craters (few on
 * young volcanic plains), ice away from the substellar point (the planets are expected to be tidally locked) covering
 * iceCoverage of the sphere, and thin glowing fissures on the night side scaled by nightSideGlow. Lit by an
 * approximately 2,566 K blackbody colour. No atmosphere is drawn because none is supported by observations.
 */
function renderSurface(canvas: HTMLCanvasElement, planet: ExoPlanet): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const g = planet.generated;
  const n = canvas.width;
  const img = ctx.createImageData(n, n);
  const pal = g.palette.map(hexToLinear);
  // Palette layout (tools/pipeline/exoplanets.py): rock-only terrains have five rock tones; mixed and icy terrains
  // have two rock tones then three ice tones.
  const hasIce = g.terrain === 'mixed' || g.terrain === 'icy';
  const rockCols = hasIce ? pal.slice(0, 2) : pal;
  const iceCols = hasIce ? pal.slice(2) : pal.slice(-2);
  const volcanic = g.terrain === 'volcanic';
  // Star to the upper left at a ~65 deg phase angle, so the terminator and part of the night side are in view.
  const ll = Math.hypot(-0.82, 0.3, 0.42);
  const lx = -0.82 / ll;
  const ly = 0.3 / ll;
  const lz = 0.42 / ll;
  const star = [1.0, 0.6, 0.33];
  const rng = new Rng(g.seed);
  const craters: { x: number; y: number; z: number; r: number }[] = [];
  const nCraters = volcanic ? 5 : 90;
  for (let i = 0; i < nCraters; i++) {
    const zc = rng.range(-1, 1);
    const ph = rng.range(0, Math.PI * 2);
    const sc = Math.sqrt(1 - zc * zc);
    craters.push({ x: sc * Math.cos(ph), y: sc * Math.sin(ph), z: zc, r: 0.025 + 0.22 * Math.pow(rng.next(), 3.2) });
  }
  const iceCut = 2 * g.iceCoverage - 1;
  const seed = g.seed | 0;
  const freq = 3.2;
  const eps = 0.012;
  const enc = (v: number): number => Math.round(255 * Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2));
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const x = ((px + 0.5) / n) * 2 - 1;
      const y = 1 - ((py + 0.5) / n) * 2;
      const r2 = x * x + y * y;
      if (r2 > 1) continue;
      const o = (py * n + px) * 4;
      const z = Math.sqrt(1 - r2);
      const mu0 = x * lx + y * ly + z * lz;
      // Light direction projected onto the tangent plane: the noise slope along it shades the relief.
      let tx = lx - mu0 * x;
      let ty = ly - mu0 * y;
      let tz = lz - mu0 * z;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const h0 = fbm3(seed, x * freq + 7.1, y * freq, z * freq, 6);
      const h1 = fbm3(seed, (x + tx * eps) * freq + 7.1, (y + ty * eps) * freq, (z + tz * eps) * freq, 6);
      const slope = (h1 - h0) / eps;
      let h = h0;
      let gx = tx * slope * 0.06;
      let gy = ty * slope * 0.06;
      let gz = tz * slope * 0.06;
      for (const c of craters) {
        const cosT = x * c.x + y * c.y + z * c.z;
        if (cosT < 0.9) continue;
        const theta = Math.acos(Math.min(1, cosT));
        const q = theta / c.r;
        if (q > 1.35) continue;
        // Tangent direction away from the crater centre.
        let vx = x - c.x - (x * (x - c.x) + y * (y - c.y) + z * (z - c.z)) * x;
        let vy = y - c.y - (x * (x - c.x) + y * (y - c.y) + z * (z - c.z)) * y;
        let vz = z - c.z - (x * (x - c.x) + y * (y - c.y) + z * (z - c.z)) * z;
        const vl = Math.hypot(vx, vy, vz) || 1;
        vx /= vl;
        vy /= vl;
        vz /= vl;
        let dh: number;
        if (q < 1) {
          h -= 0.5 * (1 - q * q);
          dh = (1.0 * q) / c.r;
        } else {
          h += 0.35 * (1 - (q - 1) / 0.35);
          dh = -0.35 / (0.35 * c.r);
        }
        const k = 0.022 * Math.min(1, 0.12 / c.r + 0.4);
        gx += vx * dh * k;
        gy += vy * dh * k;
        gz += vz * dh * k;
      }
      // Bumped normal: n - grad(h).
      let nx = x - gx;
      let ny = y - gy;
      let nz = z - gz;
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const ridge = 1 - Math.abs(fbm3(seed + 17, x * 2.6, y * 2.6 + 3.3, z * 2.6, 5));
      let col = volcanic
        ? ramp(rockCols, 0.32 + h0 * 0.45 - smooth(0.9, 0.985, ridge) * 0.25)
        : ramp(rockCols, 0.5 + h * 0.5);
      if (g.iceCoverage > 0) {
        const edge = mu0 + fbm3(seed + 5, x * 4, y * 4, z * 4, 4) * 0.25;
        const k = smooth(iceCut + 0.03, iceCut - 0.03, edge);
        if (k > 0) col = mix3(col, ramp(iceCols, 0.45 + h * 0.55), k);
      }
      const m0 = nx * lx + ny * ly + nz * lz;
      // Lambert blended with Lommel-Seeliger (airless regolith), plus a faint cool fill so night-side ice reads.
      const lit = m0 > 0 && mu0 > -0.05 ? 0.55 * m0 + 0.45 * ((2 * m0) / (m0 + Math.max(0.05, nz))) * Math.max(0, mu0) : 0;
      const fill = 0.045 * (0.4 + 0.6 * z);
      let rC = col[0] * (star[0]! * lit * 1.3 + fill * 0.8);
      let gC = col[1] * (star[1]! * lit * 1.3 + fill * 0.9);
      let bC = col[2] * (star[2]! * lit * 1.3 + fill * 1.15);
      if (g.nightSideGlow > 0) {
        const night = 1 - smooth(-0.2, 0.05, mu0);
        const glow = g.nightSideGlow * 2.5 * night * smooth(0.965, 0.995, ridge);
        rC += 1.0 * glow;
        gC += 0.3 * glow;
        bC += 0.06 * glow;
      }
      const edgeA = Math.min(1, (1 - Math.sqrt(r2)) * n * 0.5);
      img.data[o] = enc(rC);
      img.data[o + 1] = enc(gC);
      img.data[o + 2] = enc(bC);
      img.data[o + 3] = Math.round(255 * edgeA);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// --- Orbits -------------------------------------------------------------------------------------------------------

interface PlanetDot {
  letter: string;
  x: number;
  y: number;
}
let lastDots: PlanetDot[] = [];

function drawOrbits(): void {
  const c = orbitCanvas;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const cx = w * 0.5;
  const cy = h * 0.5;
  const aMax = Math.max(...sys.planets.map((p) => p.measured.semiMajorAxisAu.value));
  const R = Math.min(w, h) * 0.5 - 26 * dpr;
  const s = R / (aMax * AU_M);

  // Line of sight toward the Sun (+x of the orbital frame): planets crossing it transit as seen from Earth.
  ctx.save();
  ctx.setLineDash([3 * dpr, 5 * dpr]);
  ctx.strokeStyle = 'rgba(127, 212, 255, 0.35)';
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(w - 8 * dpr, cy);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = 'rgba(127, 212, 255, 0.75)';
  ctx.beginPath();
  ctx.moveTo(w - 6 * dpr, cy);
  ctx.lineTo(w - 14 * dpr, cy - 4 * dpr);
  ctx.lineTo(w - 14 * dpr, cy + 4 * dpr);
  ctx.closePath();
  ctx.fill();
  ctx.font = `${10 * dpr}px ui-monospace, monospace`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(t('exo.demo.toSun'), w - 8 * dpr, cy - 7 * dpr);

  // Star: true size is ~2 px at this scale; the glow is decorative.
  const glowR = 16 * dpr;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  glow.addColorStop(0, 'rgba(255, 200, 140, 0.9)');
  glow.addColorStop(0.25, 'rgba(255, 140, 70, 0.4)');
  glow.addColorStop(1, 'rgba(255, 90, 40, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
  ctx.fill();

  // Scale bar: 0.01 au.
  const bar = 0.01 * AU_M * s;
  const bx = 14 * dpr;
  const by = h - 14 * dpr;
  ctx.strokeStyle = 'rgba(216, 230, 255, 0.7)';
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(bx, by - 4 * dpr);
  ctx.lineTo(bx, by);
  ctx.lineTo(bx + bar, by);
  ctx.lineTo(bx + bar, by - 4 * dpr);
  ctx.stroke();
  ctx.fillStyle = 'rgba(216, 230, 255, 0.8)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(withUnit(formatNumber(0.01, 2, 2), 'au'), bx + bar / 2, by - 5 * dpr);
  const starR = Math.max(1.5 * dpr, sys.star.radiusSun.value * 6.957e8 * s);
  ctx.fillStyle = '#ffe2c4';
  ctx.beginPath();
  ctx.arc(cx, cy, starR, 0, Math.PI * 2);
  ctx.fill();

  const dots: PlanetDot[] = [];
  sys.planets.forEach((p, i) => {
    const r = p.measured.semiMajorAxisAu.value * AU_M * s;
    const on = i === selected;
    ctx.strokeStyle = on ? 'rgba(127, 212, 255, 0.85)' : 'rgba(138, 160, 192, 0.28)';
    ctx.lineWidth = (on ? 1.5 : 1) * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    const pos = orbitalPosition(p, tSim);
    const x = cx + pos.x * s;
    const y = cy - pos.y * s;
    dots.push({ letter: p.letter, x: x / dpr, y: y / dpr });
    const pr = (2.2 + 2.6 * p.measured.radiusEarth.value) * dpr;
    const pal = p.generated.palette;
    const mid = pal[Math.floor(pal.length / 2)] ?? '#888888';
    const shade = ctx.createRadialGradient(x - pr * 0.4, y - pr * 0.4, pr * 0.1, x, y, pr);
    shade.addColorStop(0, mid);
    shade.addColorStop(1, pal[0] ?? '#444444');
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(x, y, pr, 0, Math.PI * 2);
    ctx.fill();
    if (on) {
      ctx.strokeStyle = '#7fd4ff';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, pr + 4 * dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = on ? '#e8f7ff' : 'rgba(216, 230, 255, 0.8)';
    ctx.font = `${(on ? 12 : 11) * dpr}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lx = x + (x >= cx ? 1 : -1) * (pr + 9 * dpr);
    ctx.fillText(p.letter, lx, y - (pr + 6 * dpr) * 0.6);
  });
  lastDots = dots;
}

function updateClock(): void {
  const d = new Date(tdbSecondsSinceJ2000ToUnixMs(tSim));
  clock.textContent = t('exo.demo.utc', { date: d.toISOString().slice(0, 16).replace('T', ' ') });
}

function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (playing) tSim += dt * speed;
  drawOrbits();
  updateClock();
  requestAnimationFrame(frame);
}

function pickPlanet(ev: MouseEvent): void {
  const rect = orbitCanvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  let best = -1;
  let bestD = 22;
  lastDots.forEach((d, i) => {
    const dd = Math.hypot(d.x - mx, d.y - my);
    if (dd < bestD) {
      bestD = dd;
      best = i;
    }
  });
  if (best >= 0) select(best);
}

function select(i: number): void {
  selected = Math.max(0, Math.min(sys.planets.length - 1, i));
  renderPlanetCard();
  drawOrbits();
}

// --- Page ---------------------------------------------------------------------------------------------------------

function buildTable(): HTMLElement {
  const head = el(
    'tr',
    {},
    ...['planet', 'period', 'radius', 'mass', 'teq', 'insolation', 'terrain'].map((k) => el('th', {}, t(`exo.demo.col.${k}`))),
  );
  sys.planets.forEach((p, i) => {
    const m = p.measured;
    const inf = p.inferred;
    const g = p.generated;
    const sw = el('span', { cls: 'tsw' });
    for (const c of g.palette.slice(0, 5)) sw.append(swatch(c));
    const tr = el(
      'tr',
      { tabIndex: 0 },
      el('td', { cls: 'pl', title: p.name }, el('b', {}, p.letter)),
      el('td', { cls: 'm' }, withUnit(compact(m.periodDays.value, 3), 'd')),
      el('td', { cls: 'm' }, withUnit(compact(m.radiusEarth.value, 3), 'R_earth')),
      el('td', { cls: 'm' }, withUnit(compact(m.massEarth.value, 3), 'M_earth')),
      el('td', { cls: 'i' }, withUnit(compact(inf.equilibriumTempK_A0.value, 0), 'K')),
      el('td', { cls: 'i' }, withUnit(compact(inf.insolationEarth.value, 2), 'S_earth')),
      el('td', { cls: 'g' }, sw, el('span', {}, t(terrainLabelKey(g.terrain)))),
    );
    tr.addEventListener('click', () => select(i));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(i);
      }
    });
    tableBody.append(tr);
  });
  const table = el('table', { cls: 'ptable' }, el('thead', {}, head), tableBody);
  const legend = el(
    'div',
    { cls: 'legend' },
    el('span', {}, el('span', { cls: 'dot dot-measured' }), t('prov.measured')),
    el('span', {}, el('span', { cls: 'dot dot-inferred' }), t('prov.inferred')),
    el('span', {}, el('span', { cls: 'dot dot-generated' }), t('prov.generated')),
  );
  return el('div', { cls: 'table-wrap' }, table, legend);
}

function buildStar(): HTMLElement {
  const st = sys.star;
  const rows: HTMLElement[] = (
    [
      ['teffK', st.teffK],
      ['radiusSun', st.radiusSun],
      ['massSun', st.massSun],
      ['luminositySun', st.luminositySun],
      ['ageGyr', st.ageGyr],
      ['metallicityFeH', st.metallicityFeH],
      ['spectralType', st.spectralType],
      ['vMag', st.vMag],
      ['jMag', st.jMag],
      ['kMag', st.kMag],
      ['gaiaDr3Id', st.gaiaDr3Id],
    ] as const
  ).map(([k, s]) => sourcedRow(`exo.field.${k}`, s, k));
  return el('div', { cls: 'rows' }, ...rows);
}

function buildSystem(): HTMLElement {
  const pos = sys.position;
  const pl = sys.orbitalPlane;
  return el(
    'div',
    { cls: 'rows' },
    sourcedRow('exo.field.distancePc', pos.distancePc, 'distancePc'),
    sourcedRow('exo.field.raDeg', pos.raDeg, 'raDeg'),
    sourcedRow('exo.field.decDeg', pos.decDeg, 'decDeg'),
    sourcedRow('exo.field.planeInclinationDeg', pl.inclinationDeg, 'inclinationDeg'),
    sourcedRow('exo.field.nodeDeg', pl.nodeDeg, 'nodeDeg'),
  );
}

function mark(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('class', 'lab-mark');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<circle cx="16" cy="16" r="3.2" fill="#ffb27a"/>' +
    [6, 8.5, 11, 13.5].map((r, i) => `<circle cx="16" cy="16" r="${r}" fill="none" stroke="rgba(127,212,255,${0.75 - i * 0.15})" stroke-width="0.8"/>`).join('') +
    '<circle cx="22" cy="16" r="1.4" fill="#7fd4ff"/><circle cx="9.5" cy="22.5" r="1.2" fill="#c3cbd2"/>';
  return svg;
}

function build(): void {
  const dist = sys.position.distancePc.value;
  const header = el(
    'header',
    { cls: 'lab-head' },
    el(
      'div',
      { cls: 'lab-title' },
      mark(),
      el('div', {}, el('h1', {}, t('exo.demo.title')), el('p', {}, t('exo.demo.tagline', { d: withUnit(formatNumber(dist, 2, 2), 'pc') }))),
    ),
    el(
      'div',
      { cls: 'pills' },
      el('span', { cls: 'pill' }, t('exo.demo.retrieved', { date: sys.retrieved })),
      el('span', { cls: 'pill on' }, t('exo.demo.count', { n: formatNumber(sys.exoplanetCount.value), date: sys.exoplanetCount.asOf })),
    ),
  );

  const orbits = panel(t('exo.demo.orbits'), t('exo.demo.orbitsMeta'));
  const speeds: [string, number][] = [
    ['exo.demo.speed.hour', 3600],
    ['exo.demo.speed.day', 86_400],
    ['exo.demo.speed.week', 604_800],
  ];
  const seg = el('div', { cls: 'seg', role: 'group' });
  seg.setAttribute('aria-label', t('exo.demo.speed'));
  for (const [k, v] of speeds) {
    const b = el('button', { type: 'button' }, t(k));
    b.setAttribute('aria-pressed', String(v === speed));
    b.addEventListener('click', () => {
      speed = v;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    seg.append(b);
  }
  const syncPlay = (): void => {
    playBtn.textContent = playing ? t('exo.demo.pause') : t('exo.demo.play');
    playBtn.setAttribute('aria-pressed', String(playing));
  };
  playBtn.addEventListener('click', () => {
    playing = !playing;
    syncPlay();
  });
  syncPlay();
  const nowBtn = el('button', { type: 'button', cls: 'chip-btn' }, t('exo.demo.now'));
  nowBtn.addEventListener('click', () => {
    tSim = unixMsToTdbSecondsSinceJ2000(Date.now());
  });
  orbitCanvas.addEventListener('click', pickPlanet);
  orbits.body.append(
    el('div', { cls: 'orbit-wrap' }, orbitCanvas, clock),
    el('div', { cls: 'controls' }, playBtn, nowBtn, seg),
    el('p', { cls: 'foot' }, t('exo.demo.orbitFootnote')),
  );

  const planets = panel(t('exo.demo.planets'), t('exo.demo.planetsMeta'));
  planets.body.append(buildTable());

  const card = panel(t('exo.demo.preview'));
  card.root.classList.add('card');
  card.body.append(planetCard);

  const how = panel(t('exo.demo.howKnow'));
  detailBox.append(el('p', { cls: 'dim' }, t('exo.demo.howHint')));
  how.body.append(detailBox);
  how.root.classList.add('how');

  const star = panel(t('exo.demo.star'), t('exo.demo.starMeta'));
  star.body.append(buildStar());
  const system = panel(t('exo.demo.system'));
  system.body.append(buildSystem());

  const grid = el(
    'div',
    { cls: 'grid' },
    el('div', { cls: 'col col-main' }, orbits.root, planets.root),
    el('div', { cls: 'col col-card' }, card.root),
    el('div', { cls: 'col col-side' }, how.root, star.root, system.root),
  );
  app.replaceChildren(header, grid);
  renderPlanetCard();
}

// --- Boot ---------------------------------------------------------------------------------------------------------

interface ExoHooks {
  system: ExoSystem;
  select(i: number): void;
  setTime(tdbSeconds: number): void;
  pause(): void;
  dots(): PlanetDot[];
  selected(): number;
  previewMs(): number;
}

loadSystem('trappist-1')
  .then((s) => {
    sys = s;
    build();
    requestAnimationFrame((now) => {
      lastFrame = now;
      frame(now);
    });
    const hooks: ExoHooks = {
      system: s,
      select,
      setTime: (v) => {
        tSim = v;
        drawOrbits();
        updateClock();
      },
      pause: () => {
        playing = false;
        playBtn.textContent = t('exo.demo.play');
      },
      dots: () => lastDots,
      selected: () => selected,
      previewMs: () => previewMs,
    };
    (window as unknown as { __ksExo: ExoHooks }).__ksExo = hooks;
  })
  .catch((e: unknown) => {
    status.textContent = t('exo.demo.failed', { reason: e instanceof Error ? e.message : String(e) });
    status.classList.add('error');
  });
