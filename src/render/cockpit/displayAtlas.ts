/**
 * Static display art for the cockpit panels, drawn with Canvas 2D into one opaque RGB atlas canvas that is uploaded
 * as a texture directly (no pixel readback):
 *   R primary line art and labels, G a blurred copy of R (glow), B secondary (dim) art.
 * The panel backplates are analytic in the shaders (rounded rectangles plus darker plates behind the readouts, see
 * PLATES). Everything that moves (bars, arcs, markers, digits, the active mode) is drawn per pixel in the TSL panel
 * shaders using the layout constants below, so the atlas is only redrawn when the locale changes.
 *
 * Layout numbers are in atlas design pixels (ATLAS_W x ATLAS_H); the canvas itself may be drawn at a lower
 * resolution (quality 'low'), and the shaders sample in normalised coordinates, so the layout does not change.
 */
import { t, formatNumber } from '../../game/i18n';
import type { PanelKind } from './geometry';
import { percentLayout } from './state';

export const ATLAS_W = 2048;
export const ATLAS_H = 1024;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Box = readonly [number, number, number, number];

export const REGIONS: Record<PanelKind, Rect> = {
  throttle: { x: 0, y: 0, w: 480, h: 320 },
  speed: { x: 480, y: 0, w: 480, h: 320 },
  attitude: { x: 960, y: 0, w: 448, h: 350 },
  mode: { x: 1408, y: 0, w: 384, h: 384 },
  status: { x: 0, y: 384, w: 384, h: 384 },
};

/** Glyph strip: digits 0-9 then the percent unit. */
export const DIGITS = { x: 400, y: 400, glyphW: 56, h: 84, count: 11 };
/** Mode names, one row each (thrusters, impulse, cruise, hyperspeed). */
export const MODE_STRIP = { x: 400, y: 500, w: 448, rowH: 60, rows: 4 };
/** Status words: nominal, alert. */
export const STATUS_STRIP = { x: 860, y: 500, w: 448, rowH: 60, rows: 2 };

/** Panel-local layouts in region pixels (origin top-left). Boxes are [x0, y0, x1, y1]. */
export const LAYOUT = {
  throttle: {
    bar: [44, 76, 96, 286] as const,
    segments: 20,
    digits: [176, 88, 452, 186] as const,
    modeLabelY: 240,
    modeBox: [184, 250, 444, 288] as const,
  },
  speed: {
    cx: 240,
    cy: 196,
    r: 104,
    width: 13,
    /** Sweep from -a to +a radians, measured clockwise from straight up. */
    a: (120 * Math.PI) / 180,
    digits: [160, 160, 320, 216] as const,
  },
  attitude: {
    cx: 224,
    cy: 198,
    /** Radius of the 90 degree ring (directions perpendicular to forward). */
    r90: 112,
    rMax: 140,
  },
  mode: {
    rowY0: 82,
    rowH: 70,
    x0: 18,
    x1: 366,
  },
  status: {
    word: [20, 70, 364, 116] as const,
    sunBar: [24, 180, 360, 194] as const,
    alertBar: [24, 252, 360, 266] as const,
    wave: [24, 296, 360, 360] as const,
  },
};

/** Darker backing plates behind readouts and labels (region pixels), so text stays readable over a bright planet. */
export const PLATES: Record<PanelKind, readonly Box[]> = {
  throttle: [
    [20, 58, 172, 304],
    [168, 76, 460, 300],
  ],
  speed: [[52, 64, 428, 304]],
  attitude: [[30, 40, 418, 340]],
  mode: [[12, 70, 372, 368]],
  status: [[12, 60, 372, 372]],
};

export const MODE_KEYS = ['thrusters', 'impulse', 'cruise', 'hyperspeed'] as const;

interface Layers {
  prim: CanvasRenderingContext2D;
  sec: CanvasRenderingContext2D;
}

interface Fonts {
  ui: string;
  mono: string;
}

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function makeCanvas(scale: number): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = Math.round(ATLAS_W * scale);
  c.height = Math.round(ATLAS_H * scale);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

