/**
 * Cockpit layout and the analytic canopy model.
 *
 * Ship-local axes: -Z forward, +Y up, +X right; metres; the pilot's eye is at the origin. Azimuth is measured from
 * forward toward +X (right), elevation from the horizontal plane toward +Y (both in degrees, as seen from the eye).
 *
 * The canopy is one ellipsoid. The frame (two swept A-pillars that meet in an arch above the view, a spine over the
 * pilot's head, a rear bow and the side sills) is described analytically here, so the CPU geometry builders and the
 * GPU lighting (strut shadows, glass edge tint) agree on where the frame is.
 *
 * The light model (canopy transmission, distance to the frame) is written once, generically over `ScalarOps<T>`:
 * the CPU evaluates it with plain numbers (`numberOps`, unit tested) and materials.ts evaluates the very same code
 * with TSL nodes, so the shader and its CPU twin cannot drift apart. Everything in this file is pure math with no
 * DOM or GPU access.
 */

export const DEG = Math.PI / 180;

export type V3 = [number, number, number];

/** Canopy ellipsoid: centre and semi-axes (metres). */
export const CANOPY = {
  center: [0, -0.25, -0.3] as V3,
  semi: [0.66, 0.82, 0.95] as V3,
  /** Elevation (deg, from the eye) of the glass bottom edge on the sides; the side sills sit here. */
  sillEl: -19.5,
  /** Rear canopy bow plane: glass for z < bowZ, hull behind. */
  bowZ: 0.12,
};

/** Swept A-pillars: azimuth as a function of elevation, converging in a rounded arch above the forward view. */
export const PILLAR = {
  /** Azimuth (deg) at the base elevation. Wide enough that the holographic panes sit fully inboard of the pillars. */
  baseAz: 35.5,
  /** Elevation (deg) where the azimuth is baseAz (hidden below the dashboard lip). */
  baseEl: -30,
  /** Elevation (deg) where the two pillars meet (above the top of a 60 degree view). */
  apexEl: 52,
  /** Shape exponent of the arch: larger keeps the pillars upright for longer before they curve inward. */
  power: 2.6,
  /** Strut face width seen from the eye, and radial depth (metres). */
  width: 0.026,
  depth: 0.05,
};

/** Other frame members (metres). */
export const FRAME = {
  spineWidth: 0.022,
  bowWidth: 0.05,
  sillWidth: 0.03,
};

/** Dashboard: the top edge (lip) sits LIP_DEPRESSION_DEG below the forward horizon at LIP_DISTANCE ahead. */
export const LIP_DEPRESSION_DEG = 18;
export const LIP_DISTANCE = 0.66;
export const LIP_Y = -LIP_DISTANCE * Math.tan(LIP_DEPRESSION_DEG * DEG);

/**
 * Holographic panes: flat quads facing the eye, centred on (az, el) at `dist` metres, `w` x `h` metres, with the top
 * tilted away from the pilot by `tilt` degrees. The two side panes sit between the clear forward cone (20 degrees
 * off axis) and the A-pillars; the attitude pane floats in front of the dashboard glass, below the lip line.
 */
export interface HoloPaneSpec {
  az: number;
  el: number;
  dist: number;
  w: number;
  h: number;
  tilt: number;
}

export const HOLO_PANES: { throttle: HoloPaneSpec; speed: HoloPaneSpec; attitude: HoloPaneSpec } = {
  throttle: { az: -24.7, el: -12.6, dist: 0.6, w: 0.13, h: 0.13 / 1.5, tilt: 14 },
  speed: { az: 24.7, el: -12.6, dist: 0.6, w: 0.13, h: 0.13 / 1.5, tilt: 14 },
  attitude: { az: 0, el: -24.9, dist: 0.6, w: 0.128, h: 0.1, tilt: 22 },
};

/** Unit direction for an azimuth/elevation pair (degrees). Elevation may exceed 90 (past the zenith). */
export function dirAzEl(azDeg: number, elDeg: number): V3 {
  const a = azDeg * DEG;
  const e = elDeg * DEG;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)];
}

/** Azimuth and elevation (degrees) of a direction or point seen from the eye. */
export function azElOf(p: V3): [number, number] {
  const [x, y, z] = p;
  return [Math.atan2(x, -z) / DEG, Math.atan2(y, Math.hypot(x, z)) / DEG];
}

