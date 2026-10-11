/**
 * The Solar System at runtime: every body placed from the ephemeris and oriented by its IAU rotation model each
 * frame, rendered camera-relative (camera at the origin).
 *
 * Camera/ship positions are expressed relative to an anchor body's centre (`SystemPos`), so subtraction never mixes
 * barycentric magnitudes (1e12 m) with surface-scale offsets.
 */
import * as THREE from 'three/webgpu';
import { AU_M } from '../core/constants';
import { Mat3d, Vec3d } from '../core/vec3d';
import { dataUrl, loadHeights } from '../data/assets';
import type { DepthRenderable, FrameRenderer } from '../render/frameRenderer';
import {
  BodyUniforms,
  blackbodyColor,
  createRingMaterial,
  createSkyMaterial,
  createStarMaterial,
  createSurfaceMaterial,
  equirectAlbedo,
  makeAtmosphere,
  tileAlbedo,
  type AtmosphereNodes,
  type CloudSpec,
} from '../render/materials/planetShading';
import { TileSet } from '../render/tiles';
import type { BodyDef } from './catalog';
import type { Ephemeris } from './ephemeris';
import type { HeightConfig } from './planet/heights';
import { PlanetTerrain } from './planet/planetTerrain';
import type { ChunkWorkerPool } from './planet/workerPool';
import { bodyToIcrf } from './rotation';
import { hashString } from '../core/rng';

/** A position in the Solar System: anchor body's centre + offset (ICRF axes, metres). */
export interface SystemPos {
  anchor: string;
  offset: Vec3d;
}

export interface BodyView {
  readonly def: BodyDef;
  readonly root: THREE.Group;
  readonly fixed: THREE.Group;
  readonly terrain: PlanetTerrain;
  readonly uniforms: BodyUniforms;
  readonly renderable: DepthRenderable;
  readonly tiles?: TileSet;
  /** Body centre relative to the camera, metres (ICRF). Updated every frame. */
  readonly rel: Vec3d;
  /** Body-fixed -> ICRF rotation. Updated every frame. */
  readonly rotation: Mat3d;
  /** Sphere of influence radius used for anchor selection, metres. */
  soi: number;
  /** Max relief + atmosphere above the mean radius, metres. */
  envelope: number;
  angularRadiusPx: number;
}

const loader = new THREE.TextureLoader();
function loadTexture(name: string, ext = 'webp', srgb = true): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(
      dataUrl(`tex/${name}.${ext}`),
      (t) => {
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.anisotropy = 8;
        resolve(t);
      },
      undefined,
      () => reject(new Error(`texture ${name}`)),
    );
  });
}

export class SolarSystem {
  readonly views: BodyView[] = [];
  readonly byId = new Map<string, BodyView>();
  private readonly tmp = new Vec3d();
  private readonly mat3 = new THREE.Matrix3();
  private readonly mat4 = new THREE.Matrix4();

  private constructor(
    readonly ephemeris: Ephemeris,
    readonly bodies: BodyDef[],
  ) {}

  static async create(
    ephemeris: Ephemeris,
    bodies: BodyDef[],
    pool: ChunkWorkerPool,
    frame: FrameRenderer,
    onProgress?: (msg: string) => void,
  ): Promise<SolarSystem> {
    const sys = new SolarSystem(ephemeris, bodies);
    for (const def of bodies) {
      onProgress?.(def.name);
      const view = await sys.buildBody(def, pool);
      frame.add(view.renderable);
      sys.views.push(view);
      sys.byId.set(def.id, view);
    }
    // Spheres of influence (Laplace): r = a (m / M)^(2/5); never smaller than 3 radii.
    const t = 0;
    for (const v of sys.views) {
      const parent = v.def.parent ? sys.byId.get(v.def.parent) : undefined;
      if (!parent) {
        v.soi = Infinity;
        continue;
      }
      const a = ephemeris.between(v.def.ephemerisId, parent.def.ephemerisId, t, new Vec3d()).length();
      v.soi = Math.max(3 * v.def.radiusM, a * Math.pow(v.def.gmM3S2 / parent.def.gmM3S2, 0.4));
    }
    return sys;
  }

