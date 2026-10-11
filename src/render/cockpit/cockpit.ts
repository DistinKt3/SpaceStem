/**
 * The player's cockpit: a procedural sleek sci-fi interior drawn in FrameRenderer's cockpit pass (cockpitScene +
 * cockpitCamera, after the world with a depth clear, so the cockpit is always in front and the canopy glass blends over
 * the world).
 *
 * Conventions: ship-local axes -Z forward, +Y up, +X right; the pilot's eye is at the origin; metres. Add `group` to
 * the cockpit scene at the origin without rotation; head look rotates the cockpit camera, never the group.
 *
 * Brightness: CockpitState.sunIntensity is display-referred (already exposure-adjusted). FrameRenderer multiplies the
 * whole HDR buffer, cockpit included, by its exposure; set `exposureCompensation = 1 / exposure` so the instruments
 * and interior keep a constant brightness while the eye adapts to the world (see the module notes in the result).
 */
import * as THREE from 'three/webgpu';
import { buildCockpitGeometry, triangleCount, type CockpitGeometry, type PanelKind } from './geometry';
import { buildGlassTexture } from './glassTexture';
import { ATLAS_H, ATLAS_W, LAYOUT, MODE_KEYS, drawDisplayAtlas } from './displayAtlas';
import {
  CockpitUniforms,
  createLights,
  glassMaterial,
  glowMaterial,
  holoMaterial,
  keyMaterial,
  screenMaterial,
  skinMaterial,
  surfaceMaterial,
  type CockpitLights,
} from './materials';
import { canopyTransmission, type V3 } from './layout';

export type FlightMode = 'thrusters' | 'impulse' | 'cruise' | 'hyperspeed';

export interface CockpitState {
  time: number;
  throttle: number /*0..1*/;
  speedFraction: number /*0..1 of mode max*/;
  mode: FlightMode;
  sunDirLocal: THREE.Vector3 /*unit vector toward the Sun in ship-local axes*/;
  sunIntensity: number /*0..~3, already exposure-adjusted*/;
  planetGlow: { dirLocal: THREE.Vector3; color: THREE.Color; intensity: number } | null;
  alert: number /*0..1*/;
  reducedMotion: boolean;
}

export interface CockpitStats {
  /** Draw calls the cockpit pass issues (visible meshes; every cockpit material is single pass). */
  drawCalls: number;
  triangles: number;
}

