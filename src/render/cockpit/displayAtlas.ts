/**
 * Static display art for the cockpit panels, drawn once with Canvas 2D into an RGBA atlas:
 *   R primary line art and labels, G a blurred copy of R (glow), B secondary (dim) art, A panel backplate fill.
 * Everything that moves (bars, arcs, markers, digits, the active mode) is drawn per pixel in the TSL panel shaders
 * using the layout constants below, so the atlas never needs re-uploading while flying.
 *
 * Layout numbers are in atlas pixels; every panel region keeps the physical aspect ratio of its display.
 */
import { t, formatNumber } from '../../game/i18n';
import type { PanelKind } from './geometry';

export const ATLAS_W = 2048;
export const ATLAS_H = 1024;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const REGIONS: Record<PanelKind, Rect> = {
  throttle: { x: 0, y: 0, w: 480, h: 320 },
  speed: { x: 480, y: 0, w: 480, h: 320 },
  attitude: { x: 960, y: 0, w: 448, h: 350 },
  mode: { x: 1408, y: 0, w: 384, h: 384 },
  status: { x: 0, y: 384, w: 384, h: 384 },
};

/** Glyph strip: digits 0-9 then '%'. */
export const DIGITS = { x: 400, y: 400, glyphW: 56, h: 84, count: 11 };
/** Mode names, one row each (thrusters, impulse, cruise, hyperspeed). */
export const MODE_STRIP = { x: 400, y: 500, w: 448, rowH: 60, rows: 4 };
/** Status words: nominal, alert. */
export const STATUS_STRIP = { x: 860, y: 500, w: 448, rowH: 60, rows: 2 };

/** Panel-local layouts in region pixels (origin top-left). Boxes are [x0, y0, x1, y1]. */
export const LAYOUT = {
  throttle: {
    bar: [44, 70, 96, 290] as const,
    segments: 20,
    digits: [184, 92, 444, 190] as const,
    modeLabelY: 236,
    modeBox: [184, 248, 444, 283] as const,
  },
  speed: {
    cx: 240,
    cy: 192,
    r: 108,
    width: 13,
    /** Sweep from -a to +a radians, measured clockwise from straight up. */
    a: (120 * Math.PI) / 180,
    digits: [168, 162, 312, 216] as const,
  },
  attitude: {
    cx: 224,
    cy: 196,
    /** Radius of the 90 degree ring (directions perpendicular to forward). */
    r90: 118,
    rMax: 146,
  },
  mode: {
    rowY0: 78,
    rowH: 70,
    x0: 18,
    x1: 366,
  },
  status: {
    word: [20, 66, 364, 112] as const,
    sunBar: [24, 176, 360, 190] as const,
    alertBar: [24, 246, 360, 260] as const,
    wave: [24, 290, 360, 356] as const,
  },
};

export const MODE_KEYS = ['thrusters', 'impulse', 'cruise', 'hyperspeed'] as const;

interface Layers {
  prim: CanvasRenderingContext2D;
  sec: CanvasRenderingContext2D;
  fill: CanvasRenderingContext2D;
}

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function makeLayer(): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = ATLAS_W;
  c.height = ATLAS_H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
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

/** Fit text into a width by shrinking the font; returns the size used. */
function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, size: number, weight: number, family: string, spacing = 0.12): void {
  let s = size;
  for (; s > 8; s -= 1) {
    ctx.font = `${weight} ${s}px ${family}`;
    ctx.letterSpacing = `${(s * spacing).toFixed(1)}px`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  ctx.fillText(text, x, y);
}

/** Frame common to every panel: backplate fill, thin outline, bright corner brackets, title. */
function panelFrame(L: Layers, r: Rect, title: string, fonts: { ui: string }): void {
  const { prim, sec, fill } = L;
  const x = r.x + 6;
  const y = r.y + 6;
  const w = r.w - 12;
  const h = r.h - 12;
  // Backplate: soft vertical gradient, brighter header band.
  const g = fill.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.32)');
  g.addColorStop(1, 'rgba(255,255,255,0.18)');
  fill.fillStyle = g;
  roundRect(fill, x, y, w, h, 14);
  fill.fill();
  fill.fillStyle = '#fff';
  // Outline.
  sec.lineWidth = 2;
  roundRect(sec, x, y, w, h, 14);
  sec.stroke();
  // Corner brackets.
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
  // Title and a short rule under it.
  sec.textBaseline = 'alphabetic';
  sec.textAlign = 'left';
  fitText(sec, up(title), r.x + 26, r.y + 44, r.w * 0.6, 24, 600, fonts.ui, 0.22);
  sec.lineWidth = 2;
  sec.beginPath();
  sec.moveTo(r.x + 26, r.y + 54);
  sec.lineTo(r.x + 70, r.y + 54);
  sec.stroke();
}

