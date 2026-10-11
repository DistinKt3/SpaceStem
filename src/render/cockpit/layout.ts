/**
 * Cockpit layout and the analytic canopy model.
 *
 * Ship-local axes: -Z forward, +Y up, +X right; metres; the pilot's eye is at the origin. Azimuth is measured from
 * forward toward +X (right), elevation from the horizontal plane toward +Y (both in degrees, as seen from the eye).
 *
 * The canopy is one ellipsoid. The frame (two swept A-pillars that meet in an arch above the view, a spine over the
 * pilot's head, a rear bow and the side sills) is described analytically here, so the CPU geometry builders and the
 * GPU lighting (strut shadows, glass edge tint) agree exactly on where the frame is. Everything in this file is pure
 * math with no DOM or GPU access, so it is unit tested directly.
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
  /** Azimuth (deg) at the base elevation. */
  baseAz: 31.5,
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

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Fraction of a distant light (direction `l`, unit, toward the light) that reaches an interior point `p` through the
 * canopy: 0 where the hull, a sill, the rear bow or a strut is in the way, 1 through clear glass. `penumbraRad` is the
 * light's angular radius (the Sun: 0.0047 rad). This is the CPU twin of the shader in materials.ts.
 */
export function canopyTransmission(p: V3, l: V3, penumbraRad = 0.0047): number {
  const t = canopyExit(p, l);
  if (!Number.isFinite(t)) return 0;
  const q: V3 = [p[0] + l[0] * t, p[1] + l[1] * t, p[2] + l[2] * t];
  const [az, el] = azElOf(q);
  const r = Math.hypot(...q);
  // Penumbra width on the glass: distance to the glass times the light's angular size, plus a little blur.
  const pen = Math.max(0.004, t * penumbraRad * 2);
  const penDeg = pen / r / DEG;
  const sill = smoothstep(CANOPY.sillEl - penDeg, CANOPY.sillEl + penDeg, el);
  const bow = 1 - smoothstep(CANOPY.bowZ - FRAME.bowWidth - pen, CANOPY.bowZ - FRAME.bowWidth + pen, q[2]);
  let occl = 0;
  if (el < PILLAR.apexEl) {
    // Perpendicular angular distance to the pillar centre line (local slope from a finite difference).
    const slope = (pillarAz(el + 0.5) - pillarAz(el - 0.5)) * Math.cos(el * DEG);
    const dAz = (Math.abs(az) - pillarAz(el)) * Math.cos(el * DEG);
    const dist = (Math.abs(dAz) / Math.sqrt(1 + slope * slope)) * DEG * r;
    occl = Math.max(occl, 1 - smoothstep(PILLAR.width / 2 - pen, PILLAR.width / 2 + pen, dist));
  }
  const spineZone = smoothstep(PILLAR.apexEl - 8, PILLAR.apexEl - 4, el);
  occl = Math.max(occl, (1 - smoothstep(FRAME.spineWidth / 2 - pen, FRAME.spineWidth / 2 + pen, Math.abs(q[0]))) * spineZone);
  return sill * bow * (1 - occl);
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
