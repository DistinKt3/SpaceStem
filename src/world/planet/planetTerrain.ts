/**
 * Cube-sphere quadtree terrain with screen-space-error LOD. Chunk geometry is built in workers; the main thread only
 * selects nodes and swaps meshes. `group` is the body-fixed frame: the owner sets its quaternion (body orientation)
 * and its camera-relative position each frame. Chunk meshes sit at their float64 anchors inside it, so three.js's
 * float64 matrix composition keeps the GPU-side translation small (camera-relative precision).
 */
import * as THREE from 'three/webgpu';
import { Vec3d } from '../../core/vec3d';
import { buildChunk, buildIndices, type ChunkData } from './chunkBuild';
import { faceToSphere, nodeKey, nodeUvRange } from './cubeSphere';
import { heightAt, type HeightConfig } from './heights';
import type { ChunkWorkerPool } from './workerPool';

export interface TerrainOptions {
  config: HeightConfig;
  material: THREE.Material;
  grid?: number;
  maxLevel?: number;
  /** Max on-screen geometric error, pixels. Higher = coarser (quality scaling knob). */
  errorPx?: number;
  /** Max relief above/below the sphere, meters (for culling bounds). */
  maxRelief?: number;
  maxChunks?: number;
  /** Optional per-chunk material (e.g. the best loaded imagery tile); called for visible chunks every update. */
  materialFor?: (face: number, level: number, ix: number, iy: number) => THREE.Material;
}

interface Chunk {
  key: string;
  face: number;
  level: number;
  ix: number;
  iy: number;
  state: 'loading' | 'ready' | 'failed';
  mesh?: THREE.Mesh;
  data?: ChunkData;
  lastUsed: number;
}

const tmp = new Float64Array(3);

export class PlanetTerrain {
  static MAX_PENDING = 24;
  readonly group = new THREE.Group();
  readonly config: HeightConfig;
  errorPx: number;
  readonly grid: number;
  readonly maxLevel: number;
  readonly maxRelief: number;
  private readonly material: THREE.Material;
  private readonly index: THREE.BufferAttribute;
  private readonly chunks = new Map<string, Chunk>();
  private readonly maxChunks: number;
  private readonly materialFor: TerrainOptions['materialFor'];
  private frame = 0;
  private visible: Chunk[] = [];
  readonly stats = { visibleChunks: 0, cachedChunks: 0, maxLevelVisible: 0, triangles: 0 };

  constructor(
    private readonly pool: ChunkWorkerPool,
    opts: TerrainOptions,
  ) {
    this.config = opts.config;
    this.material = opts.material;
    this.grid = opts.grid ?? 32;
    this.maxLevel = opts.maxLevel ?? 18;
    this.errorPx = opts.errorPx ?? 2;
    this.maxRelief = opts.maxRelief ?? 10_000;
    this.maxChunks = opts.maxChunks ?? 1200;
    this.materialFor = opts.materialFor;
    this.index = new THREE.BufferAttribute(buildIndices(this.grid), 1);
    this.group.name = `terrain:${this.config.key}`;
    pool.register(this.config);
    // Root level is built synchronously so the planet is never missing.
    for (let f = 0; f < 6; f++) {
      const c: Chunk = { key: nodeKey(f, 0, 0, 0), face: f, level: 0, ix: 0, iy: 0, state: 'loading', lastUsed: 0 };
      this.chunks.set(c.key, c);
      this.onBuilt(c, buildChunk(this.config, { face: f, level: 0, ix: 0, iy: 0, grid: this.grid }));
    }
  }

  get radius(): number {
    return this.config.radius;
  }

  /** Terrain height (m) at a body-fixed unit direction. */
  heightAtDir(x: number, y: number, z: number): number {
    return heightAt(this.config, x, y, z);
  }