function makeLayer(scale: number): CanvasRenderingContext2D {
  const ctx = makeCanvas(scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return ctx;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

const up = (s: string): string => s.toLocaleUpperCase();

/** Fit text into a width by shrinking the font. */
function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, size: number, weight: number, family: string, spacing = 0.12): void {
  let s = size;
  for (; s > 8; s -= 1) {
    ctx.font = `${weight} ${s}px ${family}`;
    ctx.letterSpacing = `${(s * spacing).toFixed(1)}px`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  ctx.fillText(text, x, y);
  ctx.letterSpacing = '0px';
}

/** Frame common to every panel: thin outline, bright corner brackets, title. */
function panelFrame(L: Layers, r: Rect, title: string, fonts: Fonts): void {
  const { prim, sec } = L;
  const x = r.x + 6;
  const y = r.y + 6;
  const w = r.w - 12;
  const h = r.h - 12;
  sec.lineWidth = 2;
  roundRect(sec, x, y, w, h, 14);
  sec.stroke();
  prim.lineWidth = 3.5;
  const b = 22;
  for (const [cx, cy, dx, dy] of [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1],
  ] as const) {
    prim.beginPath();
    prim.moveTo(cx + dx * b, cy + dy * 2);
    prim.lineTo(cx + dx * 2, cy + dy * 2);
    prim.lineTo(cx + dx * 2, cy + dy * b);
    prim.stroke();
  }
  // Title (primary, so it reads as a heading) and a short rule under it.
  prim.textBaseline = 'alphabetic';
  prim.textAlign = 'left';
  fitText(prim, up(title), r.x + 24, r.y + 44, r.w * 0.62, 27, 600, fonts.ui, 0.2);
  sec.lineWidth = 2.5;
  sec.beginPath();
  sec.moveTo(r.x + 24, r.y + 56);
  sec.lineTo(r.x + 72, r.y + 56);
  sec.stroke();
}

function drawThrottle(L: Layers, fonts: Fonts): void {
  const r = REGIONS.throttle;
  const T = LAYOUT.throttle;
  panelFrame(L, r, t('cockpit.throttle'), fonts);
  const { prim, sec } = L;
  const [x0, y0, x1, y1] = T.bar;
  sec.lineWidth = 2;
  roundRect(sec, r.x + x0 - 6, r.y + y0 - 6, x1 - x0 + 12, y1 - y0 + 12, 6);
  sec.stroke();
  // Ticks every 25 %, labels at 0, 50 and 100 %.
  sec.font = `600 23px ${fonts.mono}`;
  sec.textAlign = 'left';
  sec.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const y = r.y + y1 - ((y1 - y0) * k) / 4;
    sec.lineWidth = 2.5;
    sec.beginPath();
    sec.moveTo(r.x + x1 + 10, y);
    sec.lineTo(r.x + x1 + (k % 2 === 0 ? 26 : 19), y);
    sec.stroke();
    if (k % 2 === 0) sec.fillText(formatNumber(k * 25), r.x + x1 + 32, y + 1);
  }
  // Readout underline and the mode caption.
  const [dx0, , dx1, dy1] = T.digits;
  prim.lineWidth = 2.5;
  prim.beginPath();
  prim.moveTo(r.x + dx0 + 8, r.y + dy1 + 14);
  prim.lineTo(r.x + dx1 - 8, r.y + dy1 + 14);
  prim.stroke();
  sec.textBaseline = 'alphabetic';
  fitText(sec, up(t('cockpit.mode')), r.x + T.modeBox[0], r.y + T.modeLabelY, 240, 23, 600, fonts.ui, 0.2);
}

function drawSpeed(L: Layers, fonts: Fonts): void {
  const r = REGIONS.speed;
  const S = LAYOUT.speed;
  panelFrame(L, r, t('cockpit.speed'), fonts);
  const { sec, prim } = L;
  const cx = r.x + S.cx;
  const cy = r.y + S.cy;
  // Track (dim) just inside and outside the fill band.
  sec.lineWidth = 2;
  for (const rr of [S.r - S.width / 2 - 5, S.r + S.width / 2 + 5]) {
    sec.beginPath();
    sec.arc(cx, cy, rr, -Math.PI / 2 - S.a, -Math.PI / 2 + S.a);
    sec.stroke();
  }
  // Ticks every 10 %, long every 50 %.
  for (let k = 0; k <= 10; k++) {
    const a = -S.a + (2 * S.a * k) / 10;
    const long = k % 5 === 0;
    const r0 = S.r + S.width / 2 + 9;
    const r1 = r0 + (long ? 16 : 9);
    const ctx = long ? prim : sec;
    ctx.lineWidth = long ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0);
    ctx.lineTo(cx + Math.sin(a) * r1, cy - Math.cos(a) * r1);
    ctx.stroke();
  }
  sec.font = `600 23px ${fonts.mono}`;
  sec.textAlign = 'center';
  sec.textBaseline = 'middle';
  const rl = S.r + S.width / 2 + 40;
  sec.fillText(formatNumber(0), cx + Math.sin(-S.a) * rl, cy - Math.cos(-S.a) * rl);
  sec.fillText(formatNumber(100), cx + Math.sin(S.a) * rl, cy - Math.cos(S.a) * rl);
  sec.textBaseline = 'alphabetic';
  sec.textAlign = 'center';
  fitText(sec, up(t('cockpit.ofModeLimit')), cx, r.y + S.digits[3] + 21, 150, 19, 600, fonts.ui, 0.12);
  sec.textAlign = 'left';
}

