/**
 * SolarSystem runtime: per-star glare, rotations refreshed on demand, and removeBody releasing what a visited star
 * owned. Runs in Node with the shipped ephemeris; bodies without texture assets build without a GPU.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { AU_M, PARSEC_M } from '../../src/core/constants';
import { Mat3d, Vec3d } from '../../src/core/vec3d';
import type { FrameRenderer } from '../../src/render/frameRenderer';
import type { BodyDef } from '../../src/world/catalog';
import { Ephemeris, type EphemerisFile } from '../../src/world/ephemeris';
import { ChunkWorkerPool } from '../../src/world/planet/workerPool';
import { bodyToIcrf } from '../../src/world/rotation';
import { SolarSystem, type BodyView } from '../../src/world/solarSystem';

const meta = JSON.parse(readFileSync('public/data/ephemeris.json', 'utf8')) as EphemerisFile;
const bin = readFileSync('public/data/ephemeris.bin');
const eph = new Ephemeris(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const bodies = (JSON.parse(readFileSync('public/data/bodies.json', 'utf8')) as { bodies: BodyDef[] }).bodies;
const sunDef = bodies.find((b) => b.id === '10')!;

/** A visited catalogue star 1.3 pc away with Proxima Centauri-like inferred values (as StarCatalog.bodyDef builds). */
const STAR_ID = '*7';
const STAR_POS = new Vec3d(-0.4723, -0.3615, -1.1512).scale(PARSEC_M);
function visitedStar(): BodyDef {
  const R = 4.9e7;
  return {
    id: STAR_ID,
    key: 'star-7',
    name: 'Test star',
    kind: 'star',
    parent: null,
    ephemerisId: STAR_ID,
    radiiM: [R, R, R],
    radiusM: R,
    gmM3S2: 1.327e20 * 0.16,
    rotation: { poleRa: [0], poleDec: [90], pm: [0, 0] },
    geometricAlbedo: 1,
    albedoScale: 1,
    surface: { type: 'star', teffK: 3100 },
    luminositySun: 0.0017,
    provenance: 'inferred',
    source: 'test',
    citation: 'hyg-v41',
  };
}

async function makeSystem(): Promise<{ sys: SolarSystem; pool: ChunkWorkerPool; frame: FrameRenderer; drawn: Set<unknown> }> {
  const pool = new ChunkWorkerPool(0); // no workers: jobs stay queued, which is what removeBody must cancel
  const drawn = new Set<unknown>();
  const frame = { add: (r: unknown) => drawn.add(r), remove: (r: unknown) => drawn.delete(r) } as unknown as FrameRenderer;
  const sys = await SolarSystem.create(eph, [sunDef], pool, frame);
  sys.externalAnchor = (a, t, out) => (a === STAR_ID ? eph.ssb('10', t, out).add(STAR_POS) : null);
  return { sys, pool, frame, drawn };
}

const T = 8.3e8;

describe('SolarSystem glare', () => {
  it('gives every star its own glare intensity, from its luminosity and distance', async () => {
    const { sys, pool, frame } = await makeSystem();
    const star = await sys.addBody(visitedStar(), pool, frame);
    const sun = sys.byId.get('10')!;

    // At the visited star's arrival distance (D-026: 1.6 sqrt(L) au): its glare is the true irradiance (~0.39), and
    // the Sun, 1.3 pc behind, keeps its own (~1e-11) instead of taking the local star's value.
    const d = 1.6 * Math.sqrt(0.0017) * AU_M;
    sys.update({ anchor: STAR_ID, offset: new Vec3d(d, 0, 0) }, T, 500);
    expect(star.glare!.intensity.value).toBeCloseTo((0.0017 * AU_M * AU_M) / (d * d), 12);
    expect(star.glare!.intensity.value).toBeCloseTo(1 / 1.6 ** 2, 9);
    const dSun = sun.rel.length();
    expect(sun.glare!.intensity.value).toBeCloseTo((AU_M / dSun) ** 2, 20);
    expect(sun.glare!.intensity.value).toBeLessThan(1e-10);

    // Back home at 1 au: the Sun's glare is 1, the far star's is negligible.
    sys.update({ anchor: '10', offset: new Vec3d(AU_M, 0, 0) }, T, 500);
    expect(sun.glare!.intensity.value).toBeCloseTo(1, 9);
    expect(star.glare!.intensity.value).toBeLessThan(1e-12);

    // Close to a star the value is capped.
    sys.update({ anchor: STAR_ID, offset: new Vec3d(2e8, 0, 0) }, T, 500);
    expect(star.glare!.intensity.value).toBe(50);
  });
});

