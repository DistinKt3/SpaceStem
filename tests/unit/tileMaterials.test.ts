/**
 * Imagery tiles must not compile a surface shader per tile (review finding perf-4). TileSet is driven exactly as
 * SolarSystem.buildBody drives it (makeMaterial = createSurfaceMaterial with tileAlbedo); the shaders are built with
 * three's real WGSL node builder, and each tile's draw is checked to bind that tile's texture and face transform.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { readFileSync } from 'node:fs';
import {
  BodyUniforms,
  createSurfaceMaterial,
  makeAtmosphere,
  tileAlbedo,
  type AtmosphereSpec,
} from '../../src/render/materials/planetShading';
import { TileSet } from '../../src/render/tiles';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- three's node builder internals are untyped */

const earth = (
  JSON.parse(readFileSync('public/data/bodies.json', 'utf8')) as {
    bodies: { key: string; radiusM: number; atmosphere: AtmosphereSpec }[];
  }
).bodies.find((b) => b.key === 'earth')!;

/** A WebGPURenderer that is never initialised: enough for three's WGSL node builder. */
function stubRenderer(): any {
  const canvas = { addEventListener: () => undefined, style: {}, getContext: () => null, width: 1, height: 1 };
  const r: any = new THREE.WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement });
  r.hasFeature = () => false;
  return r;
}

function chunkGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, size] of [
    ['position', 3],
    ['normal', 3],
    ['uv', 2],
    ['fuv', 2],
    ['extras', 2],
  ] as const) {
    g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(9 * size), size));
  }
  return g;
}

/** Earth's surface options as SolarSystem.buildBody passes them (atmosphere, clouds, night lights, ocean, detail). */
function earthSurface(): (tex: THREE.Texture, level: number, x: number, y: number) => THREE.Material {
  const uniforms = new BodyUniforms();
  const atmosphere = makeAtmosphere(earth.atmosphere, earth.radiusM, uniforms);
  const night = new THREE.Texture();
  const opts = {
    radiusM: earth.radiusM,
    uniforms,
    brdf: 'lambert' as const,
    atmosphere,
    clouds: { texture: new THREE.Texture(), altitudeM: 6000, widthTexels: 8192, channel: 'r' as const },
    night,
    ocean: true,
    albedoScale: 1,
    detailFaceEdgeM: (earth.radiusM * Math.PI) / 2,
  };
  return (tex, level, x, y) => createSurfaceMaterial({ ...opts, albedo: tileAlbedo(tex, level, x, y) });
}

const tileTex = new Map<THREE.Texture, string>();
beforeAll(() => {
  // Tiles "load" synchronously; each gets a distinct texture named after its path (level/face/x_y).
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation((url, onLoad) => {
    const t = new THREE.Texture<HTMLImageElement>();
    tileTex.set(t, /tiles\/\w+\/(.*)\.webp$/.exec(url)![1]!);
    onLoad?.(t);
    return t;
  });
});
afterAll(() => vi.restoreAllMocks());

/** Request tile (level, face, x, y) through materialFor until it is the one returned. */
function tileMaterial(set: TileSet, level: number, face: number, x: number, y: number): THREE.Material {
  for (let i = 0; i < 3; i++) {
    set.beginFrame();
    const m = set.materialFor(face, level + 1, 2 * x, 2 * y); // a chunk one level finer wants exactly this tile
    set.endFrame();
    if (i > 0) return m;
  }
  throw new Error('unreachable');
}

interface Built {
  fragment: string;
  /** Runs the per-draw node updates three runs for `material`, then returns the textures and vec3 uniforms bound. */
  drawWith(material: THREE.Material): { textures: THREE.Texture[]; vec3s: THREE.Vector3[] };
}