function drawAttitude(L: Layers, fonts: Fonts): void {
  const r = REGIONS.attitude;
  const A = LAYOUT.attitude;
  panelFrame(L, r, t('cockpit.attitude'), fonts);
  const { sec, prim } = L;
  const cx = r.x + A.cx;
  const cy = r.y + A.cy;
  // Rings at 30 and 60 (dashed) and 90 degrees from forward.
  sec.lineWidth = 2;
  sec.setLineDash([6, 8]);
  for (const deg of [30, 60]) {
    sec.beginPath();
    sec.arc(cx, cy, (A.r90 * deg) / 90, 0, Math.PI * 2);
    sec.stroke();
  }
  sec.setLineDash([]);
  prim.lineWidth = 2.5;
  prim.beginPath();
  prim.arc(cx, cy, A.r90, 0, Math.PI * 2);
  prim.stroke();
  // Cross hair with a gap at the centre (forward).
  sec.lineWidth = 1.6;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    sec.beginPath();
    sec.moveTo(cx + dx * 12, cy + dy * 12);
    sec.lineTo(cx + dx * (A.r90 - 6), cy + dy * (A.r90 - 6));
    sec.stroke();
  }
  // Bearing ticks every 30 degrees on the 90 degree ring.
  prim.lineWidth = 2.5;
  for (let k = 0; k < 12; k++) {
    const a = (k * Math.PI) / 6;
    const r0 = A.r90 + 4;
    const r1 = A.r90 + (k % 3 === 0 ? 16 : 10);
    prim.beginPath();
    prim.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0);
    prim.lineTo(cx + Math.sin(a) * r1, cy - Math.cos(a) * r1);
    prim.stroke();
  }
  // Forward reticle.
  prim.lineWidth = 2.5;
  prim.beginPath();
  prim.arc(cx, cy, 6, 0, Math.PI * 2);
  prim.stroke();
  // Legend: sun glyph + label (bottom left), planet glyph + label (bottom right).
  const ly = r.y + r.h - 20;
  prim.beginPath();
  prim.arc(r.x + 30, ly - 8, 7, 0, Math.PI * 2);
  prim.fill();
  sec.textBaseline = 'alphabetic';
  sec.textAlign = 'left';
  fitText(sec, up(t('cockpit.sun')), r.x + 46, ly, 100, 22, 600, fonts.ui, 0.16);
  prim.lineWidth = 2.5;
  prim.beginPath();
  prim.arc(r.x + r.w - 150, ly - 8, 8, 0, Math.PI * 2);
  prim.stroke();
  fitText(sec, up(t('cockpit.planet')), r.x + r.w - 134, ly, 118, 22, 600, fonts.ui, 0.16);
}

function drawMode(L: Layers, fonts: Fonts): void {
  const r = REGIONS.mode;
  const M = LAYOUT.mode;
  panelFrame(L, r, t('cockpit.drive'), fonts);
  const { sec, prim } = L;
  MODE_KEYS.forEach((key, i) => {
    const y = r.y + M.rowY0 + i * M.rowH;
    sec.lineWidth = 2;
    roundRect(sec, r.x + M.x0, y + 6, M.x1 - M.x0, M.rowH - 12, 8);
    sec.stroke();
    sec.font = `600 23px ${fonts.mono}`;
    sec.textBaseline = 'middle';
    sec.textAlign = 'center';
    sec.fillText(formatNumber(i + 1), r.x + M.x0 + 26, y + M.rowH / 2 + 1);
    prim.textBaseline = 'middle';
    prim.textAlign = 'left';
    fitText(prim, up(t(`cockpit.mode.${key}`)), r.x + M.x0 + 52, y + M.rowH / 2 + 1, M.x1 - M.x0 - 96, 27, 600, fonts.ui, 0.12);
  });
}

function drawStatus(L: Layers, fonts: Fonts): void {
  const r = REGIONS.status;
  const S = LAYOUT.status;
  panelFrame(L, r, t('cockpit.status'), fonts);
  const { sec } = L;
  sec.textBaseline = 'alphabetic';
  sec.textAlign = 'left';
  fitText(sec, up(t('cockpit.sunlight')), r.x + S.sunBar[0], r.y + S.sunBar[1] - 14, 320, 22, 600, fonts.ui, 0.16);
  fitText(sec, up(t('cockpit.alertLevel')), r.x + S.alertBar[0], r.y + S.alertBar[1] - 14, 320, 22, 600, fonts.ui, 0.16);
  sec.lineWidth = 2;
  for (const b of [S.sunBar, S.alertBar]) {
    roundRect(sec, r.x + b[0] - 4, r.y + b[1] - 4, b[2] - b[0] + 8, b[3] - b[1] + 8, 5);
    sec.stroke();
  }
  // Waveform window grid.
  const [wx0, wy0, wx1, wy1] = S.wave;
  sec.lineWidth = 1.2;
  for (let k = 0; k <= 6; k++) {
    const x = r.x + wx0 + ((wx1 - wx0) * k) / 6;
    sec.beginPath();
    sec.moveTo(x, r.y + wy0);
    sec.lineTo(x, r.y + wy1);
    sec.stroke();
  }
  sec.beginPath();
  sec.moveTo(r.x + wx0, r.y + (wy0 + wy1) / 2);
  sec.lineTo(r.x + wx1, r.y + (wy0 + wy1) / 2);
  sec.stroke();
}

