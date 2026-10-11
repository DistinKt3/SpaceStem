/**
 * TRAPPIST-1 data lab (exo.html): loads public/data/systems/trappist-1.json through loadSystem(), draws the orbits at
 * the current time with orbitalPosition(), lists every value with its provenance mark and a "How do we know this?"
 * panel, and previews each planet's generated surface parameters. Exposes window.__ksExo for tests/e2e/exo.spec.ts.
 *
 * Provenance never relies on colour alone: every value carries a mark that differs in shape (filled, half-filled,
 * dotted ring), table columns sit under a Measured / Inferred / Generated group header whose rule is solid, dashed or
 * dotted, and screen readers hear the tier with each value (visually hidden text) and each table column.
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

function attrs<T extends Element>(n: T, a: Record<string, string>): T {
  for (const [k, v] of Object.entries(a)) n.setAttribute(k, v);
  return n;
}

/** Text for screen readers only (exo.html defines .exo-sr). */
const srText = (text: string): HTMLSpanElement => el('span', { cls: 'exo-sr' }, text);

/** Shape mark for a provenance tier: filled disc (measured), half-filled dashed ring (inferred), dotted ring
 * (generated). Decorative: the tier is always also given as text. */
function mark(p: Provenance): HTMLSpanElement {
  return attrs(el('span', { cls: `dot dot-${p}` }), { 'aria-hidden': 'true' });
}

