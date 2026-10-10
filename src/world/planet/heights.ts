/**
 * Height functions for bodies, shared by workers (geometry) and the main thread (collision, altitude).
 * Heights are meters above the reference sphere. Data heightmaps are Measured; procedural detail added below the
 * data resolution, and whole procedural terrains, are Generated (and labeled so in the UI).
 */
import { fbm3, hashInts, toUnit } from '../../core/rng';
import { FACES } from './cubeSphere';

export type ProceduralKind = 'none' | 'earthlike' | 'cratered' | 'icy' | 'volcanic';

export interface HeightmapData {
  /** Equirectangular grid, row 0 = north (lat +90), column 0 = lon −180. */
  width: number;
  height: number;
  /** Heights in meters. */
  data: Int16Array | Float32Array;
}

export interface HeightConfig {
  key: string;
  radius: number;
  seed: number;
  procedural: ProceduralKind;
  /** Amplitude of procedural relief in meters. */
  amplitude: number;
  /** Clamp heights below this to it (sea surface), meters. Undefined = no ocean. */
  seaLevel?: number;
  heightmap?: HeightmapData;
}

function sampleHeightmap(hm: HeightmapData, lat: number, lon: number): number {
  const fx = ((lon + Math.PI) / (2 * Math.PI)) * hm.width - 0.5;
  const fy = ((Math.PI / 2 - lat) / Math.PI) * hm.height - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const W = hm.width;
  const H = hm.height;
  const yy0 = Math.min(H - 1, Math.max(0, y0));
  const yy1 = Math.min(H - 1, Math.max(0, y0 + 1));
  const xx0 = ((x0 % W) + W) % W;
  const xx1 = (((x0 + 1) % W) + W) % W;
  const d = hm.data;
  const a = d[yy0 * W + xx0]!;
  const b = d[yy0 * W + xx1]!;
  const c = d[yy1 * W + xx0]!;
  const e = d[yy1 * W + xx1]!;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
}

/**
 * Deterministic crater field. Craters live in cells of a cube-face grid at several levels; each cell holds at most one
 * crater with hashed position and radius. Profile: parabolic bowl + raised rim + ejecta falloff.
 */
function craters(cfg: HeightConfig, x: number, y: number, z: number): number {
  let h = 0;
  const R = cfg.radius;
  // Pick the dominant face for cell indexing.
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let face: number;
  if (ax >= ay && ax >= az) face = x > 0 ? 0 : 1;
  else if (ay >= az) face = y > 0 ? 2 : 3;
  else face = z > 0 ? 4 : 5;
  const f = FACES[face]!;
  const dn = x * f.n[0] + y * f.n[1] + z * f.n[2];
  const u = (x * f.t[0] + y * f.t[1] + z * f.t[2]) / dn;
  const v = (x * f.b[0] + y * f.b[1] + z * f.b[2]) / dn;
  for (let level = 2; level <= 13; level++) {
    const cells = 1 << level;
    const cu = ((u + 1) / 2) * cells;
    const cv = ((v + 1) / 2) * cells;
    const ci = Math.floor(cu);
    const cj = Math.floor(cv);
    // Check this cell and neighbours so craters can straddle cell edges.
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di;
        const j = cj + dj;
        const hsh = hashInts(cfg.seed, face, level, i, j);
        if (toUnit(hsh) > 0.55) continue; // not every cell has a crater
        const px = i + 0.2 + 0.6 * toUnit(hashInts(hsh, 1));
        const py = j + 0.2 + 0.6 * toUnit(hashInts(hsh, 2));
        const rad = 0.12 + 0.3 * Math.pow(toUnit(hashInts(hsh, 3)), 2); // in cell units
        const dx = cu - px;
        const dy = cv - py;
        const r = Math.sqrt(dx * dx + dy * dy) / rad;
        if (r > 2.2) continue;
        const cellMeters = ((2 * R) / cells) * 0.9;
        const diameter = rad * 2 * cellMeters;
        const depth = Math.min(0.2 * diameter, 4000);
        let p: number;
        if (r < 1) p = (r * r - 1) * depth + 0.12 * depth; // bowl
        else p = 0.12 * depth * Math.exp(-((r - 1) * (r - 1)) * 6); // rim and ejecta
        h += p;
      }
    }
  }
  return h;
}

/** Height (m) at unit body-fixed direction (x, y, z). */
export function heightAt(cfg: HeightConfig, x: number, y: number, z: number): number {
  let h = 0;
  if (cfg.heightmap) {
    const lat = Math.asin(Math.max(-1, Math.min(1, z)));
    const lon = Math.atan2(y, x);
    h = sampleHeightmap(cfg.heightmap, lat, lon);
  }
  const R = cfg.radius;
  switch (cfg.procedural) {
    case 'earthlike': {
      // Sub-data-resolution detail: ~a few hundred meters of relief at km scale, fading on oceans.
      const s = R / 20_000; // feature scale ~20 km
      const n = fbm3(cfg.seed, x * s, y * s, z * s, 11);
      const land = cfg.heightmap ? Math.max(0, Math.min(1, h / 200)) : 1;
      h += n * cfg.amplitude * land;
      break;
    }
    case 'cratered': {
      const s = R / 50_000;
      h += fbm3(cfg.seed, x * s, y * s, z * s, 6) * cfg.amplitude * 0.3;
      h += craters(cfg, x, y, z);
      break;
    }
    case 'icy': {
      const s = R / 30_000;
      const n = fbm3(cfg.seed, x * s, y * s, z * s, 6);
      h += Math.abs(n) * cfg.amplitude - cfg.amplitude * 0.3;
      break;
    }
    case 'volcanic': {
      const s = R / 40_000;
      h += fbm3(cfg.seed, x * s, y * s, z * s, 7) * cfg.amplitude;
      break;
    }
    case 'none':
      break;
  }
  if (cfg.seaLevel !== undefined && h < cfg.seaLevel) h = cfg.seaLevel;
  return h;
}

/** True if the unmodified data height is below sea level (ocean), used for shading. */
export function isOcean(cfg: HeightConfig, x: number, y: number, z: number): boolean {
  if (cfg.seaLevel === undefined || !cfg.heightmap) return false;
  const lat = Math.asin(Math.max(-1, Math.min(1, z)));
  const lon = Math.atan2(y, x);
  return sampleHeightmap(cfg.heightmap, lat, lon) < cfg.seaLevel;
}