  private async buildBody(def: BodyDef, pool: ChunkWorkerPool): Promise<BodyView> {
    const uniforms = new BodyUniforms();
    const root = new THREE.Group();
    root.name = def.key;
    const fixed = new THREE.Group();
    root.add(fixed);
    const R = def.radiusM;
    const s = def.surface;

    let atmosphere: AtmosphereNodes | undefined;
    if (def.atmosphere) atmosphere = makeAtmosphere(def.atmosphere, R, uniforms);

    let clouds: CloudSpec | undefined;
    if (s.clouds) {
      const tex = await loadTexture(s.clouds, 'webp', false);
      tex.wrapS = THREE.RepeatWrapping;
      clouds = { texture: tex, altitudeM: 6000, widthTexels: tex.image ? (tex.image as { width: number }).width : 4096 };
    }
    const night = s.night ? await loadTexture(s.night) : undefined;

    // Height configuration (Measured data where available, Generated detail below its resolution).
    const cfg: HeightConfig = {
      key: def.key,
      radius: R,
      seed: hashString(def.key),
      procedural: s.type === 'terrain' ? (s.terrain ?? 'none') : 'none',
      amplitude: s.amplitude ?? 0,
      ...(s.seaLevel !== undefined ? { seaLevel: s.seaLevel } : {}),
      ...(s.heights ? { craterMinLevel: 10 } : {}),
    };
    if (s.heights) cfg.heightmap = await loadHeights(s.heights);

    const brdf = s.type === 'gas' ? 'gas' : (s.brdf ?? 'lambert');
    let material: THREE.Material;
    let tiles: TileSet | undefined;
    const surfaceOpts = {
      radiusM: R,
      uniforms,
      brdf,
      ...(atmosphere ? { atmosphere } : {}),
      ...(clouds ? { clouds } : {}),
      ...(night ? { night } : {}),
      ocean: s.seaLevel !== undefined,
      albedoScale: def.albedoScale,
      ...(s.type === 'terrain' && new URLSearchParams(location.search).get('detail') !== '0' ? { detailFaceEdgeM: (R * Math.PI) / 2 } : {}),
    } as const;
    if (s.type === 'star') {
      material = createStarMaterial(blackbodyColor(s.teffK ?? 5772), 60);
    } else if (s.tiles) {
      const maxLevel = s.tiles === 'earth' ? 3 : 2;
      tiles = new TileSet(s.tiles, maxLevel, (tex, L, x, y) => createSurfaceMaterial({ ...surfaceOpts, albedo: tileAlbedo(tex, L, x, y) }));
      await tiles.init();
      material = createSurfaceMaterial({ ...surfaceOpts, albedo: equirectAlbedo(await loadTexture(s.texture ?? def.key)) });
    } else {
      const tex = await loadTexture(s.texture ?? def.key);
      material = createSurfaceMaterial({ ...surfaceOpts, albedo: equirectAlbedo(tex) });
    }

    const maxRelief = cfg.heightmap ? 11_000 : Math.max(500, (s.amplitude ?? 0) * 1.5 + (s.terrain === 'cratered' ? 4000 : 0));
    const tileSet = tiles;
    const terrain = new PlanetTerrain(pool, {
      config: cfg,
      material,
      maxRelief,
      maxLevel: Math.max(6, Math.ceil(Math.log2(R / 2))) > 19 ? 19 : Math.max(6, Math.ceil(Math.log2(R / 2))),
      ...(tileSet ? { materialFor: (f: number, l: number, x: number, y: number) => tileSet.materialFor(f, l, x, y) } : {}),
    });
    fixed.add(terrain.group);

    let envelope = maxRelief;
    if (atmosphere) {
      const sky = new THREE.Mesh(new THREE.SphereGeometry(atmosphere.Rt * 1000, 96, 48), createSkyMaterial(R, atmosphere, uniforms, clouds));
      sky.renderOrder = 10;
      sky.frustumCulled = false;
      root.add(sky);
      envelope = Math.max(envelope, (def.atmosphere?.heightM ?? 0) * 1.01);
    }
    if (def.rings) {
      const rtex = await loadTexture(def.rings.texture, 'png');
      rtex.wrapS = THREE.ClampToEdgeWrapping;
      const ring = new THREE.Mesh(new THREE.RingGeometry(def.rings.innerM, def.rings.outerM, 256, 1), createRingMaterial(rtex, def.rings.innerM, def.rings.outerM, R, uniforms));
      ring.renderOrder = 5;
      fixed.add(ring); // ring plane = body equator (body-fixed xy plane)
      envelope = Math.max(envelope, def.rings.outerM - R);
    }
    if (s.type === 'star') {
      const glare = new THREE.Sprite(createGlareMaterial(blackbodyColor(s.teffK ?? 5772)));
      glare.name = 'glare';
      glare.renderOrder = 20;
      root.add(glare);
      envelope = R * 0.1;
    }

    const view: BodyView = {
      def,
      root,
      fixed,
      terrain,
      uniforms,
      ...(tiles ? { tiles } : {}),
      rel: new Vec3d(),
      rotation: new Mat3d(),
      soi: Infinity,
      envelope,
      angularRadiusPx: 0,
      renderable: {
        object: root,
        radius: R + envelope,
        nearBound: (d) => d - R - envelope,
        farBound: (d) => {
          const top = R + envelope;
          if (d <= top) return Math.sqrt(Math.max(0, top * top - R * R)) * 2 + 1;
          return Math.sqrt(Math.max(d * d - R * R, 0)) + Math.sqrt(top * top - R * R) + 1;
        },
      },
    };
    return view;
  }