function badge(p: Provenance): HTMLSpanElement {
  const b = el('span', { cls: `exo-prov exo-prov-${p}` }, attrs(el('span', { cls: 'exo-prov-mark' }), { 'aria-hidden': 'true' }), t(`prov.${p}`));
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

/** Power-of-ten form through the locale file: "{v} × 10ⁿ", or "({v}) × 10ⁿ" around a value ± uncertainty. */
function sci(text: string, exp: number, grouped = false): string {
  return exp === 0 ? text : t(grouped ? 'exo.sci.group' : 'exo.sci', { v: text, e: superscript(exp) });
}

const uncertainties = (s: ExoSourced<unknown>): number[] => {
  const u = s.uncertainty;
  return u === undefined ? [] : typeof u === 'number' ? [u] : [u[0], u[1]];
};

interface Scale {
  /** Power of ten the value is shown with (0 unless |value| < 1e-3). */
  readonly exp: number;
  readonly k: number;
  readonly d: number;
  readonly epoch: boolean;
}

/**
 * Precision a value is shown with: as catalogued, but no more than one digit beyond the two significant digits of
 * its uncertainty. Very small values use a power-of-ten factor.
 */
function scaleOf(s: ExoSourced<number>): Scale {
  const exp = s.value !== 0 && Math.abs(s.value) < 1e-3 ? Math.floor(Math.log10(Math.abs(s.value))) : 0;
  const k = Math.pow(10, -exp);
  const clean = (x: number): number => Number((x * k).toPrecision(12));
  // JSON drops trailing zeros (0.920 -> 0.92), so the uncertainty sets the precision when there is one.
  let d = decimalsOf(clean(s.value));
  const positive = uncertainties(s).filter((x) => x > 0);
  if (positive.length > 0) {
    const du = Math.max(...positive.map((x) => Math.min(decimalsOf(clean(x)), 1 - Math.floor(Math.log10(clean(x))))));
    d = Math.max(du, Math.min(d, du + 1));
  }
  d = Math.max(0, Math.min(MAX_DECIMALS, d));
  return { exp, k, d, epoch: s.unit === 'BJD_TDB' };
}

// Epochs (BJD) are written without digit grouping, as is conventional.
const scaled = (x: number, sc: Scale): string => (sc.epoch ? (x * sc.k).toFixed(sc.d) : formatNumber(x * sc.k, sc.d, sc.d));

function numberText(s: ExoSourced<number>): string {
  const sc = scaleOf(s);
  const u = s.uncertainty;
  const v = scaled(s.value, sc);
  // Uncertainties too small to show at the value's precision (sky positions, epochs) appear in the detail panel only.
  const tiny = uncertainties(s).some((x) => Number((x * sc.k).toFixed(sc.d)) === 0);
  if (u === undefined || tiny || sc.epoch) return withUnit(sci(v, sc.exp), s.unit);
  const text = typeof u === 'number' ? t('exo.pm.sym', { v, u: scaled(u, sc) }) : t('exo.pm.asym', { v, lo: scaled(u[0], sc), hi: scaled(u[1], sc) });
  return withUnit(sci(text, sc.exp, true), s.unit);
}

/** Two significant digits (fewer if catalogued so); a power of ten when that needs more than MAX_DECIMALS places. */
function shortNumber(x: number): string {
  if (x === 0) return formatNumber(0);
  const c = Number(x.toPrecision(12));
  const need = 1 - Math.floor(Math.log10(c));
  if (need > MAX_DECIMALS) {
    const exp = Math.floor(Math.log10(c));
    return sci(formatNumber(c * Math.pow(10, -exp), 1, 1), exp);
  }
  const d = Math.max(0, Math.min(decimalsOf(c), need));
  return formatNumber(c, d, d);
}

/** Uncertainty for the "How do we know this?" panel, in the same order (+upper / −lower) and unit as the value rows. */
function uncertaintyText(s: ExoSourced<unknown>): string {
  const u = s.uncertainty;
  if (u === undefined || typeof s.value !== 'number') return t('exo.demo.none');
  const sc = scaleOf(s as ExoSourced<number>);
  // A value shown with a power of ten keeps the same factor here, so the two read alike.
  const one = (x: number): string => (sc.exp !== 0 ? sci(scaled(x, sc), sc.exp) : shortNumber(x));
  const text = typeof u === 'number' ? t('exo.pm.symOnly', { u: one(u) }) : t('exo.pm.asymOnly', { hi: one(u[1]), lo: one(u[0]) });
  return withUnit(text, sc.epoch ? 'd' : s.unit);
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
/** The orbit view needs a redraw (time, size or selection changed). */
let orbitsDirty = true;

interface Detail {
  label: string;
  provenance: Provenance;
  value: string;
  uncertainty: string;
  source: string;
  citation: string;
  note: string;
}

const DETAIL_ID = 'exo-detail';
const detailBox = attrs(el('div', { cls: 'detail', id: DETAIL_ID }), { 'aria-live': 'polite' });
const orbitCanvas = attrs(el('canvas', { cls: 'orbits' }), { role: 'img' });
const clock = el('span', { cls: 'clock' });
const planetCard = el('div', { cls: 'planet-card' });
const tableBody = el('tbody');
const playBtn = el('button', { type: 'button', cls: 'chip-btn' });
let howPanel: HTMLElement | undefined;
const clockFormat = new Intl.DateTimeFormat(document.documentElement.lang || 'en', {
  dateStyle: 'medium',
  timeStyle: 'short',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

// --- Detail panel -------------------------------------------------------------------------------------------------

function citationNode(key: string): Node {
  const c = sys.citations[key];
  if (!c) return document.createTextNode(key);
  // Bibliographic data, not translatable prose: authors (year). Title. Venue.
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

/** After a user's click, bring the detail panel into view if it is off screen (narrow layouts put it lower). */
function revealDetail(): void {
  const target = howPanel ?? detailBox;
  const r = target.getBoundingClientRect();
  if (r.top < 0 || r.bottom > window.innerHeight) target.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
}

function sourcedDetail(label: string, s: ExoSourced<unknown>, field: string): Detail {
  return {
    label,
    provenance: s.provenance,
    value: valueText(s, field),
    uncertainty: uncertaintyText(s),
    source: s.source,
    citation: s.citation,
    note: s.note ?? '',
  };
}

function valueRow(label: string, value: string, p: Provenance, detail: () => Detail): HTMLButtonElement {
  // Accessible name: "<label> <value> <tier>", e.g. "Orbital plane orientation 0° Generated".
  const b = el('button', { type: 'button', cls: 'vrow' }, el('span', { cls: 'k' }, label), el('span', { cls: 'v' }, value), mark(p), srText(t(`prov.${p}`)));
  attrs(b, { 'data-prov': p, 'aria-controls': DETAIL_ID });
  b.addEventListener('click', (ev) => {
    document.querySelectorAll('.vrow.on').forEach((n) => {
      n.classList.remove('on');
      n.removeAttribute('aria-current');
    });
    b.classList.add('on');
    b.setAttribute('aria-current', 'true');
    showDetail(detail());
    if (ev.isTrusted) revealDetail();
  });
  return b;
}

function sourcedRow(labelKey: string, s: ExoSourced<unknown>, field: string): HTMLButtonElement {
  const label = t(labelKey);
  return valueRow(label, valueText(s, field), s.provenance, () => sourcedDetail(label, s, field));
}

// --- Planet card ------------------------------------------------------------------------------------------------

const PREVIEW_PX = 240;
const previewCanvas = el('canvas', { cls: 'preview', width: PREVIEW_PX, height: PREVIEW_PX });
previewCanvas.setAttribute('aria-hidden', 'true');

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
  const swatches = attrs(el('div', { cls: 'swatches', title: t('exo.demo.palette') }), { 'aria-hidden': 'true' });
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
      el('figure', { cls: 'preview-fig' }, previewCanvas, el('figcaption', {}, t('exo.demo.previewCaption'))),
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
  showPreview(selected);
  const first = measured[0];
  if (first) first.click();
  for (const [i, tr] of [...tableBody.children].entries()) {
    const on = i === selected;
    tr.classList.toggle('on', on);
    const btn = tr.querySelector('button');
    if (on) btn?.setAttribute('aria-current', 'true');
    else btn?.removeAttribute('aria-current');
  }
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
 * young volcanic plains), ice away from the substellar point (the planets are expected, not known, to be tidally
 * locked) covering iceCoverage of the sphere, and thin glowing fissures on the night side scaled by nightSideGlow.
 * Lit by an approximately 2,566 K blackbody colour. No atmosphere is drawn because none is supported by observations.
 *
 * A generator that fills `img` one pixel row at a time and yields after each row, so the caller can spread the work
 * over short slices and keep the page responsive.
 */
function* surfaceRows(img: ImageData, planet: ExoPlanet): Generator<number, void, void> {
  const g = planet.generated;
  const n = img.width;
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
        const proj = x * (x - c.x) + y * (y - c.y) + z * (z - c.z);
        let vx = x - c.x - proj * x;
        let vy = y - c.y - proj * y;
        let vz = z - c.z - proj * z;
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
      let col = volcanic ? ramp(rockCols, 0.32 + h0 * 0.45 - smooth(0.9, 0.985, ridge) * 0.25) : ramp(rockCols, 0.5 + h * 0.5);
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
    yield py;
  }
}

// Previews are rendered once per planet and cached. The selected planet renders in short slices (a scan from top to
// bottom), so selecting a planet never blocks the page; the others render in idle time afterwards.
interface PreviewJob {
  readonly img: ImageData;
  readonly rows: Generator<number, void, void>;
  cpuMs: number;
}
const previewCache = new Map<number, { img: ImageData; cpuMs: number }>();
const previewJobs = new Map<number, PreviewJob>();
const previewWaiters: (() => void)[] = [];
const SLICE_MS = 8;
const PREVIEW_PAINT_MS = 120;
let lastPreviewPaint = 0;
let maxSliceMs = 0;
let fastQueued = false;
let idleHandle: number | undefined;
const fastChannel = new MessageChannel();
fastChannel.port1.onmessage = () => {
  fastQueued = false;
  pumpPreview();
};

function previewContext(): CanvasRenderingContext2D | null {
  return previewCanvas.getContext('2d');
}

function nextPreview(): number | undefined {
  if (!previewCache.has(selected)) return selected;
  for (let i = 0; i < sys.planets.length; i++) if (!previewCache.has(i)) return i;
  return undefined;
}

function queuePreview(): void {
  const next = nextPreview();
  if (next === undefined) return;
  if (next === selected) {
    if (idleHandle !== undefined) cancelIdleCallback(idleHandle);
    idleHandle = undefined;
    if (!fastQueued) {
      fastQueued = true;
      fastChannel.port2.postMessage(0);
    }
  } else if (idleHandle === undefined && !fastQueued) {
    idleHandle = requestIdleCallback(
      () => {
        idleHandle = undefined;
        pumpPreview();
      },
      { timeout: 1500 },
    );
  }
}

function pumpPreview(): void {
  const i = nextPreview();
  if (i === undefined) return;
  let job = previewJobs.get(i);
  if (!job) {
    const img = new ImageData(PREVIEW_PX, PREVIEW_PX);
    job = { img, rows: surfaceRows(img, sys.planets[i]!), cpuMs: 0 };
    previewJobs.set(i, job);
  }
  const t0 = performance.now();
  let done = false;
  while (performance.now() - t0 < SLICE_MS) {
    if (job.rows.next().done) {
      done = true;
      break;
    }
  }
  const dt = performance.now() - t0;
  job.cpuMs += dt;
  maxSliceMs = Math.max(maxSliceMs, dt);
  if (done) {
    previewJobs.delete(i);
    previewCache.set(i, { img: job.img, cpuMs: job.cpuMs });
  }
  if (i === selected) {
    // Show progress a few times a second, not after every slice: each paint makes the browser repaint the glass
    // panels around the canvas, which is slow with software compositing and would starve the slices.
    const now = performance.now();
    if (done || now - lastPreviewPaint > PREVIEW_PAINT_MS) {
      lastPreviewPaint = now;
      previewContext()?.putImageData(job.img, 0, 0);
    }
    if (done) for (const w of previewWaiters.splice(0)) w();
  }
  queuePreview();
}

function showPreview(i: number): void {
  const ctx = previewContext();
  const cached = previewCache.get(i);
  if (cached) {
    ctx?.putImageData(cached.img, 0, 0);
    for (const w of previewWaiters.splice(0)) w();
    return;
  }
  const partial = previewJobs.get(i);
  if (partial) ctx?.putImageData(partial.img, 0, 0);
  else ctx?.clearRect(0, 0, PREVIEW_PX, PREVIEW_PX);
  queuePreview();
}

function previewReady(): Promise<void> {
  return previewCache.has(selected) ? Promise.resolve() : new Promise((resolve) => previewWaiters.push(resolve));
}

// --- Orbits -------------------------------------------------------------------------------------------------------

interface PlanetDot {
  letter: string;
  x: number;
  y: number;
}
let lastDots: PlanetDot[] = [];
let orbitDraws = 0;

function drawOrbits(): void {
  orbitDraws++;
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
  const labels: { text: string; x: number; y: number; on: boolean }[] = [];
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
    // Label on the trailing side along the orbit (planets move counter-clockwise), outside the selection ring: it
    // stays on its own orbit instead of landing on a neighbouring one.
    const rr = Math.hypot(x - cx, y - cy) || 1;
    const off = pr + 11 * dpr;
    labels.push({ text: p.letter, x: x + (-(y - cy) / rr) * off, y: y + ((x - cx) / rr) * off, on });
  });
  // Labels last, with a dark halo, so no orbit line or dot is drawn over them.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const l of labels) {
    ctx.font = `${l.on ? 600 : 400} ${(l.on ? 12 : 11) * dpr}px ui-monospace, monospace`;
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(2, 6, 14, 0.85)';
    ctx.strokeText(l.text, l.x, l.y);
    ctx.fillStyle = l.on ? '#e8f7ff' : 'rgba(216, 230, 255, 0.8)';
    ctx.fillText(l.text, l.x, l.y);
  }
  lastDots = dots;
}