function drawThrottle(L: Layers, fonts: { ui: string; mono: string }): void {
  const r = REGIONS.throttle;
  const T = LAYOUT.throttle;
  panelFrame(L, r, t('cockpit.throttle'), fonts);
  const { prim, sec } = L;
  const [x0, y0, x1, y1] = T.bar;
  sec.lineWidth = 2;
  roundRect(sec, r.x + x0 - 6, r.y + y0 - 6, x1 - x0 + 12, y1 - y0 + 12, 6);
  sec.stroke();
  // Ticks and labels at 0, 25, 50, 75, 100 %.
  sec.font = `500 17px ${fonts.mono}`;
  sec.letterSpacing = '0px';
  sec.textAlign = 'left';
  sec.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const y = r.y + y1 - ((y1 - y0) * k) / 4;
    sec.beginPath();
    sec.moveTo(r.x + x1 + 12, y);
    sec.lineTo(r.x + x1 + (k % 2 === 0 ? 30 : 22), y);
    sec.stroke();
    sec.fillText(formatNumber(k * 25), r.x + x1 + 36, y);
  }
  // Readout underline and the mode caption.
  const [dx0, , dx1, dy1] = T.digits;
  prim.lineWidth = 2;
  prim.beginPath();
  prim.moveTo(r.x + dx0, r.y + dy1 + 12);
  prim.lineTo(r.x + dx1, r.y + dy1 + 12);
  prim.stroke();
  sec.textBaseline = 'alphabetic';
  fitText(sec, up(t('cockpit.mode')), r.x + T.modeBox[0], r.y + T.modeLabelY, 200, 17, 600, fonts.ui, 0.2);
}

function drawSpeed(L: Layers, fonts: { ui: string; mono: string }): void {
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
  sec.font = `500 17px ${fonts.mono}`;
  sec.letterSpacing = '0px';
  sec.textAlign = 'center';
  sec.textBaseline = 'middle';
  const rl = S.r + S.width / 2 + 40;
  sec.fillText(formatNumber(0), cx + Math.sin(-S.a) * rl, cy - Math.cos(-S.a) * rl);
  sec.fillText(formatNumber(100), cx + Math.sin(S.a) * rl, cy - Math.cos(S.a) * rl);
  sec.textBaseline = 'alphabetic';
  sec.textAlign = 'center';
  fitText(sec, up(t('cockpit.ofModeLimit')), cx, r.y + S.digits[3] + 24, 140, 14, 600, fonts.ui, 0.16);
  sec.textAlign = 'left';
}

function drawAttitude(L: Layers, fonts: { ui: string; mono: string }): void {
  const r = REGIONS.attitude;
  const A = LAYOUT.attitude;
  panelFrame(L, r, t('cockpit.attitude'), fonts);
  const { sec, prim } = L;
  const cx = r.x + A.cx;
  const cy = r.y + A.cy;
  // Rings at 30, 60 (dashed) and 90 degrees from forward.
  sec.lineWidth = 1.6;
  sec.setLineDash([5, 7]);
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
  sec.lineWidth = 1.4;
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
  // Legend: sun glyph + label (left), planet glyph + label (right).
  const ly = r.y + r.h - 22;
  prim.beginPath();
  prim.arc(r.x + 30, ly - 6, 6, 0, Math.PI * 2);
  prim.fill();
  sec.textBaseline = 'alphabetic';
  fitText(sec, up(t('cockpit.sun')), r.x + 44, ly, 150, 16, 600, fonts.ui, 0.18);
  prim.lineWidth = 2.2;
  prim.beginPath();
  prim.arc(r.x + r.w - 150, ly - 6, 7, 0, Math.PI * 2);
  prim.stroke();
  fitText(sec, up(t('cockpit.planet')), r.x + r.w - 136, ly, 120, 16, 600, fonts.ui, 0.18);
}

function drawMode(L: Layers, fonts: { ui: string; mono: string }): void {
  const r = REGIONS.mode;
  const M = LAYOUT.mode;
  panelFrame(L, r, t('cockpit.drive'), fonts);
  const { sec, prim } = L;
  MODE_KEYS.forEach((key, i) => {
    const y = r.y + M.rowY0 + i * M.rowH;
    sec.lineWidth = 1.5;
    roundRect(sec, r.x + M.x0, y + 6, M.x1 - M.x0, M.rowH - 12, 8);
    sec.stroke();
    sec.font = `600 18px ${fonts.mono}`;
    sec.letterSpacing = '0px';
    sec.textBaseline = 'middle';
    sec.textAlign = 'center';
    sec.fillText(formatNumber(i + 1), r.x + M.x0 + 24, y + M.rowH / 2);
    prim.textBaseline = 'middle';
    prim.textAlign = 'left';
    fitText(prim, up(t(`cockpit.mode.${key}`)), r.x + M.x0 + 50, y + M.rowH / 2 + 1, M.x1 - M.x0 - 100, 25, 600, fonts.ui, 0.14);
  });
}