/** Accent #7fd4ff and the alert colours (linear). */
const ACCENT = new THREE.Color('#7fd4ff');
const AMBER = new THREE.Color('#ffb03a');
const RED = new THREE.Color('#ff3b30');
const SUN_COLOR = new THREE.Color(1.0, 0.97, 0.92);

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export class Cockpit {
  readonly group: THREE.Group;
  /** Multiply interior lighting and panel emission (set to 1 / FrameRenderer.exposure when the world adapts). */
  exposureCompensation = 1;
  /** Overall instrument brightness (user setting). */
  panelBrightness = 1;

  private readonly u = new CockpitUniforms();
  private readonly lights: CockpitLights;
  private readonly geo: CockpitGeometry;
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly meshes: THREE.Mesh[] = [];
  private readonly tmpColor = new THREE.Color();

  constructor(opts?: { quality?: 'low' | 'high' }) {
    const quality = opts?.quality ?? 'high';
    this.group = new THREE.Group();
    this.group.name = 'cockpit';
    this.geo = buildCockpitGeometry(quality);
    const g = this.geo;
    const u = this.u;

    this.lights = createLights(u, g.glowAnchors);
    for (const o of this.lights.objects) this.group.add(o);

    // Textures generated in code.
    const wearData = buildGlassTexture(quality === 'high' ? 1024 : 512);
    const wear = new THREE.DataTexture(wearData.data, wearData.size, wearData.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    wear.wrapS = THREE.RepeatWrapping;
    wear.wrapT = THREE.RepeatWrapping;
    wear.generateMipmaps = true;
    wear.minFilter = THREE.LinearMipmapLinearFilter;
    wear.magFilter = THREE.LinearFilter;
    wear.anisotropy = 4;
    wear.colorSpace = THREE.NoColorSpace;
    wear.needsUpdate = true;
    const atlas = new THREE.DataTexture(drawDisplayAtlas(), ATLAS_W, ATLAS_H, THREE.RGBAFormat, THREE.UnsignedByteType);
    atlas.generateMipmaps = true;
    atlas.minFilter = THREE.LinearMipmapLinearFilter;
    atlas.magFilter = THREE.LinearFilter;
    atlas.anisotropy = 8;
    atlas.colorSpace = THREE.NoColorSpace;
    atlas.needsUpdate = true;
    this.textures.push(wear, atlas);

    const interior = this.lights.interior;
    const anchor = g.glowAnchors[0]!;
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, name: string, order = 0): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `cockpit.${name}`;
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.meshes.push(mesh);
      if (!this.materials.includes(material)) this.materials.push(material);
      return mesh;
    };

    add(g.skin, skinMaterial(u, interior, anchor), 'skin');
    add(g.shell, surfaceMaterial({ color: [0.07, 0.074, 0.082], roughness: 0.45, metalness: 0.0, f0: 0.04, seams: true }, u, interior, anchor), 'shell');
    add(g.frame, surfaceMaterial({ color: [0.06, 0.065, 0.075], roughness: 0.32, metalness: 0.65, f0: 0.5 }, u, this.lights.frame, anchor), 'frame');
    add(g.trim, surfaceMaterial({ color: [0.36, 0.38, 0.42], roughness: 0.3, metalness: 0.9, f0: 0.6 }, u, interior, anchor), 'trim');
    add(g.glassBand, surfaceMaterial({ color: [0.006, 0.007, 0.009], roughness: 0.09, metalness: 0, f0: 0.045 }, u, this.lights.screens, anchor), 'glassband');
    add(g.controls, surfaceMaterial({ color: [0.018, 0.019, 0.022], roughness: 0.6, metalness: 0.05, f0: 0.04 }, u, interior, anchor), 'controls');
    add(g.buttons, keyMaterial(u, interior, anchor), 'buttons');
    add(g.lights, glowMaterial(u), 'lights');
    for (const p of g.panels) {
      if (p.type === 'screen') add(p.geometry, screenMaterial(p.kind, atlas, u, this.lights.screens, anchor), `screen.${p.kind}`);
    }
    // Transparent layers last: holo panes, then the canopy glass over everything.
    for (const p of g.panels) {
      if (p.type === 'holo') add(p.geometry, holoMaterial(p.kind, atlas, u), `holo.${p.kind}`, 10);
    }
    // Displays as seen in reflection: their plan-view footprint on the dashboard.
    const sources = g.panels.map((p) => ({
      x: p.center.x,
      z: p.center.z,
      halfW: p.width / 2,
      halfD: (p.height / 2) * Math.max(0.2, Math.abs(p.normal.y)),
      weight: p.type === 'holo' ? 0.9 : 1,
    }));
    add(g.glass, glassMaterial(u, wear, sources), 'glass', 20);
  }

  /** Physical panels (for tests and tooling). */
  get panelKinds(): PanelKind[] {
    return this.geo.panels.map((p) => p.kind);
  }

  update(_dt: number, s: CockpitState): void {
    const u = this.u;
    const comp = Math.max(0, this.exposureCompensation);
    u.time.value = s.time;
    u.throttle.value = clamp01(s.throttle);
    u.speed.value = clamp01(s.speedFraction);
    u.mode.value = Math.max(0, MODE_KEYS.indexOf(s.mode));
    const alert = clamp01(s.alert);
    u.alert.value = alert;
    u.still.value = s.reducedMotion ? 1 : 0;
    u.gain.value = comp;

    // Panel colour: the accent until an alert, then amber shading to red with the alert level. The alert pulses
    // between amber and red with a brightness beat; under reduced motion it holds steady.
    const beat = s.reducedMotion ? 0.5 : 0.5 - 0.5 * Math.cos(s.time * Math.PI * 2 * 1.1);
    const hue = clamp01(alert * 0.7 + (s.reducedMotion ? 0.15 : 0.3) * beat * alert);
    const alertCol = this.tmpColor.copy(AMBER).lerp(RED, hue);
    const toAlert = clamp01((alert - 0.04) / 0.18);
    u.accent.value.copy(ACCENT).lerp(alertCol, toAlert * toAlert * (3 - 2 * toAlert));
    const pulseGain = 1 - toAlert * (s.reducedMotion ? 0.1 : 0.4 * beat);
    const gain = comp * this.panelBrightness * pulseGain;
    u.panelGain.value = gain;

    // Sun.
    const sun = s.sunDirLocal.clone();
    if (sun.lengthSq() < 1e-12) sun.set(0, 0, -1);
    sun.normalize();
    u.sunDir.value.copy(sun);
    const sunI = Math.max(0, s.sunIntensity) * comp;
    u.sunI.value = sunI;
    u.sunColor.value.copy(SUN_COLOR).multiplyScalar(sunI * Math.PI);
    for (const l of [this.lights.sunShadowed, this.lights.sunPlain]) {
      l.position.copy(sun).multiplyScalar(5);
      l.intensity = 1;
    }

    // Planet glow.
    const pg = s.planetGlow;
    if (pg && pg.intensity > 0) {
      const pd = pg.dirLocal.clone().normalize();
      u.planetDir.value.copy(pd);
      u.planetColor.value.copy(pg.color).multiplyScalar(pg.intensity * Math.PI * comp);
      for (const l of [this.lights.planetShadowed, this.lights.planetPlain]) l.position.copy(pd).multiplyScalar(5);
    } else {
      u.planetColor.value.setRGB(0, 0, 0);
    }

    // Soft interior ambient, lifted a little by sunlight bouncing around the cabin.
    const eyeSun = canopyTransmission([0, -0.25, -0.35], [sun.x, sun.y, sun.z] as V3, 0.0047);
    const bounce = Math.min(0.6, sunI * eyeSun * 0.05);
    this.lights.hemi.intensity = (0.05 + bounce) * comp * Math.PI;
    // Instrument glow on nearby surfaces follows the panel colour.
    this.lights.glows.forEach((l, i) => {
      l.color.copy(u.accent.value);
      l.intensity = (i === 0 ? 0.05 : 0.03) * gain;
    });

    // Attitude display markers: polar plot centred on forward, radius = angle from forward.
    const A = LAYOUT.attitude;
    const place = (d: THREE.Vector3, out: THREE.Vector3, vis: number): void => {
      const ang = Math.acos(Math.min(1, Math.max(-1, -d.z)));
      const roll = Math.atan2(d.x, d.y);
      const deg = ang / (Math.PI / 180);
      const r = deg <= 90 ? (A.r90 * deg) / 90 : A.r90 + ((A.rMax - 4 - A.r90) * (deg - 90)) / 90;
      out.set(A.cx + Math.sin(roll) * r, A.cy - Math.cos(roll) * r, vis);
    };
    place(sun, u.sunMarker.value, s.sunIntensity > 0 ? 1 : 0.35);
    if (pg && pg.intensity > 0) place(pg.dirLocal.clone().normalize(), u.planetMarker.value, 1);
    else u.planetMarker.value.set(0, 0, 0);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** Static draw-call and triangle counts of the cockpit pass. */
  stats(): CockpitStats {
    let drawCalls = 0;
    let triangles = 0;
    if (!this.group.visible) return { drawCalls, triangles };
    for (const m of this.meshes) {
      if (!m.visible) continue;
      drawCalls++;
      triangles += triangleCount(m.geometry);
    }
    return { drawCalls, triangles };
  }

  dispose(): void {
    this.group.removeFromParent();
    const geos = new Set<THREE.BufferGeometry>(this.meshes.map((m) => m.geometry));
    for (const g of geos) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    for (const l of this.lights.objects) if (l instanceof THREE.Light) l.dispose();
    this.meshes.length = 0;
  }
}
