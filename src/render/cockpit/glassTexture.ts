/**
 * Canopy wear texture, generated in code (deterministic, seeded): micro-scratches, cleaning swirls and smudges.
 *
 * RGBA8, tileable:
 *   R  scratch strength
 *   GB scratch orientation as a double-angle vector (0.5 + 0.5 cos 2θ, 0.5 + 0.5 sin 2θ). A line has no direction, so
 *      the double angle makes θ and θ + π identical and lets mip averaging blend orientations sensibly.
 *   A  smudge / film density
 *
 * The shader lights a scratch when it runs perpendicular to the direction toward the Sun, which is what makes real
 * scratched glass show concentric glints around a bright light.
 */
import { Rng } from '../../core/rng';

export interface GlassTexture {
  size: number;
  data: Uint8Array;
}

/** Tileable value noise from a precomputed lattice (fast; used once at startup). */
class TileNoise {
  private readonly lattice: Float32Array;
  constructor(
    private readonly n: number,
    rng: Rng,
  ) {
    this.lattice = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) this.lattice[i] = rng.next();
  }
  /** x, y in lattice units, wrapping every n. Returns [0, 1). */
  at(x: number, y: number): number {
    const n = this.n;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % n) + n) % n;
    const y0 = ((yi % n) + n) % n;
    const x1 = (x0 + 1) % n;
    const y1 = (y0 + 1) % n;
    const L = this.lattice;
    const a = L[y0 * n + x0]!;
    const b = L[y0 * n + x1]!;
    const c = L[y1 * n + x0]!;
    const d = L[y1 * n + x1]!;
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
}

export function buildGlassTexture(size = 1024, seed = 0x6b5c_a11d): GlassTexture {
  const rng = new Rng(seed);
  const n = size * size;
  const strength = new Float32Array(n);
  const ox = new Float32Array(n);
  const oy = new Float32Array(n);

  /** Splat an anti-aliased point with orientation (double-angle components c2, s2). */
  const splat = (x: number, y: number, s: number, c2: number, s2: number): void => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
    for (let k = 0; k < 4; k++) {
      const px = (((xi + (k & 1)) % size) + size) % size;
      const py = (((yi + (k >> 1)) % size) + size) % size;
      const i = py * size + px;
      const v = s * w[k]!;
      if (v > strength[i]!) {
        strength[i] = v;
        ox[i] = c2;
        oy[i] = s2;
      }
    }
  };

  // Micro-scratches: short straight lines, random orientation, log-uniform length.
  const scratches = Math.round(4200 * (size / 1024) ** 2);
  for (let s = 0; s < scratches; s++) {
    const cx = rng.next() * size;
    const cy = rng.next() * size;
    const th = rng.next() * Math.PI;
    const len = Math.exp(rng.range(Math.log(3), Math.log(42))) * (size / 1024);
    const amp = 0.2 + 0.8 * rng.next() ** 1.5;
    const c2 = Math.cos(2 * th);
    const s2 = Math.sin(2 * th);
    const dx = Math.cos(th);
    const dy = Math.sin(th);
    const steps = Math.ceil(len * 2);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps - 0.5;
      // Taper the ends; vary along the length a little (a scratch is never uniform).
      const taper = Math.min(1, (0.5 - Math.abs(t)) * 8);
      const wob = 0.75 + 0.25 * Math.sin(k * 0.37 + s);
      splat(cx + dx * t * len, cy + dy * t * len, amp * taper * wob, c2, s2);
    }
  }

  // Cleaning swirls: faint long arcs.
  const swirls = Math.round(70 * (size / 1024) ** 2);
  for (let s = 0; s < swirls; s++) {
    const cx = rng.next() * size;
    const cy = rng.next() * size;
    const r = rng.range(60, 320) * (size / 1024);
    const a0 = rng.next() * Math.PI * 2;
    const span = rng.range(0.25, 1.3);
    const amp = rng.range(0.12, 0.35);
    const steps = Math.ceil(r * span * 2);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const a = a0 + span * t;
      const th = a + Math.PI / 2; // tangent
      const taper = Math.min(1, Math.min(t, 1 - t) * 6);
      splat(cx + Math.cos(a) * r, cy + Math.sin(a) * r, amp * taper, Math.cos(2 * th), Math.sin(2 * th));
    }
  }

  // Smudges: a faint uneven film, curved wipe streaks left by a cleaning cloth, soft prints and dust.
  const n1 = new TileNoise(8, rng);
  const n2 = new TileNoise(64, rng);
  const film = new Float32Array(n);
  const s1 = 8 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      film[y * size + x] = 0.03 + 0.07 * n1.at(x * s1, y * s1);
    }
  }
  const deposit = (x: number, y: number, v: number): void => {
    const px = ((Math.round(x) % size) + size) % size;
    const py = ((Math.round(y) % size) + size) % size;
    const i = py * size + px;
    film[i] = Math.max(film[i]!, v);
  };
  const scale = size / 1024;
  const wipes = Math.round(46 * scale * scale);
  for (let w = 0; w < wipes; w++) {
    const cx = rng.next() * size;
    const cy = rng.next() * size;
    const r = rng.range(120, 520) * scale;
    const a0 = rng.next() * Math.PI * 2;
    const span = rng.range(0.35, 1.2) * (rng.next() < 0.5 ? -1 : 1);
    const width = rng.range(8, 30) * scale;
    const dens = rng.range(0.14, 0.34);
    const len = Math.abs(span) * r;
    const steps = Math.ceil(len / 0.8);
    const across = Math.ceil(width / 0.7);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const a = a0 + span * t;
      const ends = Math.min(1, Math.min(t, 1 - t) * 5);
      for (let j = -across; j <= across; j++) {
        const o = (j / across) * width;
        const rr = r + o;
        // Fibre striations along the stroke, soft edges across it.
        const stri = 0.55 + 0.45 * n2.at((rr / scale) * 0.9, t * 6 + w * 3.7);
        const edge = Math.exp(-((o / width) ** 2) * 2.5);
        deposit(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, dens * ends * edge * stri);
      }
    }
  }
  const prints = Math.round(14 * scale * scale);
  for (let p = 0; p < prints; p++) {
    const px0 = rng.next() * size;
    const py0 = rng.next() * size;
    const rx = rng.range(16, 38) * scale;
    const ry = rng.range(11, 24) * scale;
    const ang = rng.next() * Math.PI;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const rad = Math.ceil(Math.max(rx, ry));
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const u = (dx * ca + dy * sa) / rx;
        const v = (-dx * sa + dy * ca) / ry;
        const d2 = u * u + v * v;
        if (d2 < 1) deposit(px0 + dx, py0 + dy, (1 - d2) * (1 - d2) * 0.32);
      }
    }
  }
  const dust = Math.round(2600 * scale * scale);
  for (let d = 0; d < dust; d++) {
    const x = rng.next() * size;
    const y = rng.next() * size;
    const v = rng.range(0.25, 0.85);
    deposit(x, y, v);
    if (rng.next() < 0.3) deposit(x + 1, y, v * 0.6);
  }
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = Math.round(Math.min(1, strength[i]!) * 255);
    data[i * 4 + 1] = Math.round((0.5 + 0.5 * ox[i]!) * 255);
    data[i * 4 + 2] = Math.round((0.5 + 0.5 * oy[i]!) * 255);
    data[i * 4 + 3] = Math.round(Math.min(1, film[i]!) * 255);
  }
  return { size, data };
}