  /** Absolute (SSB) position of a SystemPos. */
  toSsb(p: SystemPos, t: number, out: Vec3d): Vec3d {
    return this.ephemeris.ssb(this.byId.get(p.anchor)!.def.ephemerisId, t, out).add(p.offset);
  }

  /** Vector from `from` to body `id`'s centre, metres, computed via the common ancestor (precise). */
  bodyRelative(id: string, from: SystemPos, t: number, out: Vec3d): Vec3d {
    const target = this.byId.get(id)!.def.ephemerisId;
    const anchor = this.byId.get(from.anchor)!.def.ephemerisId;
    return this.ephemeris.between(target, anchor, t, out).sub(from.offset);
  }

  /** Re-express a position relative to a different anchor body without losing precision near it. */
  reanchor(p: SystemPos, anchor: string, t: number): SystemPos {
    if (p.anchor === anchor) return p;
    const off = this.ephemeris
      .between(this.byId.get(p.anchor)!.def.ephemerisId, this.byId.get(anchor)!.def.ephemerisId, t, new Vec3d())
      .add(p.offset);
    return { anchor, offset: off };
  }

  /** The most specific body whose sphere of influence contains the position. */
  dominantBody(p: SystemPos, t: number): string {
    let best = this.views.find((v) => v.def.kind === 'star')!.def.id;
    let bestSoi = Infinity;
    for (const v of this.views) {
      if (v.def.kind === 'star') continue;
      const d = this.bodyRelative(v.def.id, p, t, this.tmp).length();
      if (d < v.soi && v.soi < bestSoi) {
        best = v.def.id;
        bestSoi = v.soi;
      }
    }
    return best;
  }

  /** Nearest body surface to a position: [view, altitude above mean radius (m)]. */
  nearest(p: SystemPos, t: number): [BodyView, number] {
    let best = this.views[0]!;
    let bestAlt = Infinity;
    for (const v of this.views) {
      const alt = this.bodyRelative(v.def.id, p, t, this.tmp).length() - v.def.radiusM;
      if (alt < bestAlt) {
        bestAlt = alt;
        best = v;
      }
    }
    return [best, bestAlt];
  }

  /** Terrain height (m above mean radius) under a camera-relative direction for a body, using the CPU height fn. */
  surfaceHeightBelow(view: BodyView, p: SystemPos, t: number): number {
    const rel = this.bodyRelative(view.def.id, p, t, new Vec3d()).scale(-1); // position relative to body centre
    const bf = rel.applyMat3Transpose(view.rotation).normalize();
    return view.terrain.heightAtDir(bf.x, bf.y, bf.z);
  }

