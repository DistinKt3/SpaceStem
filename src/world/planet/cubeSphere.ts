/**
 * Cube-sphere geometry. Six cube faces, each a quadtree; points on a face are mapped to the unit sphere with the
 * "spherified cube" mapping (more uniform cell sizes than plain normalization). Body-fixed axes: +z north pole,
 * +x at (lat 0, lon 0). Pure math, shared by the main thread and workers.
 */
export interface FaceBasis {
  n: [number, number, number];
  t: [number, number, number];
  b: [number, number, number];
}

export const FACES: readonly FaceBasis[] = [
  { n: [1, 0, 0], t: [0, 0, -1], b: [0, 1, 0] },
  { n: [-1, 0, 0], t: [0, 0, 1], b: [0, 1, 0] },
  { n: [0, 1, 0], t: [1, 0, 0], b: [0, 0, -1] },
  { n: [0, -1, 0], t: [1, 0, 0], b: [0, 0, 1] },
  { n: [0, 0, 1], t: [1, 0, 0], b: [0, 1, 0] },
  { n: [0, 0, -1], t: [-1, 0, 0], b: [0, 1, 0] },
];

/** Face coordinates (u, v in [-1, 1]) -> unit sphere direction, written into out[o..o+2]. */
export function faceToSphere(face: number, u: number, v: number, out: Float64Array | number[], o = 0): void {
  const f = FACES[face]!;
  const x = f.n[0] + u * f.t[0] + v * f.b[0];
  const y = f.n[1] + u * f.t[1] + v * f.b[1];
  const z = f.n[2] + u * f.t[2] + v * f.b[2];
  const x2 = x * x;
  const y2 = y * y;
  const z2 = z * z;
  out[o] = x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3);
  out[o + 1] = y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3);
  out[o + 2] = z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3);
}

/** Node bounds in face coordinates. */
export function nodeUvRange(level: number, ix: number, iy: number): [number, number, number, number] {
  const size = 2 / (1 << level);
  const u0 = -1 + ix * size;
  const v0 = -1 + iy * size;
  return [u0, v0, u0 + size, v0 + size];
}

export const nodeKey = (face: number, level: number, ix: number, iy: number): string => `${face}/${level}/${ix}/${iy}`;

/** Unit direction -> (lat, lon) radians in the body-fixed frame. */
export function dirToLatLon(x: number, y: number, z: number): [number, number] {
  return [Math.asin(Math.max(-1, Math.min(1, z))), Math.atan2(y, x)];
}