/**
 * Ray / canopy ellipsoid intersection for a ray starting inside the canopy. Returns the distance along the
 * (not necessarily unit) direction to the exit point, or NaN when the start point is outside.
 */
export function canopyExit(o: V3, d: V3): number {
  const [cx, cy, cz] = CANOPY.center;
  const [sx, sy, sz] = CANOPY.semi;
  const px = (o[0] - cx) / sx;
  const py = (o[1] - cy) / sy;
  const pz = (o[2] - cz) / sz;
  const lx = d[0] / sx;
  const ly = d[1] / sy;
  const lz = d[2] / sz;
  const a = lx * lx + ly * ly + lz * lz;
  const b = 2 * (px * lx + py * ly + pz * lz);
  const c = px * px + py * py + pz * pz - 1;
  const disc = b * b - 4 * a * c;
  if (c > 0 || disc < 0) return NaN;
  return (-b + Math.sqrt(disc)) / (2 * a);
}

/** Point on the canopy surface seen from the eye along an azimuth/elevation. */
export function canopyPoint(azDeg: number, elDeg: number, inset = 0): V3 {
  const d = dirAzEl(azDeg, elDeg);
  const t = canopyExit([0, 0, 0], d) - inset;
  return [d[0] * t, d[1] * t, d[2] * t];
}

/** Outward unit normal of the canopy ellipsoid at a surface point. */
export function canopyNormal(p: V3): V3 {
  const [cx, cy, cz] = CANOPY.center;
  const [sx, sy, sz] = CANOPY.semi;
  const n: V3 = [(p[0] - cx) / (sx * sx), (p[1] - cy) / (sy * sy), (p[2] - cz) / (sz * sz)];
  const l = Math.hypot(...n);
  return [n[0] / l, n[1] / l, n[2] / l];
}

/** Arch parameter of the pillars at an elevation: 0 at the base, 1 at the apex. */
function archT(elDeg: number): number {
  return Math.min(1, Math.max(0, (elDeg - PILLAR.baseEl) / (PILLAR.apexEl - PILLAR.baseEl)));
}

/** |azimuth| (deg) of the A-pillar centre line at an elevation (right pillar; the left one mirrors it). */
export function pillarAz(elDeg: number): number {
  const t = archT(elDeg);
  return PILLAR.baseAz * Math.sqrt(Math.max(0, 1 - Math.pow(t, PILLAR.power)));
}

/** Smallest angle (deg) between a direction and the forward axis that any frame member reaches (for tests). */
export function frameClearanceDeg(samples = 400): number {
  let best = 180;
  for (let i = 0; i <= samples; i++) {
    const el = PILLAR.baseEl + ((PILLAR.apexEl - PILLAR.baseEl) * i) / samples;
    const az = pillarAz(el);
    // Inner edge of the strut, as seen from the eye.
    const p = canopyPoint(az, el);
    const halfW = PILLAR.width / 2 / Math.hypot(...p) / DEG;
    const d = dirAzEl(Math.max(0, az - halfW / Math.max(Math.cos(el * DEG), 0.2)), el);
    best = Math.min(best, Math.acos(-d[2]) / DEG);
  }
  return best;
}

/** Hermite smoothstep; e0 < e1. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------------------------------------------
// The light model, generic over scalar operations (numbers on the CPU, TSL nodes on the GPU).

/** The scalar operations the canopy model needs. `smoothstep` callers always pass e0 < e1 (GLSL leaves e0 >= e1 undefined). */
export interface ScalarOps<T> {
  k(v: number): T;
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  mul(a: T, b: T): T;
  div(a: T, b: T): T;
  abs(a: T): T;
  min(a: T, b: T): T;
  max(a: T, b: T): T;
  sqrt(a: T): T;
  pow(a: T, e: T): T;
  cos(a: T): T;
  atan2(y: T, x: T): T;
  smoothstep(e0: T, e1: T, x: T): T;
  /** 1 when x >= edge, else 0. */
  step(edge: T, x: T): T;
}

export const numberOps: ScalarOps<number> = {
  k: (v) => v,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  sqrt: Math.sqrt,
  pow: Math.pow,
  cos: Math.cos,
  atan2: Math.atan2,
  smoothstep,
  step: (edge, x) => (x >= edge ? 1 : 0),
};

type Vec<T> = [T, T, T];

