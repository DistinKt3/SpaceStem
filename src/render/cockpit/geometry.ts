/**
 * Procedural cockpit geometry: canopy shell, frame struts, the wraparound dashboard and side consoles, display panels,
 * control stick, throttle, buttons and accent light strips. Pure three.js geometry (no DOM, no GPU), so triangle
 * budgets and placement are unit tested in Node.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CANOPY, DEG, FRAME, LIP_PATH, PILLAR, azElOf, canopyExit, canopyNormal, canopyPoint, dirAzEl, pillarAz, type V3 } from './layout';

const v3 = (p: V3): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2]);

/** Grid mesh from rows of points (rows[i][j]); uv = (i, j) normalised unless given. Smooth normals. */
export function gridGeometry(rows: THREE.Vector3[][], uvs?: [number, number][][]): THREE.BufferGeometry {
  const nI = rows.length;
  const nJ = rows[0]!.length;
  const pos = new Float32Array(nI * nJ * 3);
  const uv = new Float32Array(nI * nJ * 2);
  for (let i = 0; i < nI; i++) {
    const row = rows[i]!;
    for (let j = 0; j < nJ; j++) {
      const p = row[j]!;
      const k = i * nJ + j;
      pos[k * 3] = p.x;
      pos[k * 3 + 1] = p.y;
      pos[k * 3 + 2] = p.z;
      const t = uvs?.[i]?.[j];
      uv[k * 2] = t ? t[0] : i / (nI - 1);
      uv[k * 2 + 1] = t ? t[1] : j / (nJ - 1);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < nI - 1; i++) {
    for (let j = 0; j < nJ - 1; j++) {
      const a = i * nJ + j;
      const b = (i + 1) * nJ + j;
      const c = (i + 1) * nJ + j + 1;
      const d = i * nJ + j + 1;
      idx.push(a, b, d, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Resample a polyline to n points evenly spaced by arc length (centripetal Catmull-Rom smoothing). */
export function resample(points: THREE.Vector3[], n: number): THREE.Vector3[] {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  return curve.getSpacedPoints(n - 1);
}

/** Sweep a closed profile (b = sideways, r = along the canopy normal, outward positive) along a path on the canopy. */
export function sweepOnCanopy(path: THREE.Vector3[], profile: [number, number][]): THREE.BufferGeometry {
  const rows: THREE.Vector3[][] = [];
  const closed = [...profile, profile[0]!];
  const T = new THREE.Vector3();
  const B = new THREE.Vector3();
  const R = new THREE.Vector3();
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    const prev = path[Math.max(0, i - 1)]!;
    const next = path[Math.min(path.length - 1, i + 1)]!;
    T.subVectors(next, prev).normalize();
    R.copy(v3(canopyNormal([p.x, p.y, p.z])));
    B.crossVectors(T, R).normalize();
    R.crossVectors(B, T).normalize();
    rows.push(closed.map(([b, r]) => p.clone().addScaledVector(B, b).addScaledVector(R, r)));
  }
  return gridGeometry(rows);
}

/** Rounded-rectangle cross-section: width w (sideways), depth d (inward from just outside the glass). */
export function strutProfile(w: number, d: number, n = 14, outside = 0.004): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const b = (w / 2) * Math.sign(c) * Math.pow(Math.abs(c), 0.55);
    const r = outside - d / 2 + (d / 2) * Math.sign(s) * Math.pow(Math.abs(s), 0.55);
    out.push([b, r]);
  }
  return out;
}

/** Points of the A-pillar arch: left base -> apex -> right base, on the canopy surface. */
export function pillarArchPoints(n = 120): THREE.Vector3[] {
  const raw: THREE.Vector3[] = [];
  const el0 = PILLAR.baseEl - 6;
  const steps = 90;
  for (let k = 0; k <= steps; k++) {
    // Denser sampling near the apex where the arch turns.
    const t = 1 - Math.pow(1 - k / steps, 1.6);
    const el = el0 + (PILLAR.apexEl - el0) * t;
    raw.push(v3(canopyPoint(-pillarAz(el), el)));
  }
  for (let k = steps - 1; k >= 0; k--) {
    const t = 1 - Math.pow(1 - k / steps, 1.6);
    const el = el0 + (PILLAR.apexEl - el0) * t;
    raw.push(v3(canopyPoint(pillarAz(el), el)));
  }
  // Remove the duplicate apex point.
  return resample(raw.filter((p, i) => i === 0 || p.distanceTo(raw[i - 1]!) > 1e-5), n);
}

/** Spine over the pilot's head: from the arch apex back to the rear bow. */
export function spinePoints(n = 40): THREE.Vector3[] {
  const raw: THREE.Vector3[] = [];
  for (let el = PILLAR.apexEl - 3; el <= 170; el += 2) {
    const p = canopyPoint(0, el);
    raw.push(v3(p));
    if (p[2] > CANOPY.bowZ) break;
  }
  return resample(raw, n);
}

/** Rear canopy bow: the ellipse where the plane z = bowZ - bowWidth/2 cuts the canopy, from sill to sill. */
export function bowPoints(n = 64): THREE.Vector3[] {
  const [cx, cy, cz] = CANOPY.center;
  const [sx, sy, sz] = CANOPY.semi;
  const zb = CANOPY.bowZ - FRAME.bowWidth / 2;
  const k = Math.sqrt(Math.max(0, 1 - ((zb - cz) / sz) ** 2));
  const at = (phi: number): THREE.Vector3 => new THREE.Vector3(cx + sx * k * Math.cos(phi), cy + sy * k * Math.sin(phi), zb);
  // Find the angle where the bow meets the sill on the right (elevation = sillEl - 3).
  let lo = -Math.PI / 2;
  let hi = Math.PI / 2;
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2;
    const p = at(mid);
    const [, el] = azElOf([p.x, p.y, p.z]);
    if (el < CANOPY.sillEl - 3) lo = mid;
    else hi = mid;
  }
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const phi = lo + (Math.PI - 2 * lo) * (i / (n - 1));
    pts.push(at(phi));
  }
  return pts;
}