function updateClock(): void {
  clock.textContent = t('exo.demo.utc', { date: clockFormat.format(new Date(tdbSecondsSinceJ2000ToUnixMs(tSim))) });
}

function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (playing) {
    tSim += dt * speed;
    orbitsDirty = true;
  }
  // Paused and unchanged: nothing to redraw.
  if (orbitsDirty) {
    orbitsDirty = false;
    drawOrbits();
    updateClock();
  }
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
  orbitCanvas.setAttribute('aria-label', t('exo.demo.orbitsAlt', { planet: sys.planets[selected]!.name }));
  renderPlanetCard();
  drawOrbits();
}

// --- Page ---------------------------------------------------------------------------------------------------------

interface Column {
  readonly key: string;
  readonly prov: Provenance;
  readonly cell: (p: ExoPlanet) => (Node | string)[];
}

/** Table columns, grouped by provenance. Units sit in the headers; cells hold numbers. */
const COLUMNS: readonly Column[] = [
  { key: 'radius', prov: 'measured', cell: (p) => [compact(p.measured.radiusEarth.value, 3)] },
  { key: 'mass', prov: 'measured', cell: (p) => [compact(p.measured.massEarth.value, 3)] },
  { key: 'period', prov: 'inferred', cell: (p) => [compact(p.inferred.ephemerisPeriodDays.value, 4)] },
  { key: 'teq', prov: 'inferred', cell: (p) => [compact(p.inferred.equilibriumTempK_A0.value, 0)] },
  { key: 'insolation', prov: 'inferred', cell: (p) => [compact(p.inferred.insolationEarth.value, 2)] },
  {
    key: 'terrain',
    prov: 'generated',
    cell: (p) => {
      const sw = attrs(el('span', { cls: 'tsw' }), { 'aria-hidden': 'true' });
      for (const c of p.generated.palette.slice(0, 5)) sw.append(swatch(c));
      return [sw, el('span', {}, t(terrainLabelKey(p.generated.terrain)))];
    },
  },
];

