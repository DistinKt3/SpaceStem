/**
 * Deterministic hashing and pseudo-random numbers. Integer math only (Math.imul, >>> 0), so results are
 * bit-identical on every JavaScript engine and machine. Same (seed, coordinates) -> same result everywhere.
 */

/** 32-bit finalizer from MurmurHash3. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85eb_ca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2_ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash any number of 32-bit integers into one 32-bit integer. */
export function hashInts(seed: number, ...values: number[]): number {
  let h = fmix32(seed ^ 0x9e37_79b9);
  for (const v of values) {
    h = fmix32((h ^ Math.imul(v | 0, 0x27d4_eb2d)) + 0x1656_67b1);
  }
  return h;
}

/** Hash a string (UTF-16 code units) to 32 bits, FNV-1a then finalized. */
export function hashString(s: string, seed = 0): number {
  let h = (0x811c_9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x0100_0193);
  }
  return fmix32(h);
}

/** Map a 32-bit unsigned integer to [0, 1). */
export const toUnit = (h: number): number => (h >>> 0) / 4_294_967_296;

/** Small, fast, deterministic PRNG (mulberry32). */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  /** Next 32-bit unsigned integer. */
  nextU32(): number {
    this.state = (this.state + 0x6d2b_79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  /** Uniform in [0, 1). */
  next(): number {
    return toUnit(this.nextU32());
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  int(min: number, maxExclusive: number): number {
    return min + Math.floor(this.next() * (maxExclusive - min));
  }
}

/**
 * Value noise on an integer lattice, 3D, deterministic. Returns [-1, 1]. Lattice values come from integer hashes;
 * interpolation is plain float math (identical on all IEEE-754 engines for the same inputs).
 */
export function valueNoise3(seed: number, x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const c = (i: number, j: number, k: number): number => toUnit(hashInts(seed, xi + i, yi + j, zi + k)) * 2 - 1;
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * u;
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * u;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * u;
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

/** Fractal Brownian motion over valueNoise3. */
export function fbm3(seed: number, x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(seed + o * 101, x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
