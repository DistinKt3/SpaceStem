/**
 * The sky: ESA Gaia EDR3 Milky Way map (diffuse glow), 109k HYG stars as point sprites, and planets that are too
 * small to resolve drawn as points. Rendered in the background pass (camera rotation only, no translation).
 *
 * Star brightness is computed per frame on the GPU from each star's absolute magnitude and its distance from the
 * camera, so stars brighten as you approach them. Relative brightness follows real magnitudes; the overall gain is an
 * artistic choice (a human eye adapts to the dark far more than a camera exposed for sunlit planets), see the Codex.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  asin,
  atan,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  dot,
  exp,
  float,
  instancedBufferAttribute,
  length,
  log2,
  max,
  min,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  select,
  smoothstep,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { dataUrl, fetchBytes } from '../data/assets';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
type N = any;

const RENDER_DIST = 4e6; // background camera far is 1e7

/** ICRS -> Galactic rotation (rows), IAU / Hipparcos convention (ESA 1997, Vol. 1, Sec. 1.5.3). */
const GAL_ROWS: [number, number, number][] = [
  [-0.0548755604162154, -0.873437090234885, -0.483835015548713],
  [0.494109427875584, -0.444829629960011, 0.746982244497219],
  [-0.867666149019005, -0.198076373431202, 0.455983776175067],
];

export class Starfield {
  readonly group = new THREE.Group();
  /** Camera position relative to the Sun in parsecs (ICRS axes). */
  readonly camPc = uniform(new THREE.Vector3());
  /** Faintest apparent magnitude drawn. */
  readonly magLimit = uniform(7.5);
  /** Overall star/sky brightness multiplier (already divided by exposure by the caller). */
  readonly gain = uniform(1);
  readonly viewport = uniform(new THREE.Vector2(1920, 1080));
  readonly skyGain = uniform(1);
  /** Hyperspeed streaks: amount (0 = none) and travel direction (world, unit). */
  readonly streak = uniform(0);
  readonly velDir = uniform(new THREE.Vector3(0, 0, -1));
  count = 0;
  /** Catalogue arrays (shared with StarCatalog). */
  positions = new Float32Array(0);
  absMags = new Float32Array(0);
  colors = new Uint8Array(0);
  private planetMesh?: THREE.Mesh;
  private planetDir?: THREE.InstancedBufferAttribute;
  private planetMag?: THREE.InstancedBufferAttribute;
  private planetColor?: THREE.InstancedBufferAttribute;

  async load(maxPlanets = 32): Promise<void> {
    const buf = await fetchBytes('stars.bin');
    const stride = 20;
    const count = buf.byteLength / stride;
    this.count = count;
    const dv = new DataView(buf);
    const pos = new Float32Array(count * 3);
    const mag = new Float32Array(count);
    const col = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      pos[i * 3] = dv.getFloat32(o, true);
      pos[i * 3 + 1] = dv.getFloat32(o + 4, true);
      pos[i * 3 + 2] = dv.getFloat32(o + 8, true);
      mag[i] = dv.getFloat32(o + 12, true);
      col[i * 4] = dv.getUint8(o + 16);
      col[i * 4 + 1] = dv.getUint8(o + 17);
      col[i * 4 + 2] = dv.getUint8(o + 18);
      col[i * 4 + 3] = 255;
    }
    this.positions = pos;
    this.absMags = mag;
    this.colors = col;
    const stars = this.buildSprites(
      count,
      new THREE.InstancedBufferAttribute(pos, 3),
      new THREE.InstancedBufferAttribute(mag, 1),
      new THREE.InstancedBufferAttribute(col, 4, true),
      false,
    );
    stars.renderOrder = 2;
    this.group.add(stars);

