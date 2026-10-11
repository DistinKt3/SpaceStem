/**
 * Display colours through FrameRenderer's AgX tone mapping.
 *
 * FrameRenderer tone maps the whole HDR buffer, cockpit pass included, with three.js AgX. AgX deliberately
 * desaturates and compresses bright colours, so emitting the accent #7fd4ff as plain linear radiance shows up on
 * screen as a muted steel blue. The displays are UI, so their colours are specified as what the pilot should see:
 * `emissionFor()` inverts AgX numerically and returns the linear HDR emission that tone maps back to the requested
 * sRGB colour. This is a CPU port of three r186 `agxToneMapping` (src/nodes/display/ToneMappingFunctions.js),
 * unit tested against the forward transform.
 */

export type RGB = [number, number, number];

type Mat3 = readonly [RGB, RGB, RGB];

/** Matrices as three.js writes them: mat3(col0, col1, col2), applied as M * v. */
const SRGB_TO_REC2020: Mat3 = [
  [0.6274, 0.0691, 0.0164],
  [0.3293, 0.9195, 0.088],
  [0.0433, 0.0113, 0.8956],
];
const REC2020_TO_SRGB: Mat3 = [
  [1.6605, -0.1246, -0.0182],
  [-0.5876, 1.1329, -0.1006],
  [-0.0728, -0.0083, 1.1187],
];
const INSET: Mat3 = [
  [0.856627153315983, 0.137318972929847, 0.11189821299995],
  [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
  [0.0482516061458583, 0.101439036467562, 0.811302368396859],
];
const OUTSET: Mat3 = [
  [1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
  [-0.11060664309660323, 1.157823702216272, -0.11060664309660294],
  [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405],
];
const MIN_EV = -12.47393;
const MAX_EV = 4.026069;

function mul(m: Mat3, v: RGB): RGB {
  return [
    m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
    m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
    m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
  ];
}

function contrast(x: number): number {
  const x2 = x * x;
  const x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** AgX tone mapping (exposure 1): linear sRGB scene radiance to linear sRGB display values in [0, 1]. */
export function agx(c: RGB): RGB {
  let v = mul(INSET, mul(SRGB_TO_REC2020, c));
  v = v.map((x) => contrast(clamp01((Math.log2(Math.max(x, 1e-10)) - MIN_EV) / (MAX_EV - MIN_EV)))) as RGB;
  v = mul(OUTSET, v).map((x) => Math.pow(Math.max(0, x), 2.2)) as RGB;
  return mul(REC2020_TO_SRGB, v).map(clamp01) as RGB;
}

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** '#rrggbb' to sRGB components in [0, 1]. */
export function hexToSrgb(hex: string): RGB {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** sRGB colour after tone mapping an HDR emission (what the canvas shows, before bloom). */
export function displayedSrgb(hdr: RGB): RGB {
  return agx(hdr).map(linearToSrgb) as RGB;
}

/** Hue (0..1), saturation and value of an sRGB colour (HSV, as an image editor reports it). */
export function hsv(c: RGB): { h: number; s: number; v: number } {
  const [r, g, b] = c;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s: max > 0 ? d / max : 0, v: max };
}

/**
 * Linear HDR emission that AgX maps to the given sRGB colour scaled by `level` (0..1] (in display-linear light).
 * AgX cannot reach a fully saturated channel at 1.0, so the target is approached as closely as the curve allows:
 * a damped fixed-point iteration on each channel in log space, which converges because AgX is monotonic per channel
 * and only mildly cross-coupled.
 */
export function emissionFor(hex: string, level = 1): RGB {
  const target = hexToSrgb(hex).map((v) => Math.min(0.985, srgbToLinear(v) * level)) as RGB;
  let x: RGB = [...target];
  for (let it = 0; it < 200; it++) {
    const y = agx(x);
    x = x.map((xi, i) => {
      const ratio = Math.max(1e-4, target[i]!) / Math.max(1e-4, y[i]!);
      return Math.min(64, Math.max(1e-6, xi * Math.pow(ratio, 0.7)));
    }) as RGB;
  }
  return x;
}