function buildTable(): HTMLElement {
  // Group header row: one Measured / Inferred / Generated badge over its columns.
  const groups = el('tr', { cls: 'groups' }, attrs(el('td', { cls: 'corner' }), { 'aria-hidden': 'true' }));
  const firstOfGroup = new Set<string>();
  for (let i = 0; i < COLUMNS.length; ) {
    const prov = COLUMNS[i]!.prov;
    let n = 0;
    while (COLUMNS[i + n]?.prov === prov) n++;
    firstOfGroup.add(COLUMNS[i]!.key);
    groups.append(attrs(el('th', { cls: `grp grp-${prov}`, id: `pt-g-${prov}` }, badge(prov)), { scope: 'colgroup', colspan: String(n), 'data-prov': prov }));
    i += n;
  }
  const head = el('tr', { cls: 'cols' }, attrs(el('th', { cls: 'pl', id: 'pt-c-planet' }, t('exo.demo.col.planet')), { scope: 'col' }));
  for (const c of COLUMNS) {
    const th = el(
      'th',
      { cls: `c c-${c.prov}${firstOfGroup.has(c.key) ? ' first' : ''}`, id: `pt-c-${c.key}` },
      el('span', { cls: 'h' }, t(`exo.demo.col.${c.key}`)),
    );
    const unitKey = `exo.demo.colUnit.${c.key}`;
    if (hasKey(unitKey)) th.append(el('span', { cls: 'u' }, t(unitKey)));
    th.append(srText(t(`prov.${c.prov}`)));
    head.append(attrs(th, { scope: 'col', 'data-prov': c.prov }));
  }
  sys.planets.forEach((p, i) => {
    const pick = attrs(el('button', { type: 'button', cls: 'pl-btn' }, p.letter), { 'aria-label': p.name, 'aria-controls': 'exo-card' });
    const rowHead = attrs(el('th', { cls: 'pl', id: `pt-r-${p.letter}` }, pick), { scope: 'row' });
    const tr = el('tr', {}, rowHead);
    for (const c of COLUMNS) {
      const td = el('td', { cls: `v-${c.prov}${firstOfGroup.has(c.key) ? ' first' : ''}${c.prov === 'generated' ? ' g' : ' num'}` }, ...c.cell(p));
      tr.append(attrs(td, { 'data-prov': c.prov, headers: `pt-r-${p.letter} pt-g-${c.prov} pt-c-${c.key}` }));
    }
    // The whole row is a pointer target; keyboard users use the planet button.
    tr.addEventListener('click', () => select(i));
    tableBody.append(tr);
  });
  const table = el('table', { cls: 'ptable' }, el('caption', { cls: 'exo-sr' }, t('exo.demo.tableCaption')), el('thead', {}, groups, head), tableBody);
  const legend = el(
    'div',
    { cls: 'legend' },
    ...(['measured', 'inferred', 'generated'] as const).map((p) => el('span', {}, mark(p), t(`prov.${p}`))),
    el('span', { cls: 'legend-note' }, t('exo.demo.legendNote')),
  );
  // On narrow screens the table scrolls sideways; a fade on the right edge says so until the end is reached.
  const wrap = el('div', { cls: 'table-wrap' }, table);
  const scroller = el('div', { cls: 'table-scroll' }, wrap);
  const updateFade = (): void => {
    scroller.classList.toggle('more', wrap.scrollWidth - wrap.clientWidth - wrap.scrollLeft > 2);
  };
  wrap.addEventListener('scroll', updateFade, { passive: true });
  new ResizeObserver(updateFade).observe(wrap);
  return el('div', { cls: 'table-block' }, scroller, legend);
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

function labMark(): SVGSVGElement {
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

function syncPlay(): void {
  playBtn.textContent = playing ? t('exo.demo.pause') : t('exo.demo.play');
  playBtn.setAttribute('aria-pressed', String(playing));
}

function build(): void {
  const dist = sys.position.distancePc.value;
  const header = el(
    'header',
    { cls: 'lab-head' },
    el(
      'div',
      { cls: 'lab-title' },
      labMark(),
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
  const seg = attrs(el('div', { cls: 'seg' }), { role: 'group', 'aria-label': t('exo.demo.speed') });
  for (const [k, v] of speeds) {
    const b = el('button', { type: 'button' }, t(k));
    b.setAttribute('aria-pressed', String(v === speed));
    b.addEventListener('click', () => {
      speed = v;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    seg.append(b);
  }
  playBtn.addEventListener('click', () => {
    playing = !playing;
    syncPlay();
  });
  syncPlay();
  const nowBtn = el('button', { type: 'button', cls: 'chip-btn' }, t('exo.demo.now'));
  nowBtn.addEventListener('click', () => {
    tSim = unixMsToTdbSecondsSinceJ2000(Date.now());
    orbitsDirty = true;
  });
  orbitCanvas.addEventListener('click', pickPlanet);
  new ResizeObserver(() => {
    orbitsDirty = true;
  }).observe(orbitCanvas);
  orbits.body.append(
    el('div', { cls: 'orbit-wrap' }, orbitCanvas, clock),
    el('div', { cls: 'controls' }, playBtn, nowBtn, seg),
    el('p', { cls: 'foot' }, t('exo.demo.orbitFootnote')),
  );

  const planets = panel(t('exo.demo.planets'), t('exo.demo.planetsMeta'));
  planets.body.append(buildTable());

  const card = panel(t('exo.demo.preview'));
  card.root.classList.add('card');
  card.root.id = 'exo-card';
  card.body.append(planetCard);

  const how = panel(t('exo.demo.howKnow'));
  detailBox.append(el('p', { cls: 'dim' }, t('exo.demo.howHint')));
  how.body.append(detailBox);
  how.root.classList.add('how');
  howPanel = how.root;

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
  select(selected);
}

// --- Boot ---------------------------------------------------------------------------------------------------------

interface ExoHooks {
  system: ExoSystem;
  select(i: number): void;
  setTime(tdbSeconds: number): void;
  pause(): void;
  dots(): PlanetDot[];
  selected(): number;
  /** Resolves when the selected planet's surface preview is complete. */
  previewReady(): Promise<void>;
  /** Main-thread time spent rendering the selected planet's preview (ms, summed over its slices). */
  previewMs(): number;
  /** Longest single preview slice so far (ms): how long a preview ever blocks the page at once. */
  maxPreviewSliceMs(): number;
  /** Planets whose preview is cached. */
  cachedPreviews(): number[];
  /** Number of orbit-view redraws so far (stays put while paused). */
  orbitDraws(): number;
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
        syncPlay();
      },
      dots: () => lastDots,
      selected: () => selected,
      previewReady,
      previewMs: () => previewCache.get(selected)?.cpuMs ?? previewJobs.get(selected)?.cpuMs ?? 0,
      maxPreviewSliceMs: () => maxSliceMs,
      cachedPreviews: () => [...previewCache.keys()].sort((a, b) => a - b),
      orbitDraws: () => orbitDraws,
    };
    (window as unknown as { __ksExo: ExoHooks }).__ksExo = hooks;
  })
  .catch((e: unknown) => {
    status.textContent = t('exo.demo.failed', { reason: e instanceof Error ? e.message : String(e) });
    status.classList.add('error');
  });
