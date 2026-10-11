/**
 * Static asset loading. Everything comes from same-origin files under public/data (built offline by tools/pipeline);
 * the game never calls external data APIs at runtime.
 */
import type { HeightmapData } from '../world/planet/heights';

export const dataUrl = (path: string): string => `${import.meta.env.BASE_URL}data/${path}`;

export async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(dataUrl(path));
  if (!r.ok) throw new Error(`fetch ${path}: ${r.status}`);
  return (await r.json()) as T;
}

export async function fetchBytes(path: string): Promise<ArrayBuffer> {
  const r = await fetch(dataUrl(path));
  if (!r.ok) throw new Error(`fetch ${path}: ${r.status}`);
  return r.arrayBuffer();
}

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

interface HeightsMeta {
  width: number;
  height: number;
  quantumM: number;
  encoding: string;
}

/** Decode an elevation grid written by tools/pipeline/textures.py (gradient-predicted int16, gzip). */
export function decodeGradientHeights(residuals: Int16Array, width: number, height: number, quantum: number): Int16Array {
  const out = new Int16Array(width * height);
  const prev = new Int32Array(width);
  const row = new Int32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = residuals[y * width + x]!;
      let v: number;
      if (y === 0) v = x === 0 ? r : r + row[x - 1]!;
      else if (x === 0) v = r + prev[0]!;
      else v = r + row[x - 1]! + prev[x]! - prev[x - 1]!;
      row[x] = v;
      out[y * width + x] = v * quantum;
    }
    prev.set(row);
  }
  return out;
}

export async function loadHeights(name: string): Promise<HeightmapData> {
  const meta = await fetchJson<HeightsMeta>(`heights/${name}.json`);
  const raw = await gunzip(await fetchBytes(`heights/${name}.i16z`));
  const data = decodeGradientHeights(new Int16Array(raw), meta.width, meta.height, meta.quantumM);
  return { width: meta.width, height: meta.height, data };
}
