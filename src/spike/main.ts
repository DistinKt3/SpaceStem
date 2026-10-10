/**
 * M0 spike: one scene spanning 1 m to 1e12 m. Proves camera-relative rendering + depth strategy + LOD sphere on both
 * backends. Exposes window.__ks hooks for the automated precision tests in tests/e2e/spike.spec.ts.
 */
import * as THREE from 'three/webgpu';
import { attribute, color, mix, smoothstep, vec3, float } from 'three/tsl';
import { createRenderer, effectiveDepthMode, type BackendRequest, type DepthMode } from '../render/bootstrap';
import { FrameRenderer, type DepthRenderable } from '../render/frameRenderer';
import { Vec3d } from '../core/vec3d';
import { PlanetTerrain } from '../world/planet/planetTerrain';
import { ChunkWorkerPool } from '../world/planet/workerPool';

const params = new URLSearchParams(location.search);
const backendReq = (params.get('backend') ?? 'auto') as BackendRequest;
const requestedDepth = (params.get('depth') ?? 'reversed') as DepthMode;
const absoluteOrigin = params.get('origin') === 'absolute';
const hud = document.getElementById('hud')!;

const R_PLANET = 6.371e6;
const PLATE_EPS = Number(params.get('eps') ?? 1e-3);

interface Placed {
  obj: THREE.Object3D;
  world: Vec3d;
  renderable: DepthRenderable;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const { renderer, info } = await createRenderer(canvas, backendReq, requestedDepth);
  const depthMode = effectiveDepthMode(requestedDepth, info);
  const fr = new FrameRenderer(renderer, { depthMode, msaaSamples: params.get('msaa') === '0' ? 0 : 4 });
  fr.bloomStrength.value = Number(params.get('bloom') ?? 0.4);

  // Camera state in float64 world coordinates.
  const cam = { pos: new Vec3d(0, 0, 0), quat: new THREE.Quaternion() };
  const placed: Placed[] = [];
  const place = (obj: THREE.Object3D, world: Vec3d, radius: number, extra: Partial<DepthRenderable> = {}): Placed => {
    const renderable: DepthRenderable = { object: obj, radius, ...extra };
    fr.add(renderable);
    const p = { obj, world, renderable };
    placed.push(p);
    return p;
  };

  // Lighting.
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(0.3, 1, 0.5);
  fr.worldScene.add(sun, new THREE.AmbientLight(0x334455, 0.6));

  // LOD planet.
  const pool = new ChunkWorkerPool();
  const extras = attribute('extras', 'vec2');
  const h = extras.y;
  const terrainMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  terrainMat.colorNode = mix(
    mix(color(0x2d5a27), color(0x8a7f68), smoothstep(float(200), float(1800), h)),
    vec3(0.92, 0.94, 0.97),
    smoothstep(float(2200), float(2800), h),
  );
  const terrain = new PlanetTerrain(pool, {
    config: { key: 'spike', radius: R_PLANET, seed: 42, procedural: 'earthlike', amplitude: 2500 },
    material: terrainMat,
    maxRelief: 3000,
    grid: 32,
  });
  // Local ground radius under the test site (direction +x), so the camera starts above the terrain.
  const G = R_PLANET + terrain.heightAtDir(1, 0, 0);
  cam.pos.set(G + 2, 0, 0);
  const planetObj = new THREE.Group();
  planetObj.add(terrain.group);
  place(planetObj, new Vec3d(0, 0, 0), R_PLANET + 3000, {
    farBound: (d) => Math.sqrt(Math.max(d * d - R_PLANET * R_PLANET, 0)) + Math.sqrt((R_PLANET + 3000) ** 2 - R_PLANET ** 2) + 1,
    nearBound: (d) => d - R_PLANET - 3000,
  });