function build(r: any, material: THREE.Material): Built {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const mesh = new THREE.Mesh(chunkGeometry(), material);
  scene.add(mesh);
  const b = r.backend.createNodeBuilder(mesh, r);
  b.scene = scene;
  b.camera = camera;
  b.build();
  const groups: any[] = b.getBindings();
  return {
    fragment: b.fragmentShader,
    drawWith(m) {
      const frame = { renderer: r, scene, object: mesh, camera, material: m };
      for (const node of b.updateNodes) if (node.updateType === 'object') node.update(frame);
      const bindings: any[] = groups.flatMap((g) => g.bindings);
      return {
        textures: bindings.filter((x) => x.isSampledTexture).map((x) => x.textureNode.value),
        vec3s: bindings
          .flatMap((x) => (x.isUniformsGroup ? x.uniforms.map((u: any) => u.getValue()) : []))
          .filter((v: unknown) => v instanceof THREE.Vector3),
      };
    },
  };
}

describe('imagery tile materials', () => {
  const surface = earthSurface();
  let makeCalls = 0; // makeMaterial calls (vi.fn call history is cleared between hooks and tests)
  const makeMaterial = (tex: THREE.Texture, level: number, x: number, y: number): THREE.Material => {
    makeCalls++;
    return surface(tex, level, x, y);
  };
  const set = new TileSet('earth', 3, makeMaterial);
  const tiles: [number, number, number, number][] = [
    [0, 0, 0, 0],
    [0, 4, 0, 0],
    [1, 0, 1, 0],
    [1, 2, 0, 1],
    [2, 0, 3, 2],
    [3, 5, 5, 7],
  ];
  const mats = new Map<THREE.Material, [number, number, number, number]>();

  beforeAll(async () => {
    await set.init();
    for (const t of tiles) mats.set(tileMaterial(set, ...t), t);
  });

  it('builds the surface material once per body, not once per tile', () => {
    expect(mats.size).toBe(tiles.length);
    expect(makeCalls).toBe(1);
    // Same program cache key: three reuses one node build (NodeBuilderState) and one pipeline for every tile.
    const keys = new Set([...mats.keys()].map((m) => m.customProgramCacheKey()));
    expect(keys.size).toBe(1);
  });

  it('compiles one fragment program for every tile', () => {
    const r = stubRenderer();
    // three emits shared TSL helpers (mx_noise) in a different order on the first build in a process; warm it up.
    build(r, surface(new THREE.Texture(), 0, 0, 0));
    const programs = new Set([...mats.keys()].map((m) => build(r, m).fragment));
    expect(programs.size).toBe(1);
  });

  it("binds each tile's own texture and face transform per draw", () => {
    const r = stubRenderer();
    const shader = build(r, [...mats.keys()][3]!);
    for (const [m, [level, face, x, y]] of mats) {
      const { textures, vec3s } = shader.drawWith(m);
      const bound = textures.map((t) => tileTex.get(t)).filter((n) => n !== undefined);
      expect(bound).toEqual([`${level}/${face}/${x}_${y}`]);
      expect(vec3s.some((v) => v.equals(new THREE.Vector3(1 << level, x, y)))).toBe(true);
    }
  });

  it('evicting tiles disposes their textures and materials, not the shared one', () => {
    const small = new TileSet('earth', 3, makeMaterial, 8);
    makeCalls = 0;
    return small.init().then(() => {
      const disposed: string[] = [];
      const first = tileMaterial(small, 1, 0, 0, 0);
      const firstTex = [...tileTex].filter(([, name]) => name === '1/0/0_0').at(-1)![0];
      first.addEventListener('dispose', () => disposed.push('material'));
      firstTex.addEventListener('dispose', () => disposed.push('texture'));
      // Use other tiles for a while: the first one ages out of the 8-tile budget.
      for (let i = 0; i < 4; i++) tileMaterial(small, 1, 1 + i, 1, 1);
      expect(disposed.sort()).toEqual(['material', 'texture']);
      const again = tileMaterial(small, 1, 0, 0, 0);
      expect(again).not.toBe(first);
      expect(again.customProgramCacheKey()).toBe(first.customProgramCacheKey());
      expect(makeCalls).toBe(1);
    });
  });
});