/** Side sill along the bottom edge of the side glass, from the pillar base back to the rear bow (right side). */
export function sillPoints(sign: 1 | -1, n = 40): THREE.Vector3[] {
  const raw: THREE.Vector3[] = [];
  const el = CANOPY.sillEl - 0.6;
  for (let az = pillarAz(el) - 2; az < 175; az += 2) {
    const p = canopyPoint(sign * az, el);
    raw.push(v3(p));
    if (p[2] > CANOPY.bowZ) break;
  }
  return resample(raw, n);
}

/** All canopy frame members, merged (one draw call). */
export function buildFrame(quality: 'low' | 'high'): THREE.BufferGeometry {
  const hi = quality === 'high';
  const parts = [
    sweepOnCanopy(pillarArchPoints(hi ? 140 : 80), strutProfile(PILLAR.width, PILLAR.depth, hi ? 14 : 10)),
    sweepOnCanopy(spinePoints(hi ? 40 : 24), strutProfile(FRAME.spineWidth, 0.04, hi ? 12 : 8)),
    sweepOnCanopy(bowPoints(hi ? 64 : 40), strutProfile(FRAME.bowWidth, 0.07, hi ? 12 : 8)),
    sweepOnCanopy(sillPoints(1, hi ? 40 : 24), strutProfile(FRAME.sillWidth, 0.05, hi ? 12 : 8)),
    sweepOnCanopy(sillPoints(-1, hi ? 40 : 24), strutProfile(FRAME.sillWidth, 0.05, hi ? 12 : 8)),
  ];
  return mergeOrThrow(parts);
}

/** Thin light ribbons on the inner faces of the A-pillars, bright at the base and fading upward. */
export function pillarLightStrips(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const inner = 0.004 - PILLAR.depth - 0.0009;
  const profile: [number, number][] = [
    [-0.0016, inner + 0.0004],
    [0.0016, inner + 0.0004],
    [0.0016, inner - 0.0004],
    [-0.0016, inner - 0.0004],
  ];
  for (const sign of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    const fades: number[] = [];
    for (let el = -21; el <= 9; el += 1) {
      pts.push(v3(canopyPoint(sign * pillarAz(el), el)));
      const t = (el + 21) / 30;
      fades.push(Math.pow(1 - t, 1.6) * 1.2 + 0.05);
    }
    const g = sweepOnCanopy(pts, profile);
    const n = (g.getAttribute('position') as THREE.BufferAttribute).count;
    const per = n / pts.length;
    const tint = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const f = fades[Math.floor(i / per)] ?? 0;
      tint.set([f, f, f, 1], i * 4);
    }
    g.setAttribute('tint', new THREE.BufferAttribute(tint, 4));
    out.push(g);
  }
  return out;
}