    // Planet points: direction (unit, world), apparent magnitude and colour updated each frame.
    this.planetDir = new THREE.InstancedBufferAttribute(new Float32Array(maxPlanets * 3), 3);
    this.planetMag = new THREE.InstancedBufferAttribute(new Float32Array(maxPlanets).fill(99), 1);
    this.planetColor = new THREE.InstancedBufferAttribute(new Uint8Array(maxPlanets * 4).fill(255), 4, true);
    for (const a of [this.planetDir, this.planetMag, this.planetColor]) a.setUsage(THREE.DynamicDrawUsage);
    this.planetMesh = this.buildSprites(maxPlanets, this.planetDir, this.planetMag, this.planetColor, true);
    this.planetMesh.renderOrder = 3;
    this.group.add(this.planetMesh);
  }

  /** Load the Gaia Milky Way map (8k); call after the first frame so startup is not blocked. */
  async loadMilkyWay(): Promise<void> {
    const tex = await new THREE.TextureLoader().loadAsync(dataUrl('tex/milky_way_gaia.webp'));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false });
    const rows: N[] = GAL_ROWS.map((r) => vec3(...r));
    m.fragmentNode = Fn(() => {
      const d = normalize(positionWorld);
      const gx = dot(rows[0], d);
      const gy = dot(rows[1], d);
      const gz = dot(rows[2], d);
      const l = atan(gy, gx);
      const b = asin(clamp(gz, -1, 1));
      // Gaia map: galactic longitude increases to the left, latitude up; centre = (l, b) = (0, 0).
      const uvg = vec2(float(0.5).sub(l.div(2 * Math.PI)), b.div(Math.PI).add(0.5));
      const c = texture(tex, uvg).rgb;
      // Remove the display stretch's dark floor, keep the glow subtle (stars are drawn as points on top).
      const glow = max(c.sub(0.035), vec3(0)).mul(0.22);
      return vec4(glow.mul(this.skyGain), 1);
    })();
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(RENDER_DIST * 1.2, 64, 32), m);
    sphere.renderOrder = 1;
    sphere.frustumCulled = false;
    this.group.add(sphere);
  }

  private buildSprites(
    count: number,
    posAttr: THREE.InstancedBufferAttribute,
    magAttr: THREE.InstancedBufferAttribute,
    colAttr: THREE.InstancedBufferAttribute,
    direct: boolean,
  ): THREE.Mesh {
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.instanceCount = count;
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const p: N = instancedBufferAttribute(posAttr);
    const absMag: N = instancedBufferAttribute(magAttr);
    const col: N = instancedBufferAttribute(colAttr);

    let dir: N;
    let appMag: N;
    if (direct) {
      dir = normalize(p);
      appMag = absMag;
    } else {
      const rel = p.sub(this.camPc);
      const d = max(length(rel), 1e-9);
      dir = rel.div(d);
      // m = M + 5 log10(d / 10 pc)
      appMag = absMag.add(log2(d).mul(5 / Math.log2(10))).sub(5);
    }
    // Intensity: 10^(-0.4 (m - 4)), soft cut at the magnitude limit; HDR above m~4 so bright stars bloom.
    const flux = pow(float(10), appMag.sub(4).mul(-0.4));
    const visible = float(1).sub(smoothstep(this.magLimit.sub(1.5), this.magLimit, appMag));
    const intensity = min(flux, float(direct ? 40 : 12)).mul(visible).mul(this.gain);
    const sizePx = clamp(pow(float(10), appMag.sub(2).mul(-0.12)).mul(2.4), 1.6, direct ? 9 : 12);

    const vIntensity: N = varying(intensity);
    const vColor: N = varying(col.rgb);
    mat.vertexNode = Fn(() => {
      const view = cameraViewMatrix.mul(vec4(dir.mul(RENDER_DIST), 1));
      const clip = cameraProjectionMatrix.mul(view).toVar();
      const hide = intensity.lessThan(1e-4);
      const s = select(hide, float(0), float(1));
      // Hyperspeed: stretch each star along the line from the vanishing point (travel direction) through it.
      const vpView = cameraViewMatrix.mul(vec4(this.velDir.mul(RENDER_DIST), 1));
      const vpClip = cameraProjectionMatrix.mul(vpView);
      const ndc = clip.xy.div(clip.w);
      const vpNdc = vpClip.xy.div(max(vpClip.w, 1e-6));
      const away = ndc.sub(vpNdc).mul(this.viewport).mul(0.5); // px
      const awayLen = max(length(away), 1e-3);
      const along = away.div(awayLen);
      // (along, across) must keep the quad's winding (determinant +1), or the sprite is back-face culled.
      const across = vec2(along.y, along.x.negate());
      const streakPx = this.streak.mul(awayLen).mul(0.35).mul(select(vpClip.w.greaterThan(0), float(1), float(0)));
      const corner = positionGeometry.xy;
      const lenPx = sizePx.add(streakPx);
      const offPx = across.mul(corner.x.mul(sizePx)).add(along.mul(corner.y.mul(lenPx).sub(streakPx.mul(0.5))));
      const offset = offPx.mul(2).div(this.viewport).mul(clip.w);
      return vec4(clip.xy.add(offset.mul(s)), clip.z, clip.w);
    })();
    mat.fragmentNode = Fn(() => {
      const r = length(uv().sub(0.5)).mul(2);
      // Gaussian core (a point-spread function) with a faint halo; energy roughly constant across sizes.
      const psf = exp(r.mul(r).mul(-5.5)).add(exp(r.mul(-6)).mul(0.08)).mul(smoothstep(1, 0.8, r));
      return vec4(vColor.mul(vIntensity).mul(psf), 1);
    })();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Update planet points: unit directions (world), apparent magnitudes and colours (0-255). */
  setPlanets(points: { dir: [number, number, number]; mag: number; color: [number, number, number] }[]): void {
    if (!this.planetDir || !this.planetMag || !this.planetColor) return;
    const n = Math.min(points.length, this.planetMag.count);
    for (let i = 0; i < this.planetMag.count; i++) {
      const pt = i < n ? points[i]! : undefined;
      this.planetDir.setXYZ(i, pt?.dir[0] ?? 0, pt?.dir[1] ?? 0, pt?.dir[2] ?? 1);
      this.planetMag.setX(i, pt?.mag ?? 99);
      this.planetColor.setXYZW(i, pt?.color[0] ?? 255, pt?.color[1] ?? 255, pt?.color[2] ?? 255, 255);
    }
    this.planetDir.needsUpdate = true;
    this.planetMag.needsUpdate = true;
    this.planetColor.needsUpdate = true;
  }
}