function drawStatus(L: Layers, fonts: { ui: string; mono: string }): void {
  const r = REGIONS.status;
  const S = LAYOUT.status;
  panelFrame(L, r, t('cockpit.status'), fonts);
  const { sec } = L;
  sec.textBaseline = 'alphabetic';
  sec.textAlign = 'left';
  fitText(sec, up(t('cockpit.sunlight')), r.x + S.sunBar[0], r.y + S.sunBar[1] - 12, 250, 16, 600, fonts.ui, 0.18);
  fitText(sec, up(t('cockpit.alertLevel')), r.x + S.alertBar[0], r.y + S.alertBar[1] - 12, 250, 16, 600, fonts.ui, 0.18);
  sec.lineWidth = 1.5;
  for (const b of [S.sunBar, S.alertBar]) {
    roundRect(sec, r.x + b[0] - 4, r.y + b[1] - 4, b[2] - b[0] + 8, b[3] - b[1] + 8, 5);
    sec.stroke();
  }
  // Waveform window grid.
  const [wx0, wy0, wx1, wy1] = S.wave;
  sec.lineWidth = 1;
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

function drawStrips(L: Layers, fonts: { ui: string; mono: string }): void {
  const { prim } = L;
  // Digits and percent sign, centred in fixed cells (monospace look regardless of font).
  prim.textAlign = 'center';
  prim.textBaseline = 'middle';
  prim.letterSpacing = '0px';
  for (let i = 0; i < DIGITS.count; i++) {
    const ch = i < 10 ? formatNumber(i) : '%';
    prim.font = `${i < 10 ? 500 : 400} ${i < 10 ? 78 : 50}px ${fonts.mono}`;
    prim.fillText(ch, DIGITS.x + DIGITS.glyphW * (i + 0.5), DIGITS.y + DIGITS.h * (i < 10 ? 0.53 : 0.62));
  }
  prim.textAlign = 'left';
  MODE_KEYS.forEach((key, i) => {
    fitText(prim, up(t(`cockpit.mode.${key}`)), MODE_STRIP.x + 4, MODE_STRIP.y + MODE_STRIP.rowH * (i + 0.5) + 2, MODE_STRIP.w - 8, 40, 600, fonts.ui, 0.16);
  });
  ['cockpit.nominal', 'cockpit.alert'].forEach((key, i) => {
    fitText(prim, up(t(key)), STATUS_STRIP.x + 4, STATUS_STRIP.y + STATUS_STRIP.rowH * (i + 0.5) + 2, STATUS_STRIP.w - 8, 40, 700, fonts.ui, 0.22);
  });
}

/** Draw the atlas and return RGBA pixels (row 0 = top). Browser only. */
export function drawDisplayAtlas(): Uint8Array {
  const fonts = {
    ui: cssVar('--ks-font', "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif"),
    mono: cssVar('--ks-mono', "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace"),
  };
  const L: Layers = { prim: makeLayer(), sec: makeLayer(), fill: makeLayer() };
  drawThrottle(L, fonts);
  drawSpeed(L, fonts);
  drawAttitude(L, fonts);
  drawMode(L, fonts);
  drawStatus(L, fonts);
  drawStrips(L, fonts);
  // Glow: blurred copy of the primary layer.
  const glow = makeLayer();
  glow.filter = 'blur(7px)';
  glow.drawImage(L.prim.canvas, 0, 0);
  glow.filter = 'blur(3px)';
  glow.globalAlpha = 0.6;
  glow.drawImage(L.prim.canvas, 0, 0);
  const p = L.prim.getImageData(0, 0, ATLAS_W, ATLAS_H).data;
  const g = glow.getImageData(0, 0, ATLAS_W, ATLAS_H).data;
  const s = L.sec.getImageData(0, 0, ATLAS_W, ATLAS_H).data;
  const f = L.fill.getImageData(0, 0, ATLAS_W, ATLAS_H).data;
  const out = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  for (let i = 0; i < ATLAS_W * ATLAS_H; i++) {
    out[i * 4] = p[i * 4 + 3]!;
    out[i * 4 + 1] = Math.min(255, g[i * 4 + 3]! * 1.6);
    out[i * 4 + 2] = s[i * 4 + 3]!;
    out[i * 4 + 3] = f[i * 4 + 3]!;
  }
  return out;
}