function drawStrips(L: Layers, fonts: Fonts, unit: string): void {
  const { prim } = L;
  // Digits and the percent unit, centred in fixed cells (monospace look regardless of font).
  prim.textAlign = 'center';
  prim.textBaseline = 'middle';
  for (let i = 0; i < DIGITS.count; i++) {
    const cx = DIGITS.x + DIGITS.glyphW * (i + 0.5);
    if (i < 10) {
      prim.font = `500 78px ${fonts.mono}`;
      prim.fillText(formatNumber(i), cx, DIGITS.y + DIGITS.h * 0.53);
    } else {
      fitText(prim, unit, cx, DIGITS.y + DIGITS.h * 0.62, DIGITS.glyphW - 4, 50, 400, fonts.mono, 0);
    }
  }
  prim.textAlign = 'left';
  MODE_KEYS.forEach((key, i) => {
    fitText(prim, up(t(`cockpit.mode.${key}`)), MODE_STRIP.x + 4, MODE_STRIP.y + MODE_STRIP.rowH * (i + 0.5) + 2, MODE_STRIP.w - 8, 40, 600, fonts.ui, 0.16);
  });
  ['cockpit.nominal', 'cockpit.alert'].forEach((key, i) => {
    fitText(prim, up(t(key)), STATUS_STRIP.x + 4, STATUS_STRIP.y + STATUS_STRIP.rowH * (i + 0.5) + 2, STATUS_STRIP.w - 8, 40, 700, fonts.ui, 0.22);
  });
}

/** A copy of a white-on-transparent layer recoloured to one channel (for additive packing). */
function tinted(src: HTMLCanvasElement, color: string, scale: number): HTMLCanvasElement {
  const ctx = makeCanvas(scale);
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  return ctx.canvas;
}

export interface DisplayAtlas {
  canvas: HTMLCanvasElement;
  /** Percent readout layout for the current locale. */
  percent: { before: boolean; gap: boolean };
}

/**
 * Draw the atlas (browser only) into `target` (reused when the locale changes) at `scale` of the design size and
 * return it with the percent layout of the current locale.
 */
export function drawDisplayAtlas(scale = 1, target?: HTMLCanvasElement): DisplayAtlas {
  const fonts: Fonts = {
    ui: cssVar('--ks-font', "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif"),
    mono: cssVar('--ks-mono', "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace"),
  };
  const pct = percentLayout(t('cockpit.percent', { value: '{value}' }));
  const L: Layers = { prim: makeLayer(scale), sec: makeLayer(scale) };
  drawThrottle(L, fonts);
  drawSpeed(L, fonts);
  drawAttitude(L, fonts);
  drawMode(L, fonts);
  drawStatus(L, fonts);
  drawStrips(L, fonts, pct.unit);

  let out: CanvasRenderingContext2D;
  if (target) {
    const ctx = target.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    out = ctx;
  } else {
    out = makeCanvas(scale);
  }
  const c = out.canvas;
  out.globalCompositeOperation = 'source-over';
  out.globalAlpha = 1;
  out.filter = 'none';
  out.fillStyle = '#000';
  out.fillRect(0, 0, c.width, c.height);
  out.globalCompositeOperation = 'lighter';
  const red = tinted(L.prim.canvas, '#f00', scale);
  const green = tinted(L.prim.canvas, '#0f0', scale);
  out.drawImage(red, 0, 0);
  out.drawImage(tinted(L.sec.canvas, '#00f', scale), 0, 0);
  // Glow: two blurred copies of the primary art, added.
  out.filter = `blur(${(7 * scale).toFixed(2)}px)`;
  out.drawImage(green, 0, 0);
  out.globalAlpha = 0.6;
  out.drawImage(green, 0, 0);
  out.filter = `blur(${(3 * scale).toFixed(2)}px)`;
  out.drawImage(green, 0, 0);
  out.filter = 'none';
  out.globalAlpha = 1;
  out.globalCompositeOperation = 'source-over';
  return { canvas: c, percent: { before: pct.before, gap: pct.gap } };
}
