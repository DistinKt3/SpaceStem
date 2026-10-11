/**
 * Colour science used to verify the UI palettes: WCAG 2 contrast, colour-vision-deficiency (CVD) simulation and
 * CIEDE2000 colour difference. Pure functions, no DOM.
 *
 * CVD simulation uses the Machado, Oliveira & Fernandes (2009) matrices at full severity, applied in linear sRGB:
 * "A Physiologically-based Model for Simulation of Color Vision Deficiency", IEEE TVCG 15(6), doi:10.1109/TVCG.2009.113.
 */

/** sRGB colour with 0..255 channels and 0..1 alpha. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface Lab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

export type Deficiency = 'protanopia' | 'deuteranopia' | 'tritanopia' | 'achromatopsia';

type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** Machado et al. 2009, severity 1.0 (row-major, linear RGB). */
const MACHADO: Readonly<Record<Exclude<Deficiency, 'achromatopsia'>, Mat3>> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(...) and rgba(...) (comma or space separated). */
export function parseColor(css: string): Rgba {
  const s = css.trim().toLowerCase();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    const full = h.length === 3 || h.length === 4 ? h.replace(/./g, '$&$&') : h;
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(full)) throw new Error(`Bad colour: ${css}`);
    const n = (i: number): number => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (!m) throw new Error(`Bad colour: ${css}`);
  const parts = m[1]!
    .split(/[\s,/]+/)
    .filter((p) => p.length > 0)
    .map((p) => (p.endsWith('%') ? (Number(p.slice(0, -1)) / 100) * 255 : Number(p)));
  if (parts.length < 3 || parts.some((p) => !Number.isFinite(p))) throw new Error(`Bad colour: ${css}`);
  const alphaRaw = m[1]!.split(/[\s,/]+/).filter((p) => p.length > 0)[3];
  const a = alphaRaw === undefined ? 1 : alphaRaw.endsWith('%') ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw);
  return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a };
}

export function srgbToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(l: number): number {
  const c = clamp01(l);
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
}

/** Alpha-composites fg over an opaque bg (sRGB-space blending, as browsers do). */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

/** WCAG 2 relative luminance. */
export function relativeLuminance(c: Rgba): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

/** WCAG 2 contrast ratio (1..21). Both colours must be opaque (composite first). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Simulates how a colour appears with a full (dichromat) deficiency, or total colour blindness. */
export function simulateCvd(c: Rgba, type: Deficiency): Rgba {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  if (type === 'achromatopsia') {
    const y = linearToSrgb(0.2126 * r + 0.7152 * g + 0.0722 * b);
    return { r: y, g: y, b: y, a: c.a };
  }
  const m = MACHADO[type];
  return {
    r: linearToSrgb(m[0] * r + m[1] * g + m[2] * b),
    g: linearToSrgb(m[3] * r + m[4] * g + m[5] * b),
    b: linearToSrgb(m[6] * r + m[7] * g + m[8] * b),
    a: c.a,
  };
}

/** sRGB to CIELAB (D65 white). */
export function toLab(c: Rgba): Lab {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIEDE2000 colour difference (Sharma, Wu & Dalal 2005 formulation). */
export function deltaE2000(x: Lab, y: Lab): number {
  const rad = Math.PI / 180;
  const c1 = Math.hypot(x.a, x.b);
  const c2 = Math.hypot(y.a, y.b);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1 = (1 + g) * x.a;
  const a2 = (1 + g) * y.a;
  const cp1 = Math.hypot(a1, x.b);
  const cp2 = Math.hypot(a2, y.b);
  const hp = (b: number, a: number): number => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1 = hp(x.b, a1);
  const h2 = hp(y.b, a2);
  const dL = y.l - x.l;
  const dC = cp2 - cp1;
  let dh = 0;
  if (cp1 * cp2 !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh * rad) / 2);
  const lBar = (x.l + y.l) / 2;
  const cpBar = (cp1 + cp2) / 2;
  let hBar = h1 + h2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(h1 - h2) <= 180) hBar = (h1 + h2) / 2;
    else hBar = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hBar - 30) * rad) +
    0.24 * Math.cos(2 * hBar * rad) +
    0.32 * Math.cos((3 * hBar + 6) * rad) -
    0.2 * Math.cos((4 * hBar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cpBar;
  const sh = 1 + 0.015 * cpBar * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh));
}

/** CIEDE2000 between two colours as seen with the given deficiency (or normal vision when type is null). */
export function perceivedDifference(a: Rgba, b: Rgba, type: Deficiency | null): number {
  const sa = type ? simulateCvd(a, type) : a;
  const sb = type ? simulateCvd(b, type) : b;
  return deltaE2000(toLab(sa), toLab(sb));
}