/** Ellipsoid mesh of the canopy (scaled about its centre); normals outward. */
export function canopyEllipsoid(scale: number, quality: 'low' | 'high'): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, quality === 'high' ? 80 : 48, quality === 'high' ? 50 : 30);
  g.scale(CANOPY.semi[0] * scale, CANOPY.semi[1] * scale, CANOPY.semi[2] * scale);
  g.translate(...CANOPY.center);
  return g;
}

// ---------------------------------------------------------------------------------------------------------------
// Dashboard and side consoles: one wraparound loft along the lip path.

/** Profile control points (n = toward the pilot, up) for the centre dashboard and for the side consoles. */
const DASH_PROFILE: [number, number][] = [
  [0.34, -0.62],
  [0.25, -0.36],
  [0.165, -0.205],
  [0.105, -0.12],
  [0.05, -0.048],
  [0.02, -0.014],
  [0.0, 0.0],
  [-0.028, -0.012],
  [-0.12, -0.06],
  [-0.3, -0.15],
];
const CONSOLE_PROFILE: [number, number][] = [
  [0.08, -0.62],
  [0.07, -0.36],
  [0.058, -0.205],
  [0.045, -0.12],
  [0.03, -0.048],
  [0.012, -0.014],
  [0.0, 0.0],
  [-0.03, 0.002],
  [-0.09, 0.008],
  [-0.15, 0.03],
];
/** Profile index of the lip (top edge) and of the face region used for screens. */
export const PROFILE_LIP = 6;

export class DashSurface {
  readonly path: THREE.CatmullRomCurve3;
  readonly nU: number;
  readonly nV: number;
  private readonly curves = new Map<number, THREE.CatmullRomCurve3>();

  constructor(nU = 96, nV = 40) {
    this.nU = nU;
    this.nV = nV;
    const pts: THREE.Vector3[] = [];
    const right = LIP_PATH.map(([x, z, y]) => new THREE.Vector3(x, y, z));
    for (let i = right.length - 1; i > 0; i--) pts.push(right[i]!.clone().setX(-right[i]!.x));
    pts.push(...right);
    this.path = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  }

  /** Side blend: 0 on the centre dashboard, 1 on the side consoles. */
  blend(u: number): number {
    const x = Math.abs(this.path.getPointAt(u).x);
    const t = Math.min(1, Math.max(0, (x - 0.3) / 0.2));
    return t * t * (3 - 2 * t);
  }

  /** Lip point, inward horizontal normal (toward the pilot) at path parameter u in [0, 1]. */
  frame(u: number): { lip: THREE.Vector3; inward: THREE.Vector3 } {
    const lip = this.path.getPointAt(u);
    const tan = this.path.getTangentAt(u);
    const inward = new THREE.Vector3(tan.x, 0, tan.z).normalize().cross(new THREE.Vector3(0, 1, 0)).normalize();
    return { lip, inward };
  }

  /** Profile control points at u (blend of dashboard and console), as 3D points; last point reaches the glass. */
  private controls(u: number): THREE.Vector3[] {
    const { lip, inward } = this.frame(u);
    const b = this.blend(u);
    const pts = DASH_PROFILE.map(([n0, h0], j) => {
      const [n1, h1] = CONSOLE_PROFILE[j]!;
      const n = n0 + (n1 - n0) * b;
      const h = h0 + (h1 - h0) * b;
      return lip.clone().addScaledVector(inward, n).add(new THREE.Vector3(0, h, 0));
    });
    // Close to the canopy: centre runs the deck down-forward under the glass, sides rise to the sill.
    const last = pts[pts.length - 1]!;
    const [az] = azElOf([last.x, last.y, last.z]);
    const elEnd = -24 + (CANOPY.sillEl - 0.8 + 24) * b;
    const target = v3(canopyPoint(az, elEnd, -0.012));
    const mid = last.clone().lerp(target, 0.55);
    // Lift the console wall a little so it rises steeply to the sill.
    mid.y = Math.max(mid.y, last.y + (target.y - last.y) * 0.75 * b);
    pts.push(mid, target);
    return pts;
  }