describe('SolarSystem rotations', () => {
  it('updateRotations sets every body orientation for the given time (used before ship physics each frame)', async () => {
    const { sys, pool, frame } = await makeSystem();
    await sys.addBody(visitedStar(), pool, frame);
    const sun = sys.byId.get('10')!;
    sys.update({ anchor: '10', offset: new Vec3d(AU_M, 0, 0) }, T, 500);
    for (const t of [T + 1 / 60, T + 0.1, T + 3600]) {
      sys.updateRotations(t);
      expect(Array.from(sun.rotation.e)).toEqual(Array.from(bodyToIcrf(sunDef.rotation, t, new Mat3d()).e));
    }
    // update() at the same time leaves them unchanged.
    const before = Array.from(sun.rotation.e);
    sys.update({ anchor: '10', offset: new Vec3d(AU_M, 0, 0) }, T + 3600, 500);
    expect(Array.from(sun.rotation.e)).toEqual(before);
  });
});

describe('SolarSystem.removeBody', () => {
  it('releases the glare sprite, materials and queued chunk jobs of the removed body only', async () => {
    const { sys, pool, frame, drawn } = await makeSystem();
    const star = await sys.addBody(visitedStar(), pool, frame);
    sys.update({ anchor: STAR_ID, offset: new Vec3d(1e10, 0, 0) }, T, 500);

    const disposed: string[] = [];
    const watch = (v: BodyView, tag: string): void => {
      const materials = new Set<THREE.Material>();
      v.root.traverse((o) => {
        o.addEventListener('dispose', () => disposed.push(`${tag}:object:${o.name || o.type}`));
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        for (const x of Array.isArray(m) ? m : m ? [m] : []) materials.add(x);
      });
      for (const m of materials) m.addEventListener('dispose', () => disposed.push(`${tag}:material:${m.type}`));
    };
    watch(star, 'star');
    watch(sys.byId.get('10')!, 'sun');

    // Chunk jobs queued for both bodies (the pool has no workers, so they stay queued).
    const req = { face: 0, level: 1, ix: 0, iy: 0, grid: 32 };
    let starOutcome = 'queued';
    pool.build('star-7', req, 1).then(
      () => (starOutcome = 'built'),
      (e: unknown) => (starOutcome = e instanceof Error ? e.message : String(e)),
    );
    pool.build('sun', req, 1).catch(() => undefined);
    expect(pool.pending).toBe(2);

    sys.removeBody(STAR_ID, frame);

    expect(sys.byId.has(STAR_ID)).toBe(false);
    expect(sys.views.map((v) => v.def.id)).toEqual(['10']);
    expect(drawn.has(star.renderable)).toBe(false);
    // Queued work for the removed body is cancelled; the Sun's is untouched.
    expect(pool.pending).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(starOutcome).toBe('cancelled');
    // GPU-side objects: the glare sprite and its material, and the star's surface material.
    expect(disposed).toContain('star:object:glare');
    expect(disposed).toContain('star:material:SpriteNodeMaterial');
    expect(disposed).toContain('star:material:MeshBasicNodeMaterial');
    expect(disposed.filter((x) => x.startsWith('sun:'))).toEqual([]);
  });
});
