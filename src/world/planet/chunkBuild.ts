/**
 * Builds one terrain chunk: a (G+1)^2 vertex grid on a cube-face patch, displaced by the body's height function,
 * stored relative to the chunk's anchor (float64 math, float32 output), plus a skirt to hide LOD cracks.
 */
import { faceToSphere, nodeUvRange } from './cubeSphere';
import { heightAt, isOcean, type HeightConfig } from './heights';

export interface ChunkRequest {
  face: number;
  level: number;
  ix: number;
  iy: number;
  grid: number;
}

export interface ChunkData {
  /** Anchor in body-fixed meters (on the reference sphere, chunk center). */
  anchor: [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** Cube-face coordinates in [0,1]^2 across the whole face (for tile-pyramid imagery). */
  fuvs: Float32Array;
  /** Per-vertex flags: x = ocean (0/1), y = height (m) for shading. */
  extras: Float32Array;
  minHeight: number;
  maxHeight: number;
  /** Bounding radius around the anchor (m). */
  radius: number;
  /** Geometric error (m): max distance between the true surface at quad centers and this mesh. Drives LOD. */
  error: number;
}

/** Shared index buffer for a grid with skirts. */
export function buildIndices(grid: number): Uint32Array {
  const n = grid + 1;
  const idx: number[] = [];
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  // Skirt vertices follow the grid: 4 edges of n vertices each, in order bottom, right, top, left.
  const base = n * n;
  const edge = (k: number, e: number): number => base + e * n + k;
  const gridAt = (i: number, j: number): number => j * n + i;
  for (let k = 0; k < grid; k++) {
    // bottom edge j=0, i=k
    let g0 = gridAt(k, 0);
    let g1 = gridAt(k + 1, 0);
    let s0 = edge(k, 0);
    let s1 = edge(k + 1, 0);
    idx.push(g0, s0, s1, g0, s1, g1);
    // right edge i=grid, j=k
    g0 = gridAt(grid, k);
    g1 = gridAt(grid, k + 1);
    s0 = edge(k, 1);
    s1 = edge(k + 1, 1);
    idx.push(g0, s0, s1, g0, s1, g1);
    // top edge j=grid, i=k (reverse winding)
    g0 = gridAt(k, grid);
    g1 = gridAt(k + 1, grid);
    s0 = edge(k, 2);
    s1 = edge(k + 1, 2);
    idx.push(g0, s1, s0, g0, g1, s1);
    // left edge i=0, j=k (reverse winding)
    g0 = gridAt(0, k);
    g1 = gridAt(0, k + 1);
    s0 = edge(k, 3);
    s1 = edge(k + 1, 3);
    idx.push(g0, s1, s0, g0, g1, s1);
  }
  return new Uint32Array(idx);
}

export function buildChunk(cfg: HeightConfig, req: ChunkRequest): ChunkData {
  const { face, level, ix, iy, grid } = req;
  const R = cfg.radius;
  const [u0, v0, u1, v1] = nodeUvRange(level, ix, iy);
  const n = grid + 1;
  const m = n + 2; // with a 1-sample border for normals
  const du = (u1 - u0) / grid;
  const dv = (v1 - v0) / grid;
  // Vertex spacing (m); procedural detail below a quarter of it is skipped (cost, aliasing).
  const minFeature = ((R * (u1 - u0) * Math.PI) / 4 / grid) * 0.25;

  const center = new Float64Array(3);
  faceToSphere(face, (u0 + u1) / 2, (v0 + v1) / 2, center);
  const ax = center[0]! * R;
  const ay = center[1]! * R;
  const az = center[2]! * R;
  const centerLon = Math.atan2(center[1]!, center[0]!);

  // Sample world positions (body-fixed, float64) on the bordered grid.
  const P = new Float64Array(m * m * 3);
  const H = new Float64Array(m * m);
  const OCEAN = new Uint8Array(m * m);
  const D = new Float64Array(3);
  let minH = Infinity;
  let maxH = -Infinity;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      faceToSphere(face, u0 + (i - 1) * du, v0 + (j - 1) * dv, D);
      const x = D[0]!;
      const y = D[1]!;
      const z = D[2]!;
      const h = heightAt(cfg, x, y, z, minFeature);
      const k = j * m + i;
      H[k] = h;
      OCEAN[k] = isOcean(cfg, x, y, z) ? 1 : 0;
      const r = R + h;
      P[k * 3] = x * r;
      P[k * 3 + 1] = y * r;
      P[k * 3 + 2] = z * r;
      if (i > 0 && j > 0 && i < m - 1 && j < m - 1) {
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
  }

  // Geometric error: true surface at each quad center vs. the mesh (average of the quad's corners).
  let error = 0;
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      faceToSphere(face, u0 + (i + 0.5) * du, v0 + (j + 0.5) * dv, D);
      const r = R + heightAt(cfg, D[0]!, D[1]!, D[2]!, minFeature);
      const k00 = ((j + 1) * m + (i + 1)) * 3;
      const k10 = k00 + 3;
      const k01 = k00 + m * 3;
      const k11 = k01 + 3;
      const mx = (P[k00]! + P[k10]! + P[k01]! + P[k11]!) / 4;
      const my = (P[k00 + 1]! + P[k10 + 1]! + P[k01 + 1]! + P[k11 + 1]!) / 4;
      const mz = (P[k00 + 2]! + P[k10 + 2]! + P[k01 + 2]! + P[k11 + 2]!) / 4;
      const e = Math.hypot(D[0]! * r - mx, D[1]! * r - my, D[2]! * r - mz);
      if (e > error) error = e;
    }
  }

  const vcount = n * n + 4 * n;
  const positions = new Float32Array(vcount * 3);
  const normals = new Float32Array(vcount * 3);
  const uvs = new Float32Array(vcount * 2);
  const fuvs = new Float32Array(vcount * 2);
  const extras = new Float32Array(vcount * 2);
  let radius = 0;

  const write = (vi: number, k: number, drop: number): void => {
    // Face coordinates of bordered-grid sample k.
    const gi = (k % m) - 1;
    const gj = Math.floor(k / m) - 1;
    fuvs[vi * 2] = (u0 + gi * du + 1) / 2;
    fuvs[vi * 2 + 1] = (v0 + gj * dv + 1) / 2;
    const px = P[k * 3]!;
    const py = P[k * 3 + 1]!;
    const pz = P[k * 3 + 2]!;
    const len = Math.hypot(px, py, pz);
    const s = (len - drop) / len;
    const rx = px * s - ax;
    const ry = py * s - ay;
    const rz = pz * s - az;
    positions[vi * 3] = rx;
    positions[vi * 3 + 1] = ry;
    positions[vi * 3 + 2] = rz;
    const rr = Math.hypot(rx, ry, rz);
    if (rr > radius) radius = rr;
    // Normal from central differences on the bordered grid.
    const kx0 = k - 1;
    const kx1 = k + 1;
    const ky0 = k - m;
    const ky1 = k + m;
    const tx = P[kx1 * 3]! - P[kx0 * 3]!;
    const ty = P[kx1 * 3 + 1]! - P[kx0 * 3 + 1]!;
    const tz = P[kx1 * 3 + 2]! - P[kx0 * 3 + 2]!;
    const bx = P[ky1 * 3]! - P[ky0 * 3]!;
    const by = P[ky1 * 3 + 1]! - P[ky0 * 3 + 1]!;
    const bz = P[ky1 * 3 + 2]! - P[ky0 * 3 + 2]!;
    let nx = ty * bz - tz * by;
    let ny = tz * bx - tx * bz;
    let nz = tx * by - ty * bx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    normals[vi * 3] = nx;
    normals[vi * 3 + 1] = ny;
    normals[vi * 3 + 2] = nz;
    // Continuous longitude within the chunk (wraps handled by RepeatWrapping on the texture).
    const dirx = px / len;
    const diry = py / len;
    const dirz = pz / len;
    let lon = Math.atan2(diry, dirx);
    while (lon - centerLon > Math.PI) lon -= 2 * Math.PI;
    while (lon - centerLon < -Math.PI) lon += 2 * Math.PI;
    const lat = Math.asin(Math.max(-1, Math.min(1, dirz)));
    uvs[vi * 2] = 0.5 + lon / (2 * Math.PI);
    uvs[vi * 2 + 1] = 0.5 + lat / Math.PI;
    extras[vi * 2] = OCEAN[k]!;
    extras[vi * 2 + 1] = H[k]!;
  };

  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) write(j * n + i, (j + 1) * m + (i + 1), 0);

  const edgeLen = (R * (u1 - u0) * Math.PI) / 4;
  const skirt = Math.max(5, edgeLen * 0.03);
  const base = n * n;
  for (let k = 0; k < n; k++) {
    write(base + 0 * n + k, 1 * m + (k + 1), skirt); // bottom j=0
    write(base + 1 * n + k, (k + 1) * m + n, skirt); // right i=grid
    write(base + 2 * n + k, n * m + (k + 1), skirt); // top j=grid
    write(base + 3 * n + k, (k + 1) * m + 1, skirt); // left i=0
  }

  return {
    anchor: [ax, ay, az],
    positions,
    normals,
    uvs,
    fuvs,
    extras,
    minHeight: minH,
    maxHeight: maxH,
    radius,
    error,
  };
}