  point(u: number, v: number): THREE.Vector3 {
    const key = Math.round(u * 1e6);
    let curve = this.curves.get(key);
    if (!curve) {
      if (this.curves.size > 20000) this.curves.clear();
      curve = new THREE.CatmullRomCurve3(this.controls(u), false, 'centripetal');
      this.curves.set(key, curve);
    }
    return curve.getPoint(Math.min(1, Math.max(0, v)));
  }

  /** Profile parameter v of a control point index (the curve is parameterised uniformly over control points). */
  vOf(controlIndex: number): number {
    return controlIndex / (DASH_PROFILE.length + 1);
  }

  /** Unit surface normal facing the pilot side. */
  normal(u: number, v: number): THREE.Vector3 {
    const e = 1e-3;
    const du = this.point(Math.min(1, u + e), v).sub(this.point(Math.max(0, u - e), v));
    const dv = this.point(u, Math.min(1, v + e)).sub(this.point(u, Math.max(0, v - e)));
    const n = new THREE.Vector3().crossVectors(du, dv).normalize();
    // Face the eye (origin) side.
    const p = this.point(u, v);
    if (n.dot(p) > 0) n.negate();
    return n;
  }

  /** Path parameter u whose lip point has the given x on the front (|x| below the console turn). */
  uAtX(x: number): number {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (this.path.getPointAt(mid).x < x) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  geometry(): THREE.BufferGeometry {
    const rows: THREE.Vector3[][] = [];
    for (let i = 0; i < this.nU; i++) {
      const u = i / (this.nU - 1);
      const row: THREE.Vector3[] = [];
      for (let j = 0; j < this.nV; j++) row.push(this.point(u, j / (this.nV - 1)));
      rows.push(row);
    }
    return gridGeometry(rows);
  }

  /** u range around uc spanning +-halfWidth metres of arc length along profile row v. */
  arcSpan(uc: number, halfWidth: number, v: number): [number, number] {
    const walk = (dir: 1 | -1): number => {
      const step = 0.0015 * dir;
      let u = uc;
      let acc = 0;
      let prev = this.point(uc, v);
      for (let k = 0; k < 2000; k++) {
        const nu = Math.min(1, Math.max(0, u + step));
        const p = this.point(nu, v);
        const d = p.distanceTo(prev);
        if (acc + d >= halfWidth) return u + ((nu - u) * (halfWidth - acc)) / Math.max(d, 1e-9);
        acc += d;
        prev = p;
        u = nu;
        if (u <= 0 || u >= 1) break;
      }
      return u;
    };
    return [walk(-1), walk(1)];
  }

  /**
   * A patch centred on path parameter uc, `halfWidth` metres of arc to each side on every profile row (so displays are
   * true rectangles on the curved face), from v0 to v1, lifted along the normal. uv: canvas convention (0,0 top-left).
   */
  arcPatch(uc: number, halfWidth: number, v0: number, v1: number, lift: number, nu = 16, nv = 8): THREE.BufferGeometry {
    const cols: THREE.Vector3[][] = Array.from({ length: nu }, () => []);
    const uvs: [number, number][][] = Array.from({ length: nu }, () => []);
    const vs = this.evenProfile(uc, v0, v1, nv);
    for (let j = 0; j < nv; j++) {
      const v = vs[j]!;
      const [ua, ub] = this.arcSpan(uc, halfWidth, v);
      for (let i = 0; i < nu; i++) {
        const u = ua + ((ub - ua) * i) / (nu - 1);
        cols[i]!.push(this.point(u, v).addScaledVector(this.normal(u, v), lift));
        uvs[i]!.push([i / (nu - 1), 1 - j / (nv - 1)]);
      }
    }
    return gridGeometry(cols, uvs);
  }

  /** n profile parameters between v0 and v1 spaced evenly by arc length at path parameter u. */
  evenProfile(u: number, v0: number, v1: number, n: number): number[] {
    const steps = 64;
    const vAt: number[] = [];
    const sAt: number[] = [0];
    let prev = this.point(u, v0);
    for (let k = 0; k <= steps; k++) {
      const v = v0 + ((v1 - v0) * k) / steps;
      vAt.push(v);
      if (k > 0) {
        const p = this.point(u, v);
        sAt.push(sAt[k - 1]! + p.distanceTo(prev));
        prev = p;
      }
    }
    const total = sAt[steps]!;
    const out: number[] = [];
    for (let j = 0; j < n; j++) {
      const target = (total * j) / (n - 1);
      let k = 0;
      while (k < steps - 1 && sAt[k + 1]! < target) k++;
      const f = (target - sAt[k]!) / Math.max(1e-9, sAt[k + 1]! - sAt[k]!);
      out.push(vAt[k]! + (vAt[k + 1]! - vAt[k]!) * Math.min(1, Math.max(0, f)));
    }
    return out;
  }

  /** Arc length (metres) of the profile between v0 and v1 at path parameter u. */
  profileLength(u: number, v0: number, v1: number, steps = 24): number {
    let len = 0;
    let prev = this.point(u, v0);
    for (let k = 1; k <= steps; k++) {
      const p = this.point(u, v0 + ((v1 - v0) * k) / steps);
      len += p.distanceTo(prev);
      prev = p;
    }
    return len;
  }

  /** A patch of the surface (u0..u1, v0..v1) lifted by `lift` along the normal: light strips and trims. */
  patch(u0: number, u1: number, v0: number, v1: number, lift: number, nu = 16, nv = 8): THREE.BufferGeometry {
    const rows: THREE.Vector3[][] = [];
    const uvs: [number, number][][] = [];
    for (let i = 0; i < nu; i++) {
      const u = u0 + ((u1 - u0) * i) / (nu - 1);
      const row: THREE.Vector3[] = [];
      const uvRow: [number, number][] = [];
      for (let j = 0; j < nv; j++) {
        const v = v0 + ((v1 - v0) * j) / (nv - 1);
        row.push(this.point(u, v).addScaledVector(this.normal(u, v), lift));
        uvRow.push([i / (nu - 1), j / (nv - 1)]);
      }
      rows.push(row);
      uvs.push(uvRow);
    }
    return gridGeometry(rows, uvs);
  }
}

/** Floor under the cockpit (closes the footwell). */
export function buildFloor(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1.3, 1.6, 1, 1);
  g.rotateX(-Math.PI / 2);
  g.translate(0, -0.8, -0.2);
  // uv.y outside the dashboard face range so the shell seams never draw on the floor.
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0, 0.9);
  return g;
}

