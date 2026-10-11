/**
 * Solar System ephemeris: Chebyshev segments fitted offline to JPL Horizons vectors (tools/pipeline/ephemeris.py).
 * Each series gives a body's position relative to its parent (Solar System Barycenter, a planet-system barycenter, or
 * a planet) in ICRF axes, meters, over TDB seconds since J2000.0.
 */
import { Vec3d } from '../core/vec3d';
import { fetchBytes, fetchJson } from '../data/assets';

export interface EphemerisSeriesMeta {
  id: string;
  name: string;
  parent: string;
  t0: number;
  segmentSeconds: number;
  segments: number;
  degree: number;
  dtype: 'f32' | 'f64';
  byteOffset: number;
  maxHeldOutErrorMeters: number;
}

export interface EphemerisFile {
  version: number;
  source: string;
  retrieved: string;
  window: [string, string];
  bodies: EphemerisSeriesMeta[];
}

interface Series extends EphemerisSeriesMeta {
  coeffs: Float32Array | Float64Array;
}

export const SSB = '0';

export class Ephemeris {
  readonly tMin: number;
  readonly tMax: number;
  private readonly series = new Map<string, Series>();

  constructor(
    readonly meta: EphemerisFile,
    buffer: ArrayBuffer,
  ) {
    let tMin = -Infinity;
    let tMax = Infinity;
    for (const b of meta.bodies) {
      const n = b.segments * 3 * (b.degree + 1);
      const coeffs = b.dtype === 'f32' ? new Float32Array(buffer, b.byteOffset, n) : new Float64Array(buffer, b.byteOffset, n);
      this.series.set(b.id, { ...b, coeffs });
      tMin = Math.max(tMin, b.t0);
      tMax = Math.min(tMax, b.t0 + b.segments * b.segmentSeconds);
    }
    this.tMin = tMin;
    this.tMax = tMax - 1;
  }

  static async load(): Promise<Ephemeris> {
    const [meta, buf] = await Promise.all([fetchJson<EphemerisFile>('ephemeris.json'), fetchBytes('ephemeris.bin')]);
    return new Ephemeris(meta, buf);
  }

  has(id: string): boolean {
    return id === SSB || this.series.has(id);
  }

  parentOf(id: string): string | null {
    return id === SSB ? null : (this.series.get(id)?.parent ?? null);
  }

  clampTime(t: number): number {
    return Math.min(this.tMax, Math.max(this.tMin, t));
  }

  /** Position of `id` relative to its parent, meters (ICRF). Time is clamped to the fitted window. */
  relative(id: string, t: number, out: Vec3d): Vec3d {
    const s = this.series.get(id);
    if (!s) return out.set(0, 0, 0);
    const tc = this.clampTime(t);
    let seg = Math.floor((tc - s.t0) / s.segmentSeconds);
    seg = Math.min(s.segments - 1, Math.max(0, seg));
    const a = s.t0 + seg * s.segmentSeconds;
    const x = (2 * (tc - a)) / s.segmentSeconds - 1;
    const n = s.degree + 1;
    const base = seg * 3 * n;
    const c = s.coeffs;
    const res = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      // Clenshaw recurrence.
      let b1 = 0;
      let b2 = 0;
      const o = base + k * n;
      for (let j = n - 1; j >= 1; j--) {
        const b0 = c[o + j]! + 2 * x * b1 - b2;
        b2 = b1;
        b1 = b0;
      }
      res[k] = c[o]! + x * b1 - b2;
    }
    return out.set(res[0]!, res[1]!, res[2]!);
  }

  private chain(id: string): string[] {
    const ids: string[] = [];
    let cur: string | null = id;
    while (cur !== null && cur !== SSB) {
      ids.push(cur);
      cur = this.parentOf(cur);
    }
    ids.push(SSB);
    return ids;
  }

  /** Position of `id` relative to the Solar System Barycenter. */
  ssb(id: string, t: number, out: Vec3d): Vec3d {
    out.set(0, 0, 0);
    const tmp = new Vec3d();
    for (const c of this.chain(id)) if (c !== SSB) out.add(this.relative(c, t, tmp));
    return out;
  }

  /**
   * Position of `a` relative to `b`, summed only below their lowest common ancestor so that, e.g., Moon-relative-to-
   * Earth never round-trips through barycentric magnitudes.
   */
  between(a: string, b: string, t: number, out: Vec3d): Vec3d {
    const ca = this.chain(a);
    const cb = this.chain(b);
    const setB = new Set(cb);
    const lca = ca.find((x) => setB.has(x)) ?? SSB;
    out.set(0, 0, 0);
    const tmp = new Vec3d();
    for (const x of ca) {
      if (x === lca) break;
      out.add(this.relative(x, t, tmp));
    }
    for (const x of cb) {
      if (x === lca) break;
      out.sub(this.relative(x, t, tmp));
    }
    return out;
  }

  /** Velocity of `a` relative to `b` (m/s) by central difference (1 s), accurate to ~1e-4 m/s. */
  velocityBetween(a: string, b: string, t: number, out: Vec3d): Vec3d {
    const p1 = this.between(a, b, t + 1, new Vec3d());
    const p0 = this.between(a, b, t - 1, new Vec3d());
    return out.subVectors(p1, p0).scale(0.5);
  }
}