/** Distance along unit d from an interior point p to the canopy ellipsoid; `inside` is 0 when p is outside. */
export function canopyExitG<T>(o: ScalarOps<T>, p: Vec<T>, d: Vec<T>): { t: T; inside: T } {
  const pc = [0, 1, 2].map((i) => o.div(o.sub(p[i]!, o.k(CANOPY.center[i]!)), o.k(CANOPY.semi[i]!)));
  const l = [0, 1, 2].map((i) => o.div(d[i]!, o.k(CANOPY.semi[i]!)));
  const dot = (u: T[], v: T[]): T => o.add(o.add(o.mul(u[0]!, v[0]!), o.mul(u[1]!, v[1]!)), o.mul(u[2]!, v[2]!));
  const a = dot(l, l);
  const b = o.mul(dot(pc, l), o.k(2));
  const c = o.sub(dot(pc, pc), o.k(1));
  const disc = o.max(o.sub(o.mul(b, b), o.mul(o.mul(a, c), o.k(4))), o.k(0));
  const t = o.div(o.add(o.sub(o.k(0), b), o.sqrt(disc)), o.mul(a, o.k(2)));
  return { t, inside: o.step(c, o.k(0)) };
}

/** Azimuth and elevation (degrees) of a point seen from the eye. */
export function azElG<T>(o: ScalarOps<T>, q: Vec<T>): { az: T; el: T } {
  const horiz = o.sqrt(o.add(o.mul(q[0], q[0]), o.mul(q[2], q[2])));
  return {
    az: o.div(o.atan2(q[0], o.sub(o.k(0), q[2])), o.k(DEG)),
    el: o.div(o.atan2(q[1], horiz), o.k(DEG)),
  };
}

/**
 * Angular distance (degrees, as seen from the eye) from a direction (|azimuth|, elevation) to the A-pillar centre
 * line. The pillar is the zero set of f = (az / baseAz)^2 + t^p - 1 (t the arch parameter), so |f| / |grad f| is a
 * first-order distance that stays accurate right up to the apex, where the curve runs horizontally, and grows (rather
 * than collapsing to zero) far from the curve. Above the apex the pillars end: the elevation excess is added in
 * quadrature. Azimuth is measured along the small circle, so it is scaled by cos(el).
 */
export function pillarDistanceDegG<T>(o: ScalarOps<T>, absAz: T, el: T): T {
  const span = PILLAR.apexEl - PILLAR.baseEl;
  const t = o.min(o.max(o.div(o.sub(el, o.k(PILLAR.baseEl)), o.k(span)), o.k(1e-4)), o.k(1));
  const tp = o.pow(t, o.k(PILLAR.power));
  const ratio = o.div(absAz, o.k(PILLAR.baseAz));
  const f = o.sub(o.add(o.mul(ratio, ratio), tp), o.k(1));
  const cosEl = o.max(o.cos(o.mul(el, o.k(DEG))), o.k(0.05));
  const gAz = o.div(o.mul(absAz, o.k(2 / (PILLAR.baseAz * PILLAR.baseAz))), cosEl);
  const gEl = o.mul(o.pow(t, o.k(PILLAR.power - 1)), o.k(PILLAR.power / span));
  const grad = o.sqrt(o.add(o.add(o.mul(gAz, gAz), o.mul(gEl, gEl)), o.k(1e-12)));
  const dCurve = o.div(o.abs(f), grad);
  const above = o.max(o.sub(el, o.k(PILLAR.apexEl)), o.k(0));
  return o.sqrt(o.add(o.mul(dCurve, dCurve), o.mul(above, above)));
}

/** Where the spine runs over the pilot's head (from the arch apex back): 0 below the apex, 1 above. */
function spineZoneG<T>(o: ScalarOps<T>, el: T): T {
  return o.smoothstep(o.k(PILLAR.apexEl - 1), o.k(PILLAR.apexEl + 1), el);
}

/** Distance (metres) from a canopy point q to the nearest frame member centre line (glass edge tint). */
export function frameDistanceG<T>(o: ScalarOps<T>, q: Vec<T>): T {
  const { az, el } = azElG(o, q);
  const r = o.sqrt(o.add(o.add(o.mul(q[0], q[0]), o.mul(q[1], q[1])), o.mul(q[2], q[2])));
  const toMetres = o.mul(r, o.k(DEG));
  const dPillar = o.mul(pillarDistanceDegG(o, o.abs(az), el), toMetres);
  const zone = spineZoneG(o, el);
  const dSpine = o.add(o.mul(o.abs(q[0]), zone), o.mul(o.sub(o.k(1), zone), o.k(9)));
  const dSill = o.mul(o.abs(o.sub(el, o.k(CANOPY.sillEl))), toMetres);
  const dBow = o.abs(o.sub(q[2], o.k(CANOPY.bowZ - FRAME.bowWidth / 2)));
  return o.min(o.min(dPillar, dSpine), o.min(dSill, dBow));
}