/** Pilot seat behind the eye: headrest, reclined back and side bolsters (seen on head look). */
export function buildSeat(hi: boolean): THREE.BufferGeometry[] {
  const seg = hi ? 4 : 2;
  const part = (w: number, h: number, d: number, r: number, at: [number, number, number], tiltX = 0, yaw = 0): THREE.BufferGeometry => {
    const g = new RoundedBoxGeometry(w, h, d, seg, r);
    g.rotateX(tiltX * DEG);
    g.rotateY(yaw * DEG);
    g.translate(...at);
    return g;
  };
  // The pilot's head fills ~12 cm around the eye, so the headrest starts behind that.
  return [
    part(0.17, 0.17, 0.06, 0.025, [0, -0.04, 0.2], -8),
    part(0.4, 0.56, 0.09, 0.04, [0, -0.46, 0.3], 14),
    part(0.06, 0.46, 0.14, 0.028, [-0.215, -0.48, 0.25], 14, 10),
    part(0.06, 0.46, 0.14, 0.028, [0.215, -0.48, 0.25], 14, -10),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Panels.

export type PanelKind = 'throttle' | 'speed' | 'attitude' | 'mode' | 'status';

/** Width / height of each display; the atlas regions in displayAtlas.ts use the same proportions. */
export const REGION_ASPECT: Record<PanelKind, number> = {
  throttle: 1.5,
  speed: 1.5,
  attitude: 1.28,
  mode: 1.0,
  status: 1.0,
};

export interface PanelPlacement {
  kind: PanelKind;
  /** 'holo' panes float above the dashboard (additive); 'screen' panels are physical displays on the surfaces. */
  type: 'holo' | 'screen';
  geometry: THREE.BufferGeometry;
  /** Physical size (metres) of the display area. */
  width: number;
  height: number;
  /** Centre and outward normal (toward the pilot), for tests and lighting. */
  center: THREE.Vector3;
  normal: THREE.Vector3;
}

/**
 * A flat quad facing the eye, centred on (az, el, dist), tilted back by `tiltDeg`. uv (0,0) is the top-left corner
 * (canvas convention) so atlas drawing and overlays share coordinates.
 */
export function eyeFacingQuad(azDeg: number, elDeg: number, dist: number, w: number, h: number, tiltDeg: number): {
  geometry: THREE.BufferGeometry;
  center: THREE.Vector3;
  normal: THREE.Vector3;
} {
  const g = new THREE.PlaneGeometry(w, h, 1, 1);
  // PlaneGeometry uv has v = 1 at the top: flip to canvas convention.
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const center = v3(dirAzEl(azDeg, elDeg)).multiplyScalar(dist);
  const m = new THREE.Object3D();
  m.position.copy(center);
  // Face the eye horizontally, then tilt the top away from the pilot.
  m.rotation.order = 'YXZ';
  m.rotation.y = -azDeg * DEG;
  m.rotation.x = -tiltDeg * DEG;
  m.updateMatrix();
  g.applyMatrix4(m.matrix);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(m.quaternion);
  return { geometry: g, center, normal };
}

export interface CockpitGeometry {
  frame: THREE.BufferGeometry;
  shell: THREE.BufferGeometry;
  skin: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  trim: THREE.BufferGeometry;
  lights: THREE.BufferGeometry;
  controls: THREE.BufferGeometry;
  buttons: THREE.BufferGeometry;
  /** Glossy black glass strip across the dashboard face that the displays sit in. */
  glassBand: THREE.BufferGeometry;
  panels: PanelPlacement[];
  /** Where the instrument glow lights sit: the centre display first, then the holo panes. */
  glowAnchors: THREE.Vector3[];
}

function mergeOrThrow(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Normalise attribute sets (position, normal, uv) so geometries from different builders merge.
  const norm = parts.map((g) => {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) {
      const n = (g.getAttribute('position') as THREE.BufferAttribute).count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'tint') g.deleteAttribute(name);
    }
    return g;
  });
  const anyTint = norm.some((g) => g.getAttribute('tint'));
  if (anyTint) {
    for (const g of norm) {
      if (!g.getAttribute('tint')) {
        const n = (g.getAttribute('position') as THREE.BufferAttribute).count;
        g.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(n * 4).fill(1), 4));
      }
    }
  }
  const indexed = norm.every((g) => g.index);
  const merged = mergeGeometries(indexed ? norm : norm.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  if (!merged) throw new Error('cockpit geometry merge failed');
  return merged;
}

