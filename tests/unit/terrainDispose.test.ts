/**
 * Terrain chunk disposal must release the renderer's per-draw state. three's RenderObjects keeps one RenderObject per
 * (mesh, material) pair drawn, holding the mesh, its geometry and typed arrays, a uniform buffer and bind groups, until
 * the mesh or the material fires 'dispose'. Disposing only the geometry leaves them all behind (review finding perf-1).
 * This drives the real PlanetTerrain through eviction cycles and counts RenderObjects in three's own RenderObjects.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
// @ts-expect-error -- three's internal renderer module ships without type declarations
import RenderObjectsImpl from 'three/src/renderers/common/RenderObjects.js';
import { Vec3d } from '../../src/core/vec3d';
import { buildChunk, type ChunkData, type ChunkRequest } from '../../src/world/planet/chunkBuild';
import type { HeightConfig } from '../../src/world/planet/heights';
import { PlanetTerrain } from '../../src/world/planet/planetTerrain';
import type { ChunkWorkerPool } from '../../src/world/planet/workerPool';

interface RenderObjectsLike {
  get(
    object: THREE.Object3D,
    material: THREE.Material,
    scene: THREE.Scene,
    camera: THREE.Camera,
    lightsNode: object,
    renderContext: object,
    clippingContext: null,
  ): unknown;
  readonly _renderObjects: Set<unknown>;
}
type RenderObjectsCtor = new (
  renderer: object,
  nodes: object,
  geometries: object,
  pipelines: object,
  bindings: object,
  info: object,
) => RenderObjectsLike;
const RenderObjects = RenderObjectsImpl as RenderObjectsCtor;

/** The minimum of the renderer that RenderObjects and RenderObject touch when creating and disposing entries. */
function makeRenderObjects(): RenderObjectsLike {
  const renderer = { _currentSourceMaterial: null, contextNode: { id: 0, version: 0 } };
  const nodes = { getCacheKey: () => 0, delete: () => undefined };
  const pipelines = { delete: () => undefined };
  const bindings = { deleteForRender: () => undefined };
  return new RenderObjects(renderer, nodes, {}, pipelines, bindings, {});
}

/** Builds chunks on the calling thread (the real pool runs the same buildChunk in workers). */
class InlinePool {
  pending = 0;
  constructor(private readonly config: HeightConfig) {}
  register(): void {}
  build(_key: string, req: ChunkRequest): Promise<ChunkData> {
    return Promise.resolve(buildChunk(this.config, req));
  }
  clearQueue(): void {}
  unregister(): void {}
}

const cfg: HeightConfig = { key: 'dispose-test', radius: 1.7374e6, seed: 9, procedural: 'volcanic', amplitude: 1500 };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Low fast flight along the equator: every frame updates LOD, "draws" the visible chunks and lets builds land. */
async function fly(
  terrain: PlanetTerrain,
  ro: RenderObjectsLike,
  frames: number,
  materialAt?: (frame: number) => THREE.Material,
): Promise<number> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const lights = {};
  const ctx = { id: 1 };
  const cam = new Vec3d();
  const r = cfg.radius + 2000;
  let evicted = 0;
  terrain.group.addEventListener('childremoved', () => evicted++);
  for (let f = 0; f < frames; f++) {
    const a = f * 0.004; // ~7 km per frame
    cam.set(r * Math.cos(a), r * Math.sin(a), 0);
    terrain.update(cam, 430);
    for (const child of terrain.group.children) {
      if (!(child instanceof THREE.Mesh) || !child.visible) continue;
      if (materialAt) child.material = materialAt(f);
      ro.get(child, child.material as THREE.Material, scene, camera, lights, ctx, null);
    }
    await flush();
  }
  return evicted;
}

describe('terrain chunk disposal', () => {
  const opts = { config: cfg, grid: 8, maxRelief: 4000, maxChunks: 60 };

  it('evicted chunks release their RenderObjects (memory stays flat over eviction cycles)', async () => {
    const ro = makeRenderObjects();
    const terrain = new PlanetTerrain(new InlinePool(cfg) as unknown as ChunkWorkerPool, {
      ...opts,
      material: new THREE.MeshBasicNodeMaterial(),
    });
    const evicted = await fly(terrain, ro, 80);
    expect(evicted).toBeGreaterThan(300); // several full turnovers of the 60-chunk cache
    // At most one RenderObject per live chunk mesh; before the fix every chunk ever drawn kept one.
    const meshes = terrain.group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    expect(ro._renderObjects.size).toBeLessThanOrEqual(meshes.length);
    // Live chunks still share the one index buffer (disposal detaches it, never frees it).
    const index = meshes[0]!.geometry.index;
    expect(index).not.toBeNull();
    for (const m of meshes) expect(m.geometry.index).toBe(index);
    // Removing the body (SolarSystem.removeBody -> dispose) frees everything.
    terrain.dispose();
    expect(ro._renderObjects.size).toBe(0);
  }, 30_000);

  it('chunks that switched materials (imagery tiles) release every RenderObject they own', async () => {
    const ro = makeRenderObjects();
    const a = new THREE.MeshBasicNodeMaterial();
    const b = new THREE.MeshBasicNodeMaterial();
    const terrain = new PlanetTerrain(new InlinePool(cfg) as unknown as ChunkWorkerPool, { ...opts, material: a });
    await fly(terrain, ro, 80, (f) => ((f >> 2) & 1 ? b : a));
    expect(ro._renderObjects.size).toBeLessThanOrEqual(2 * terrain.group.children.length);
    terrain.dispose();
    expect(ro._renderObjects.size).toBe(0);
  }, 30_000);
});