/**
 * Fraction of a distant light (unit direction l, toward the light) reaching interior point p through the canopy: 0
 * where the hull, a sill, the rear bow, a pillar or the spine is in the way, 1 through clear glass, with a penumbra
 * from the light's angular radius `penRad` (the Sun: 0.0047 rad). `struts` false ignores pillars and spine (for the
 * frame itself, which cannot shadow itself).
 */
export function canopyTransmissionG<T>(o: ScalarOps<T>, p: Vec<T>, l: Vec<T>, penRad: number, struts = true): T {
  const { t, inside } = canopyExitG(o, p, l);
  const tc = o.max(t, o.k(0));
  const q: Vec<T> = [o.add(p[0], o.mul(l[0], tc)), o.add(p[1], o.mul(l[1], tc)), o.add(p[2], o.mul(l[2], tc))];
  const { az, el } = azElG(o, q);
  const r = o.sqrt(o.add(o.add(o.mul(q[0], q[0]), o.mul(q[1], q[1])), o.mul(q[2], q[2])));
  // Penumbra width on the glass: distance to the glass times the light's angular size, plus a little blur.
  const pen = o.max(o.mul(tc, o.k(penRad * 2)), o.k(0.004));
  const penDeg = o.div(o.div(pen, r), o.k(DEG));
  const sill = o.smoothstep(o.sub(o.k(CANOPY.sillEl), penDeg), o.add(o.k(CANOPY.sillEl), penDeg), el);
  const bowEdge = o.k(CANOPY.bowZ - FRAME.bowWidth);
  const bow = o.sub(o.k(1), o.smoothstep(o.sub(bowEdge, pen), o.add(bowEdge, pen), q[2]));
  let pass = o.mul(o.mul(sill, bow), inside);
  if (struts) {
    const hw = o.k(PILLAR.width / 2);
    const dPillar = o.mul(pillarDistanceDegG(o, o.abs(az), el), o.mul(r, o.k(DEG)));
    const pillar = o.sub(o.k(1), o.smoothstep(o.sub(hw, pen), o.add(hw, pen), dPillar));
    const sw = o.k(FRAME.spineWidth / 2);
    const spine = o.mul(o.sub(o.k(1), o.smoothstep(o.sub(sw, pen), o.add(sw, pen), o.abs(q[0]))), spineZoneG(o, el));
    pass = o.mul(pass, o.sub(o.k(1), o.max(pillar, spine)));
  }
  return pass;
}

/** CPU canopy transmission (see canopyTransmissionG). */
export function canopyTransmission(p: V3, l: V3, penumbraRad = 0.0047, struts = true): number {
  return canopyTransmissionG(numberOps, p, l, penumbraRad, struts);
}

/** CPU distance (metres) from a canopy point to the nearest frame member centre line (see frameDistanceG). */
export function frameDistance(q: V3): number {
  return frameDistanceG(numberOps, q);
}

/** CPU angular distance (degrees) from a direction to the A-pillar centre line (see pillarDistanceDegG). */
export function pillarDistanceDeg(azDeg: number, elDeg: number): number {
  return pillarDistanceDegG(numberOps, Math.abs(azDeg), elDeg);
}

/** Plan-view (x, z) of the dashboard / console lip, parameter s in [-1, 1] from left rear to right rear. */
export const LIP_PATH: [number, number, number][] = [
  // [x, z, y] for the right half; mirrored for the left. Centre first.
  [0, -LIP_DISTANCE, LIP_Y],
  [0.16, -0.648, LIP_Y - 0.002],
  [0.3, -0.612, LIP_Y - 0.008],
  [0.4, -0.56, LIP_Y - 0.022],
  [0.47, -0.48, LIP_Y - 0.045],
  [0.51, -0.36, LIP_Y - 0.07],
  [0.53, -0.2, LIP_Y - 0.085],
  [0.54, 0.0, LIP_Y - 0.09],
  [0.54, 0.25, LIP_Y - 0.09],
];
