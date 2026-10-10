import { describe, expect, it } from 'vitest';
import { faceToSphere, FACES } from '../../src/world/planet/cubeSphere';
import { buildChunk, buildIndices } from '../../src/world/planet/chunkBuild';
import { heightAt, type HeightConfig } from '../../src/world/planet/heights';

const cfg: HeightConfig = { key: 't', radius: 1.7374e6, seed: 9, procedural: 'cratered', amplitude: 1500 };

describe('cube sphere', () => {
  it('maps face points to unit vectors and face centers to face normals', () => {
    const out = new Float64Array(3);
    for (let f = 0; f < 6; f++) {
      faceToSphere(f, 0, 0, out);
      expect([...out]).toEqual(FACES[f]!.n.map((x) => x + 0));
      for (const [u, v] of [[-1, -1], [0.3, -0.7], [1, 1]] as const) {
        faceToSphere(f, u, v, out);
        expect(Math.hypot(out[0]!, out[1]!, out[2]!)).toBeCloseTo(1, 12);
      }
    }
  });
  it('adjacent faces share their edges exactly', () => {
    const a = new Float64Array(3);
    const b = new Float64Array(3);
    // +X face right edge (u=1) meets -Z face ... check via shared corner of +X and +Y: (1,1,1)/sqrt3 direction.
    faceToSphere(0, -1, 1, a); // +X: t=(0,0,-1), b=(0,1,0) -> corner (1, 1, 1)
    faceToSphere(2, 1, -1, b); // +Y: t=(1,0,0), b=(0,0,-1) -> corner (1, 1, 1)
    for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i]!, 14);
  });
});

describe('terrain determinism', () => {
  it('heights are identical across calls (seeded, no Math.random)', () => {
    const h1 = heightAt(cfg, 0.6, 0.48, 0.64);
    const h2 = heightAt({ ...cfg }, 0.6, 0.48, 0.64);
    expect(h1).toBe(h2);
    expect(heightAt({ ...cfg, seed: 10 }, 0.6, 0.48, 0.64)).not.toBe(h1);
  });
  it('chunk builds are bit-identical and neighbours agree on shared edges', () => {
    const grid = 8;
    const a = buildChunk(cfg, { face: 4, level: 3, ix: 2, iy: 5, grid });
    const a2 = buildChunk(cfg, { face: 4, level: 3, ix: 2, iy: 5, grid });
    expect(Array.from(a.positions)).toEqual(Array.from(a2.positions));
    const b = buildChunk(cfg, { face: 4, level: 3, ix: 3, iy: 5, grid });
    const n = grid + 1;
    // Right edge of a (i=grid) vs left edge of b (i=0), compared in absolute body-fixed coordinates.
    for (let j = 0; j < n; j++) {
      const ia = (j * n + grid) * 3;
      const ib = (j * n + 0) * 3;
      for (let k = 0; k < 3; k++) {
        const pa = a.positions[ia + k]! + a.anchor[k]!;
        const pb = b.positions[ib + k]! + b.anchor[k]!;
        expect(Math.abs(pa - pb)).toBeLessThan(0.05); // float32 storage relative to ~1e5 m anchors
      }
    }
    expect(a.error).toBeGreaterThan(0);
  });
  it('index buffer covers grid plus skirts', () => {
    const grid = 4;
    const idx = buildIndices(grid);
    expect(idx.length).toBe(grid * grid * 6 + grid * 4 * 6);
    expect(Math.max(...idx)).toBe((grid + 1) * (grid + 1) + 4 * (grid + 1) - 1);
  });
});
