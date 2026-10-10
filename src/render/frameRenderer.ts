/**
 * Frame renderer: background (sky) pass, depth-partitioned world passes, cockpit pass, then HDR post-processing.
 *
 * Camera-relative contract: the world camera sits at the render-space origin; every top-level world object's
 * `position` is written each frame as (object world position − camera world position), computed in float64 by the
 * caller. three.js composes matrices in float64 on the CPU, so the GPU only ever sees small translations.
 */
import * as THREE from 'three/webgpu';
import { texture, uniform, vec4, float } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { planPartitions, type DepthInterval } from './depth/partition';
import type { DepthMode } from './bootstrap';

export interface DepthRenderable {
  /** Top-level object in worldScene. Its position must be camera-relative. */
  readonly object: THREE.Object3D;
  /** Bounding radius in meters around object.position. */
  radius: number;
  /** Optional tighter far bound for camera distance d (e.g. horizon distance for a planet). */
  farBound?: (d: number) => number;
  /** Optional tighter near bound for camera distance d (e.g. altitude above terrain). */
  nearBound?: (d: number) => number;
}

export interface FrameStats {
  partitions: number;
  partitionRanges: [number, number][];
  drawCalls: number;
  triangles: number;
}

export interface FrameRendererOptions {
  depthMode: DepthMode;
  /** Max far/near ratio per partition for 24-bit depth. */
  maxRatio?: number;
  /** Closest world-geometry distance the world camera will ever need (cockpit has its own pass). */
  minNear?: number;
  msaaSamples?: number;
}

const tmpV = new THREE.Vector3();

export class FrameRenderer {
  readonly worldScene = new THREE.Scene();
  readonly backgroundScene = new THREE.Scene();
  readonly cockpitScene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly backgroundCamera: THREE.PerspectiveCamera;
  readonly cockpitCamera: THREE.PerspectiveCamera;
  readonly stats: FrameStats = { partitions: 0, partitionRanges: [], drawCalls: 0, triangles: 0 };

  depthMode: DepthMode;
  maxRatio: number;
  minNear: number;
  cockpitEnabled = true;
  readonly exposure = uniform(1.0);
  readonly bloomStrength = uniform(0.6);

  private readonly renderables = new Set<DepthRenderable>();
  private hdr: THREE.RenderTarget;
  private readonly pipeline: THREE.RenderPipeline;
  private readonly bloomNode: ReturnType<typeof bloom>;
  private renderScale = 1;
  private width = 1;
  private height = 1;