/** Set a constant per-vertex tint (rgb = colour or emission weight, a = material variant). */
export function withTint(g: THREE.BufferGeometry, r: number, gg: number, b: number, a = 1): THREE.BufferGeometry {
  const n = (g.getAttribute('position') as THREE.BufferAttribute).count;
  const arr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) arr.set([r, gg, b, a], i * 4);
  g.setAttribute('tint', new THREE.BufferAttribute(arr, 4));
  return g;
}

/** Orient a geometry built along +Y so its up axis points along `up`, then move it to `at`. */
function place(g: THREE.BufferGeometry, at: THREE.Vector3, up: THREE.Vector3): THREE.BufferGeometry {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up.clone().normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(at, q, new THREE.Vector3(1, 1, 1)));
  return g;
}

/** Side stick (right console): trim collar, short boot, forward-leaning ergonomic grip with a hat switch and a lit ring. */
function buildStick(base: THREE.Vector3, up: THREE.Vector3, hi: boolean): { body: THREE.BufferGeometry[]; trim: THREE.BufferGeometry[]; glow: THREE.BufferGeometry[] } {
  const seg = hi ? 28 : 14;
  const collar = new THREE.CylinderGeometry(0.034, 0.038, 0.008, seg);
  collar.translate(0, 0.002, 0);
  const boot = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.03, 0.004),
      new THREE.Vector2(0.026, 0.014),
      new THREE.Vector2(0.016, 0.026),
      new THREE.Vector2(0.0105, 0.034),
      new THREE.Vector2(0.0, 0.036),
    ],
    seg,
  );
  const ring = new THREE.TorusGeometry(0.0125, 0.0018, 6, seg);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, 0.038, 0);
  const grip = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.0, 0.0),
      new THREE.Vector2(0.0135, 0.0),
      new THREE.Vector2(0.0165, 0.012),
      new THREE.Vector2(0.0175, 0.034),
      new THREE.Vector2(0.016, 0.058),
      new THREE.Vector2(0.0185, 0.074),
      new THREE.Vector2(0.0165, 0.086),
      new THREE.Vector2(0.009, 0.092),
      new THREE.Vector2(0.0, 0.093),
    ],
    seg,
  );
  grip.scale(1, 1, 1.3);
  grip.rotateX(-16 * DEG);
  grip.translate(0, 0.038, 0);
  const hat = new THREE.CylinderGeometry(0.0042, 0.0042, 0.005, 12);
  hat.rotateX(-16 * DEG);
  hat.translate(0, 0.038 + 0.09, -0.026);
  return {
    body: [boot, grip].map((g) => place(g, base, up)),
    trim: [place(collar, base, up)],
    glow: [withTint(place(ring, base, up), 1, 1, 1, 1), withTint(place(hat, base, up), 1.0, 0.55, 0.2, 0)],
  };
}