  private onBuilt(c: Chunk, data: ChunkData): void {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    g.setAttribute('fuv', new THREE.BufferAttribute(data.fuvs, 2));
    g.setAttribute('extras', new THREE.BufferAttribute(data.extras, 2));
    g.setIndex(this.index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), data.radius);
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(data.anchor[0], data.anchor[1], data.anchor[2]);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    mesh.name = c.key;
    this.group.add(mesh);
    c.mesh = mesh;
    c.data = data;
    c.state = 'ready';
  }

  private request(face: number, level: number, ix: number, iy: number, priority: number): Chunk | undefined {
    const key = nodeKey(face, level, ix, iy);
    let c = this.chunks.get(key);
    if (!c) {
      if (this.pool.pending >= PlanetTerrain.MAX_PENDING) return undefined;
      c = { key, face, level, ix, iy, state: 'loading', lastUsed: this.frame };
      this.chunks.set(key, c);
      const chunk = c;
      this.pool
        .build(this.config.key, { face, level, ix, iy, grid: this.grid }, priority)
        .then((d) => {
          if (this.chunks.get(key) === chunk) this.onBuilt(chunk, d);
        })
        .catch(() => {
          if (this.chunks.get(key) === chunk) this.chunks.delete(key);
        });
    }
    c.lastUsed = this.frame;
    return c;
  }

  /**
   * Select and show chunks for a camera at `cam` (body-fixed meters). pxPerRadian = viewport height / vertical FOV.
   * Refinement is coarse-to-fine: a node is split only when it and all four children are built, so requests advance
   * one level at a time near the camera and nothing is requested that cannot be shown soon.
   */
  update(cam: Readonly<Vec3d>, pxPerRadian: number): void {
    this.frame++;
    for (const c of this.visible) if (c.mesh) c.mesh.visible = false;
    const out: Chunk[] = [];
    const R = this.config.radius;
    const d = cam.length();
    const camDir = new Vec3d().copy(cam).scale(1 / Math.max(d, 1));
    const relief = this.maxRelief;
    const horizon = d > R + relief ? Math.acos(R / d) + Math.acos(R / (R + relief)) : Math.PI;

    interface NodeEval {
      culled: boolean;
      dist: number;
      wantSplit: boolean;
    }
    const evaluate = (face: number, level: number, ix: number, iy: number, pMin: number, pMax: number): NodeEval => {
      const [u0, v0, u1, v1] = nodeUvRange(level, ix, iy);
      faceToSphere(face, (u0 + u1) / 2, (v0 + v1) / 2, tmp);
      const edge = (R * (u1 - u0) * Math.PI) / 4; // approximate arc length of the node edge
      const angRadius = (edge / R) * 0.75 + 1e-6;
      const cosAng = tmp[0]! * camDir.x + tmp[1]! * camDir.y + tmp[2]! * camDir.z;
      const ang = Math.acos(Math.max(-1, Math.min(1, cosAng)));
      const culled = level > 0 && ang - angRadius > horizon;
      const existing = this.chunks.get(nodeKey(face, level, ix, iy));
      const minH = existing?.data?.minHeight ?? pMin;
      const maxH = existing?.data?.maxHeight ?? pMax;
      // Closest distance from the camera to the node's spherical shell patch.
      const th = Math.max(0, ang - angRadius);
      const cth = Math.cos(th);
      const r = Math.min(R + maxH, Math.max(R + minH, d * cth));
      const dist = Math.max(1, Math.sqrt(Math.max(0, d * d + r * r - 2 * d * r * cth)));
      // Screen-space geometric error. Unbuilt nodes are only evaluated for culling and distance.
      const err = existing?.data?.error ?? 0;
      const errPx = (err / dist) * pxPerRadian;
      return { culled, dist, wantSplit: level < this.maxLevel && errPx > this.errorPx };
    };

    const visit = (c: Chunk, ev: NodeEval): void => {
      c.lastUsed = this.frame;
      if (ev.wantSplit) {
        const pMin = c.data?.minHeight ?? -relief;
        const pMax = c.data?.maxHeight ?? relief;
        const kids: { c?: Chunk; ev: NodeEval }[] = [];
        let ready = true;
        for (let k = 0; k < 4; k++) {
          const cix = c.ix * 2 + (k & 1);
          const ciy = c.iy * 2 + (k >> 1);
          const kev = evaluate(c.face, c.level + 1, cix, ciy, pMin, pMax);
          if (kev.culled) {
            kids.push({ ev: kev });
            continue;
          }
          const kc = this.request(c.face, c.level + 1, cix, ciy, kev.dist / R + (c.level + 1) * 0.01);
          if (!kc || kc.state !== 'ready') ready = false;
          kids.push(kc ? { c: kc, ev: kev } : { ev: kev });
        }
        if (ready) {
          for (const k of kids) if (k.c) visit(k.c, k.ev);
          return;
        }
      }
      out.push(c);
    };

    for (let f = 0; f < 6; f++) {
      const root = this.chunks.get(nodeKey(f, 0, 0, 0))!;
      visit(root, evaluate(f, 0, 0, 0, -relief, relief));
    }

    // Cancel queued builds nobody asked for this frame.
    const key = this.config.key;
    this.pool.clearQueue((req, k) => {
      if (k !== key) return false;
      const c = this.chunks.get(nodeKey(req.face, req.level, req.ix, req.iy));
      return !c || c.lastUsed < this.frame;
    });

    let tris = 0;
    let maxLevel = 0;
    for (const c of out) {
      if (c.mesh) {
        c.mesh.visible = true;
        if (this.materialFor) c.mesh.material = this.materialFor(c.face, c.level, c.ix, c.iy);
        tris += (this.index.count / 3) | 0;
        if (c.level > maxLevel) maxLevel = c.level;
      }
    }
    this.visible = out;
    this.evict();
    this.stats.visibleChunks = out.length;
    this.stats.cachedChunks = this.chunks.size;
    this.stats.maxLevelVisible = maxLevel;
    this.stats.triangles = tris;
  }

  private evict(): void {
    if (this.chunks.size <= this.maxChunks) return;
    const candidates = [...this.chunks.values()]
      .filter((c) => c.level > 0 && c.lastUsed < this.frame && c.state === 'ready')
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let excess = this.chunks.size - this.maxChunks;
    for (const c of candidates) {
      if (excess-- <= 0) break;
      if (c.mesh) this.disposeMesh(c.mesh);
      this.chunks.delete(c.key);
    }
  }

  /**
   * Free a chunk mesh. The index buffer is shared by all chunks; detach it first so three does not free it with the
   * geometry. Disposing the geometry frees its GPU buffers but not the renderer's per-draw state: three keeps one
   * RenderObject per (mesh, material) drawn, holding the mesh, its vertex arrays, a uniform buffer and bind groups,
   * until the mesh or material fires 'dispose'. The mesh's own dispose releases all of them (any tile materials too).
   */
  private disposeMesh(mesh: THREE.Mesh): void {
    mesh.geometry.setIndex(null);
    mesh.geometry.dispose();
    mesh.dispose();
    mesh.removeFromParent();
  }

  dispose(): void {
    for (const c of this.chunks.values()) if (c.mesh) this.disposeMesh(c.mesh);
    this.chunks.clear();
    // Cancel this body's queued builds and drop its height config from the workers.
    const key = this.config.key;
    this.pool.clearQueue((_, k) => k === key);
    this.pool.unregister(key);
  }
}