  constructor(
    readonly renderer: THREE.WebGPURenderer,
    opts: FrameRendererOptions,
  ) {
    this.depthMode = opts.depthMode;
    this.maxRatio = opts.maxRatio ?? 2000;
    this.minNear = opts.minNear ?? 0.5;
    this.camera = new THREE.PerspectiveCamera(60, 1, this.minNear, 1e13);
    this.backgroundCamera = new THREE.PerspectiveCamera(60, 1, 1, 1e7);
    this.cockpitCamera = new THREE.PerspectiveCamera(60, 1, 0.01, 200);
    this.camera.matrixAutoUpdate = true;

    this.hdr = new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: opts.msaaSamples ?? 4,
      depthBuffer: true,
    });

    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.autoClear = false;

    const hdrTex = texture(this.hdr.texture);
    const exposed = hdrTex.mul(this.exposure);
    this.bloomNode = bloom(exposed, 0.6, 0.45, 0.9);
    this.bloomNode.strength = this.bloomStrength;
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputNode = vec4(exposed.rgb.add(this.bloomNode.rgb), float(1));
  }

  add(r: DepthRenderable): void {
    this.renderables.add(r);
    if (r.object.parent !== this.worldScene) this.worldScene.add(r.object);
  }

  remove(r: DepthRenderable): void {
    this.renderables.delete(r);
    r.object.removeFromParent();
  }

  setRenderScale(scale: number): void {
    this.renderScale = scale;
    this.resize(this.width, this.height);
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
    const w = Math.max(1, Math.round(this.width * dpr * this.renderScale));
    const h = Math.max(1, Math.round(this.height * dpr * this.renderScale));
    this.hdr.setSize(w, h);
    const aspect = this.width / this.height;
    for (const c of [this.camera, this.backgroundCamera, this.cockpitCamera]) {
      c.aspect = aspect;
      c.updateProjectionMatrix();
    }
  }

  setFov(fovDeg: number): void {
    for (const c of [this.camera, this.backgroundCamera, this.cockpitCamera]) {
      c.fov = fovDeg;
      c.updateProjectionMatrix();
    }
  }

  /** Conservative sphere-vs-frustum test in view space with no far plane. */
  private inFrustum(center: THREE.Vector3, radius: number): boolean {
    const v = tmpV.copy(center).applyMatrix4(this.camera.matrixWorldInverse);
    if (v.z - radius > 0) return false; // entirely behind the camera
    const tanY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const tanX = tanY * this.camera.aspect;
    const depth = -v.z;
    // Side planes through the origin; normals normalized.
    const nx = 1 / Math.sqrt(1 + tanX * tanX);
    const ny = 1 / Math.sqrt(1 + tanY * tanY);
    if ((v.x - tanX * depth) * nx > radius) return false;
    if ((-v.x - tanX * depth) * nx > radius) return false;
    if ((v.y - tanY * depth) * ny > radius) return false;
    if ((-v.y - tanY * depth) * ny > radius) return false;
    return true;
  }

  render(): void {
    const r = this.renderer;
    const info = r.info;
    info.autoReset = false;
    info.reset();

    this.camera.updateMatrixWorld();
    this.backgroundCamera.quaternion.copy(this.camera.quaternion);
    this.backgroundCamera.updateMatrixWorld();
    this.cockpitCamera.updateMatrixWorld();

    r.setRenderTarget(this.hdr);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, true);

    // 1. Sky: stars, Milky Way. Objects place themselves at a fixed render distance.
    r.render(this.backgroundScene, this.backgroundCamera);

    // 2. World, partitioned by depth.
    const intervals: DepthInterval<DepthRenderable>[] = [];
    const wasVisible: DepthRenderable[] = [];
    for (const item of this.renderables) {
      const obj = item.object;
      if (!obj.visible) continue;
      wasVisible.push(item);
      const d = obj.position.length();
      if (!this.inFrustum(obj.position, item.radius)) continue;
      const near = item.nearBound ? item.nearBound(d) : d - item.radius;
      const far = item.farBound ? item.farBound(d) : d + item.radius;
      intervals.push({ near, far, item });
    }
    for (const item of wasVisible) item.object.visible = false;

    let partitions;
    if (this.depthMode === 'naive') {
      partitions = intervals.length ? [{ near: 0.1, far: 1e13, items: intervals.map((i) => i.item) }] : [];
    } else if (this.depthMode === 'reversed') {
      // Float reversed-Z has ~constant relative precision, so one pass covers every distance.
      let near = Infinity;
      let far = 0;
      for (const iv of intervals) {
        near = Math.min(near, iv.near);
        far = Math.max(far, iv.far);
      }
      partitions = intervals.length
        ? [{ near: Math.max(this.minNear, near), far: Math.max(far, this.minNear * 2), items: intervals.map((i) => i.item) }]
        : [];
    } else {
      partitions = planPartitions(intervals, this.maxRatio, this.minNear);
    }
    this.stats.partitions = partitions.length;
    this.stats.partitionRanges = partitions.map((p) => [p.near, p.far]);

    for (const p of partitions) {
      for (const it of p.items) it.object.visible = true;
      this.camera.near = this.depthMode === 'naive' ? p.near : p.near * 0.98;
      this.camera.far = this.depthMode === 'naive' ? p.far : p.far * 1.02;
      this.camera.updateProjectionMatrix();
      r.clearDepth();
      r.render(this.worldScene, this.camera);
      for (const it of p.items) it.object.visible = false;
    }
    for (const item of wasVisible) item.object.visible = true;

    // 3. Cockpit: its own depth range, always in front.
    if (this.cockpitEnabled && this.cockpitScene.children.length > 0) {
      // cockpitCamera lives in ship-local space; its orientation (head look) is owned by the caller.
      this.cockpitCamera.updateMatrixWorld();
      r.clearDepth();
      r.render(this.cockpitScene, this.cockpitCamera);
    }

    r.setRenderTarget(null);
    this.stats.drawCalls = info.render.drawCalls;
    this.stats.triangles = info.render.triangles;
    this.pipeline.render();
  }

  /** Read back the final HDR buffer region (pre-tonemap) for tests. */
  async readHdrPixels(x: number, y: number, w: number, h: number): Promise<ArrayLike<number>> {
    return this.renderer.readRenderTargetPixelsAsync(this.hdr, x, y, w, h);
  }

  get hdrSize(): { width: number; height: number } {
    return { width: this.hdr.width, height: this.hdr.height };
  }
}