  /**
   * Per-frame update: camera-relative placement, orientation, lighting uniforms, terrain LOD and tile streaming.
   * `cam` is the camera position; pxPerRadian = viewport height / vertical FOV.
   */
  update(cam: SystemPos, t: number, pxPerRadian: number): void {
    const sunId = this.views.find((v) => v.def.kind === 'star')!.def.id;
    const sunRel = this.bodyRelative(sunId, cam, t, new Vec3d());
    for (const v of this.views) {
      this.bodyRelative(v.def.id, cam, t, v.rel);
      bodyToIcrf(v.def.rotation, t, v.rotation);
      const d = v.rel.length();
      v.angularRadiusPx = (Math.asin(Math.min(1, v.def.radiusM / Math.max(d, v.def.radiusM))) * pxPerRadian);
      v.root.position.set(v.rel.x, v.rel.y, v.rel.z);
      // Body-fixed frame orientation.
      const e = v.rotation.e;
      this.mat4.set(e[0]!, e[1]!, e[2]!, 0, e[3]!, e[4]!, e[5]!, 0, e[6]!, e[7]!, e[8]!, 0, 0, 0, 0, 1);
      v.fixed.quaternion.setFromRotationMatrix(this.mat4);
      // Lighting.
      const u = v.uniforms;
      u.centerKm.value.set(v.rel.x / 1000, v.rel.y / 1000, v.rel.z / 1000);
      const toSun = new Vec3d().subVectors(sunRel, v.rel);
      const rSun = toSun.length();
      toSun.scale(1 / Math.max(rSun, 1));
      u.sunDir.value.set(toSun.x, toSun.y, toSun.z);
      u.sunIrradiance.value = Math.PI * (AU_M / Math.max(rSun, 1e9)) ** 2;
      this.mat3.set(e[0]!, e[3]!, e[6]!, e[1]!, e[4]!, e[7]!, e[2]!, e[5]!, e[8]!); // transpose: world -> body
      u.worldToBody.value.copy(this.mat3);
      u.radPerPixel.value = 1 / pxPerRadian;
      // Tiny bodies are skipped entirely (they become sky points in the star renderer).
      const visible = v.angularRadiusPx > 0.6 || v.def.kind === 'star';
      v.root.visible = visible;
      if (visible) {
        const camBf = v.rel.clone().scale(-1).applyMat3Transpose(v.rotation);
        v.tiles?.beginFrame();
        v.terrain.update(camBf, pxPerRadian);
        v.tiles?.endFrame();
      }
      if (v.def.kind === 'star') {
        const glare = v.root.getObjectByName('glare');
        if (glare) {
          // Lens glare: fixed ~14 degree sprite (never smaller than 3x the disc), brightness from irradiance.
          const ang = Math.max(0.12, (3 * v.def.radiusM) / Math.max(d, 1));
          glare.scale.setScalar(Math.max(d, 1) * ang * 2);
          const irr = (AU_M / Math.max(d, 1)) ** 2;
          (glare as THREE.Sprite).userData['intensity'] = irr;
          glareIntensity.value = Math.min(irr, 50);
        }
      }
    }
  }
}

import { Fn, uv, vec4, float, length, exp, max, smoothstep, uniform, vec3 as tvec3 } from 'three/tsl';

const glareIntensity = uniform(1);

/** Additive glare sprite around a star (an artistic lens effect, not physical light). */
function createGlareMaterial(color: THREE.Color): THREE.SpriteNodeMaterial {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  m.depthTest = true;
  const c = tvec3(color.r, color.g, color.b);
  m.colorNode = Fn(() => {
    const r = length(uv().sub(0.5)).mul(2);
    const core = exp(r.mul(r).mul(-180)).mul(6);
    const halo = exp(r.mul(-9)).mul(0.35).add(max(float(0), float(1).sub(r)).mul(0.04));
    const k = core.add(halo).mul(smoothstep(1, 0.85, r)).mul(glareIntensity);
    return vec4(c.mul(k), k);
  })();
  return m;
}