/** Throttle (left console): trim plate with a lit track slot, short lever, upright grip with a lit ring. */
function buildThrottle(base: THREE.Vector3, up: THREE.Vector3, hi: boolean): { body: THREE.BufferGeometry[]; trim: THREE.BufferGeometry[]; glow: THREE.BufferGeometry[] } {
  const seg = hi ? 20 : 12;
  const plate = new THREE.BoxGeometry(0.03, 0.006, 0.12);
  plate.translate(0, 0.002, 0.01);
  const slot = new THREE.BoxGeometry(0.005, 0.002, 0.1);
  slot.translate(0, 0.0055, 0.01);
  const lever = new THREE.BoxGeometry(0.008, 0.04, 0.014);
  lever.translate(0, 0.024, 0);
  const grip = new THREE.CapsuleGeometry(0.017, 0.034, hi ? 6 : 4, seg);
  grip.scale(1, 1, 1.25);
  grip.rotateX(14 * DEG);
  grip.translate(0, 0.066, 0.004);
  const strip = new THREE.TorusGeometry(0.0168, 0.0016, 6, seg);
  strip.scale(1, 1.25, 1);
  strip.rotateX(Math.PI / 2 + 14 * DEG);
  strip.translate(0, 0.074, 0.006);
  return {
    body: [lever, grip].map((g) => place(g, base, up)),
    trim: [place(plate, base, up)],
    glow: [withTint(place(slot, base, up), 0.6, 0.6, 0.6, 1), withTint(place(strip, base, up), 1, 1, 1, 1)],
  };
}