  // Near-field objects: 1 m cube 3 m away, 100 m tower 500 m away (sitting on the reference sphere).
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0xffaa33 }));
  place(cube, new Vec3d(G + 2, 0, 3), 1);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(5, 8, 100, 24), new THREE.MeshStandardNodeMaterial({ color: 0xccccdd }));
  tower.rotation.z = -Math.PI / 2;
  place(tower, new Vec3d(R_PLANET + terrain.heightAtDir(1, 400 / R_PLANET, 300 / R_PLANET) + 50, 400, 300), 60);

  // Plate pairs at every decade, fanned around the zenith (+x) so none occludes another.
  const plateGeo = new THREE.PlaneGeometry(1, 1);
  const front = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0, 0.6, 0), side: THREE.DoubleSide });
  const back = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.6, 0, 0), side: THREE.DoubleSide });
  const plateViews: { decade: number; dir: THREE.Vector3 }[] = [];
  for (let k = 0; k <= 12; k++) {
    const col = k % 5;
    const row = Math.floor(k / 5);
    const yaw = THREE.MathUtils.degToRad((col - 2) * 11);
    const pitch = THREE.MathUtils.degToRad((1 - row) * 11);
    // Camera looks along +x with +z as screen-up; spread directions in y (right) and z (up).
    const dir = new THREE.Vector3(1, Math.tan(yaw), Math.tan(pitch)).normalize();
    const d = Math.pow(10, k) * 3;
    const size = d * 0.08;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    for (const [mat, dist] of [[back, d * (1 + PLATE_EPS)], [front, d]] as const) {
      const m = new THREE.Mesh(plateGeo, mat);
      m.scale.setScalar(size);
      m.quaternion.copy(q);
      const w = new Vec3d(G + 2 + dir.x * dist, dir.y * dist, dir.z * dist);
      place(m, w, size * 0.75);
    }
    plateViews.push({ decade: k, dir });
  }

  // Distant bodies: Jupiter-sized sphere at 1e11 m, Sun-sized at 1e12 m.
  const sphereGeo = new THREE.SphereGeometry(1, 64, 32);
  const jupiter = new THREE.Mesh(sphereGeo, new THREE.MeshStandardNodeMaterial({ color: 0xd9b38c }));
  jupiter.scale.setScalar(7e7);
  place(jupiter, new Vec3d(R_PLANET + 2, -1e11, 2e10), 7e7);
  const star = new THREE.Mesh(sphereGeo, new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(8, 7, 5) }));
  star.scale.setScalar(7e8);
  place(star, new Vec3d(R_PLANET + 2, 1e12, 3e11), 7e8);

  // Jitter probe: a 1 m green marker 10 m in front of a camera parked 1e12 m from the origin.
  const marker = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0, 0.6, 0) }));
  const JITTER_BASE = new Vec3d(1e12, 0, 0);
  place(marker, new Vec3d(JITTER_BASE.x + 10, 0, 0), 1);

  // Cockpit-scale probe: a small frame at 0.3 m in the cockpit pass.
  const frame = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.004, 8, 64), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.2, 0.5, 0.9) }));
  frame.position.set(0, 0, -0.3);
  fr.cockpitScene.add(frame);
  fr.cockpitEnabled = params.get('cockpit') !== '0';

  // Views. Screen-up is +z for the plate view; quaternions are built with lookAt from a temporary object.
  const look = (pos: Vec3d, target: Vec3d, upv: THREE.Vector3): void => {
    cam.pos.copy(pos);
    const o = new THREE.PerspectiveCamera(); // cameras look down -z (Object3D.lookAt would aim +z)
    o.up.copy(upv);
    o.lookAt(target.x - pos.x, target.y - pos.y, target.z - pos.z);
    cam.quat.copy(o.quaternion);
  };
  const views: Record<string, () => void> = {
    plates: () => look(new Vec3d(G + 2, 0, 0), new Vec3d(G + 100, 0, 0), new THREE.Vector3(0, 0, 1)),
    surface: () => look(new Vec3d(G + 3, 0, -2), new Vec3d(G + 3, 400, 300), new THREE.Vector3(1, 0, 0)),
    orbit: () => look(new Vec3d(R_PLANET + 4e5, 0, 0), new Vec3d(R_PLANET, 2e6, 0), new THREE.Vector3(1, 0, 0)),
    far: () => look(new Vec3d(4e7, -2e7, 1e7), new Vec3d(0, 0, 0), new THREE.Vector3(0, 0, 1)),
    jitter: () => look(JITTER_BASE.clone(), new Vec3d(JITTER_BASE.x + 10, 0, 0), new THREE.Vector3(0, 0, 1)),
  };
  views['plates']!();

  // Controls.
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    const n = Number(e.key);
    const names = Object.keys(views);
    if (n >= 1 && n <= names.length) views[names[n - 1]!]!();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  let dragging = false;
  renderer.domElement.addEventListener('pointerdown', () => (dragging = true));
  window.addEventListener('pointerup', () => (dragging = false));
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -e.movementX * 0.003);
    const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -e.movementY * 0.003);
    cam.quat.multiply(qy).multiply(qx);
  });

  const resize = (): void => fr.resize(innerWidth, innerHeight);
  window.addEventListener('resize', resize);
  resize();

  const camBF = new Vec3d();
  let last = performance.now();
  let frameMs = 16;
  const tick = (): void => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    frameMs = frameMs * 0.9 + (now - last) * 0.1;
    last = now;

    // Fly: speed scales with altitude so every scale is traversable.
    const alt = Math.max(1, cam.pos.length() - R_PLANET);
    const speed = alt * 1.5 * (keys.has('ShiftLeft') ? 10 : 1);
    const mv = new THREE.Vector3(
      (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
      (keys.has('KeyR') ? 1 : 0) - (keys.has('KeyF') ? 1 : 0),
      (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0),
    ).applyQuaternion(cam.quat);
    cam.pos.addScaled(new Vec3d(mv.x, mv.y, mv.z), speed * dt);
    const roll = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);
    if (roll) cam.quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll * dt));

    render();
    requestAnimationFrame(tick);
  };

  const render = (): void => {
    fr.camera.quaternion.copy(cam.quat);
    if (absoluteOrigin) {
      // Naive control: world-space positions straight into float32 GPU math.
      fr.camera.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
      for (const p of placed) p.obj.position.set(p.world.x, p.world.y, p.world.z);
    } else {
      fr.camera.position.set(0, 0, 0);
      for (const p of placed) p.obj.position.set(p.world.x - cam.pos.x, p.world.y - cam.pos.y, p.world.z - cam.pos.z);
    }
    fr.camera.updateMatrixWorld();
    camBF.copy(cam.pos); // planet frame == world frame in the spike
    const pxPerRad = (renderer.domElement.height || innerHeight) / THREE.MathUtils.degToRad(fr.camera.fov);
    terrain.update(camBF, pxPerRad);
    fr.render();
    const alt = cam.pos.length() - R_PLANET;
    hud.textContent = [
      `backend   ${info.backend}${info.shims.length ? ` (shims: ${info.shims.join(',')})` : ''}`,
      `adapter   ${info.adapter}`,
      `depth     ${depthMode}${info.reversedDepth ? ' (reversed-Z active)' : ''}  origin ${absoluteOrigin ? 'ABSOLUTE (naive)' : 'camera-relative'}`,
      `fallback  ${info.fallbackReason ?? 'none'}`,
      `frame     ${frameMs.toFixed(1)} ms`,
      `draws     ${fr.stats.drawCalls}   tris ${fr.stats.triangles.toLocaleString()}`,
      `partitions ${fr.stats.partitions}: ${fr.stats.partitionRanges.map(([a, b]) => `[${a.toExponential(1)}, ${b.toExponential(1)}]`).join(' ')}`,
      `terrain   chunks ${terrain.stats.visibleChunks}/${terrain.stats.cachedChunks}  maxLevel ${terrain.stats.maxLevelVisible}  pending ${pool.pending}`,
      `altitude  ${alt.toExponential(3)} m`,
    ].join('\n');
  };

  // Test hooks.
  const w = window as unknown as { __ks: unknown };
  w.__ks = {
    info,
    depthMode,
    absoluteOrigin,
    plateViews: plateViews.map((p) => ({ decade: p.decade, dir: [p.dir.x, p.dir.y, p.dir.z] })),
    setView: (name: string) => views[name]!(),
    offsetCamera: (dx: number, dy: number, dz: number) => cam.pos.add(new Vec3d(dx, dy, dz)),
    renderOnce: () => render(),
    pendingChunks: () => pool.pending,
    stats: () => ({ ...fr.stats, terrain: { ...terrain.stats }, frameMs }),
    /** Project a world direction from the camera to canvas pixel coords (for test sampling). */
    projectDir: (x: number, y: number, z: number) => {
      const v = new THREE.Vector3(x, y, z).applyQuaternion(cam.quat.clone().invert());
      const p = new THREE.Vector3(v.x, v.y, v.z).applyMatrix4(fr.camera.projectionMatrix);
      const c = renderer.domElement;
      return [((p.x + 1) / 2) * c.width, ((1 - p.y) / 2) * c.height];
    },
    /** Render and read back in the same task (WebGL canvases clear after compositing). */
    capture: () => {
      render();
      return renderer.domElement.toDataURL('image/png');
    },
    /** Sample RGB at canvas pixel positions from a fresh frame. */
    sample: async (points: [number, number][]) => {
      render();
      const url = renderer.domElement.toDataURL('image/png');
      const img = new Image();
      img.src = url;
      await img.decode();
      const c2 = document.createElement('canvas');
      c2.width = img.width;
      c2.height = img.height;
      const ctx = c2.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return points.map(([x, y]) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)));
    },
  };
  requestAnimationFrame(tick);
}

main().catch((err: unknown) => {
  hud.textContent = `FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  console.error(err);
});