/** Everything static in the cockpit. */
export function buildCockpitGeometry(quality: 'low' | 'high' = 'high'): CockpitGeometry {
  const hi = quality === 'high';
  const dash = new DashSurface(hi ? 120 : 64, hi ? 44 : 26);

  // --- Shell: dashboard + consoles loft and the floor.
  const shell = mergeOrThrow([dash.geometry(), buildFloor()]);

  // --- Light strip along the lip (just under the top edge on the pilot side).
  const vLip = dash.vOf(PROFILE_LIP);
  const vFace = dash.vOf(PROFILE_LIP - 1);
  const uL = dash.uAtX(-0.47);
  const uR = dash.uAtX(0.47);
  const lipStrip = withTint(dash.patch(uL, uR, vFace + (vLip - vFace) * 0.25, vFace + (vLip - vFace) * 0.45, 0.0015, hi ? 64 : 32, 2), 1, 1, 1, 1);

  // --- Trim: a satin band at the lip (rounded edge highlight) across the front.
  const trimParts: THREE.BufferGeometry[] = [dash.patch(uL, uR, vLip - 0.006, vLip + 0.012, 0.0012, hi ? 80 : 40, 4)];

  // --- Glass cockpit band: one glossy black glass strip across the dashboard face; the displays sit inside it.
  const panels: PanelPlacement[] = [];
  const vTop = dash.vOf(PROFILE_LIP - 1) + 0.006;
  const vBot = dash.vOf(PROFILE_LIP - 3) + 0.026;
  const band = dash.arcPatch(0.5, 0.315, vBot - 0.014, vTop + 0.005, 0.0012, hi ? 90 : 48, 6);
  const screenAt = (kind: PanelKind, x: number, aspect: number, v0: number, v1: number): void => {
    const uc = x === 0 ? 0.5 : dash.uAtX(x);
    const h = dash.profileLength(uc, v0, v1);
    const w = h * aspect;
    const g = dash.arcPatch(uc, w / 2, v0, v1, 0.0022, 18, 10);
    const vm = (v0 + v1) / 2;
    panels.push({ kind, type: 'screen', geometry: g, width: w, height: h, center: dash.point(uc, vm), normal: dash.normal(uc, vm) });
  };
  screenAt('attitude', 0, REGION_ASPECT.attitude, vBot, vTop);
  screenAt('mode', -0.215, REGION_ASPECT.mode, vBot, vTop);
  screenAt('status', 0.215, REGION_ASPECT.status, vBot, vTop);

  // --- Holographic panes floating above the dashboard, either side of the clear forward view.
  const holo = (kind: PanelKind, az: number): void => {
    const w = 0.135;
    const h = 0.09;
    const q = eyeFacingQuad(az, -12.2, 0.6, w, h, 14);
    panels.push({ kind, type: 'holo', geometry: q.geometry, width: w, height: h, center: q.center, normal: q.normal });
  };
  holo('throttle', -25.4);
  holo('speed', 25.4);

  // Projector emitters under the holo panes (small lit slots on the lip).
  const emitters: THREE.BufferGeometry[] = [];
  for (const x of [-0.25, 0.25]) {
    const u0 = dash.uAtX(x - 0.06);
    const u1 = dash.uAtX(x + 0.06);
    emitters.push(withTint(dash.patch(u0, u1, vLip - 0.004, vLip + 0.004, 0.0028, 12, 2), 1.6, 1.6, 1.6, 1));
  }

  // --- Controls: throttle on the left console, side stick on the right.
  const consoleTop = (x: number, inset: number): { at: THREE.Vector3; up: THREE.Vector3 } => {
    const u = dash.uAtX(x);
    const v = dash.vOf(PROFILE_LIP) + inset;
    return { at: dash.point(u, v), up: dash.normal(u, v).lerp(new THREE.Vector3(0, 1, 0), 0.6).normalize() };
  };
  const tPos = consoleTop(-0.468, 0.034);
  const sPos = consoleTop(0.468, 0.034);
  const throttle = buildThrottle(tPos.at, tPos.up, hi);
  const stick = buildStick(sPos.at, sPos.up, hi);

  // --- Buttons: rows of small backlit keys on the console tops (one merged mesh, per-key tint).
  const buttons: THREE.BufferGeometry[] = [];
  const keyColors: [number, number, number][] = [
    [0.5, 0.83, 1.0],
    [0.5, 0.83, 1.0],
    [0.25, 0.4, 0.5],
    [1.0, 0.7, 0.28],
    [0.5, 0.83, 1.0],
    [0.25, 0.4, 0.5],
  ];
  let k = 0;
  for (const side of [-1, 1] as const) {
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 4; col++) {
        const u = dash.uAtX(side * 0.505);
        const uu = side < 0 ? u - 0.004 - col * 0.0105 : u + 0.004 + col * 0.0105;
        const v = dash.vOf(PROFILE_LIP) + 0.045 + row * 0.03;
        const at = dash.point(Math.min(1, Math.max(0, uu)), v);
        const up = dash.normal(Math.min(1, Math.max(0, uu)), v);
        const key = new THREE.BoxGeometry(0.013, 0.004, 0.009);
        const c = keyColors[k++ % keyColors.length]!;
        buttons.push(withTint(place(key, at.addScaledVector(up, 0.002), up), c[0], c[1], c[2], 1));
      }
    }
  }

  // Kept 15+ cm from any surface so the point lights read as a soft glow rather than a hot spot.
  const glowAnchors = [
    new THREE.Vector3(0, LIP_PATH[0]![2] + 0.07, LIP_PATH[0]![1] + 0.2),
    ...panels.filter((p) => p.type === 'holo').map((p) => p.center.clone().addScaledVector(p.normal, 0.14).add(new THREE.Vector3(0, -0.02, 0))),
  ];

  return {
    frame: buildFrame(quality),
    shell,
    skin: canopyEllipsoid(0.994, quality),
    glass: canopyEllipsoid(1.0, quality),
    trim: mergeOrThrow([...trimParts, ...throttle.trim, ...stick.trim]),
    lights: mergeOrThrow([lipStrip, ...emitters, ...pillarLightStrips(), ...throttle.glow, ...stick.glow]),
    controls: mergeOrThrow([...throttle.body, ...stick.body, ...buildSeat(hi)]),
    buttons: mergeOrThrow(buttons),
    glassBand: band,
    panels,
    glowAnchors,
  };
}

/** Triangle count of a geometry. */
export function triangleCount(g: THREE.BufferGeometry): number {
  return g.index ? g.index.count / 3 : (g.getAttribute('position') as THREE.BufferAttribute).count / 3;
}

export { canopyExit };
