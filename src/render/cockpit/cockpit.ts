/**
 * The player's cockpit: a procedural sleek sci-fi interior drawn in FrameRenderer's cockpit pass (cockpitScene +
 * cockpitCamera, after the world with a depth clear, so the cockpit is always in front and the canopy glass blends over
 * the world).
 *
 * Conventions: ship-local axes -Z forward, +Y up, +X right; the pilot's eye is at the origin; metres. Add `group` to
 * the cockpit scene at the origin without rotation; head look rotates the cockpit camera, never the group.
 *
 * Brightness: CockpitState.sunIntensity is display-referred (already exposure-adjusted). FrameRenderer multiplies the
 * whole HDR buffer, cockpit included, by its exposure, so the cockpit must undo that: call
 * `bindExposure(frame.exposure)` once (the cockpit then follows the exposure every frame), or set
 * `exposureCompensation = 1 / exposure` yourself before each `update()`. In development builds the cockpit warns once
 * if neither happened.
 *
 * Localisation: display labels are drawn into a texture with t(). After changing the locale, call `relocalize()`.
 */
import * as THREE from 'three/webgpu';
import { buildCockpitGeometry, triangleCount, type CockpitGeometry, type PanelKind } from './geometry';
import { glassTexture } from './glassTexture';
import { LAYOUT, MODE_KEYS, drawDisplayAtlas, type DisplayAtlas } from './displayAtlas';
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
import { attitudeMarker, clamp01, panelLook } from './state';

export type FlightMode = 'thrusters' | 'impulse' | 'cruise' | 'hyperspeed';

export interface CockpitState {
  time: number;
  throttle: number /*0..1*/;
  speedFraction: number /*0..1 of mode max*/;
  mode: FlightMode;
  sunDirLocal: THREE.Vector3 /*unit vector toward the Sun in ship-local axes*/;
  sunIntensity: number /*0..~3, already exposure-adjusted*/;
  /** Colour of the star's light relative to sunlight at equal luminance (planetShading.starlightTint); default white. */
  sunTint?: THREE.Color;
  planetGlow: { dirLocal: THREE.Vector3; color: THREE.Color; intensity: number } | null;
  alert: number /*0..1*/;
  reducedMotion: boolean;
}

export interface CockpitStats {
  /** Draw calls the cockpit pass issues (visible meshes; every cockpit material is single pass). */
  drawCalls: number;
  triangles: number;
}

/** Anything holding the renderer's current exposure (FrameRenderer.exposure is a TSL uniform with `.value`). */
export interface ExposureSource {
  readonly value: number;
}

const SUN_COLOR = new THREE.Color(1.0, 0.97, 0.92);

const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

export class Cockpit {
  readonly group: THREE.Group;
  /** Overall instrument brightness (user setting). */
  panelBrightness = 1;
  /** Milliseconds the constructor took (geometry, textures, materials). */
  readonly buildMs: number;

  private compensation = 1;
  private compensationSet = false;
  private exposureSource: ExposureSource | null = null;
  private warned = false;
  /** The state of the last update(), so a rebuilt cockpit can take over without a frame of default uniforms. */
  private lastState: CockpitState | null = null;
  private readonly u = new CockpitUniforms();
  private readonly lights: CockpitLights;
  private readonly geo: CockpitGeometry;
  private readonly atlasScale: number;
  private readonly atlas: DisplayAtlas;
  private readonly atlasTexture: THREE.CanvasTexture;
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly meshes: THREE.Mesh[] = [];
  private readonly sun = new THREE.Vector3();
  private readonly planet = new THREE.Vector3();

  constructor(opts?: { quality?: 'low' | 'high' }) {
    const t0 = performance.now();
    const quality = opts?.quality ?? 'high';
    this.group = new THREE.Group();
    this.group.name = 'cockpit';
    this.geo = buildCockpitGeometry(quality);
    const g = this.geo;
    const u = this.u;

    this.lights = createLights(u, g.glowAnchors);
    for (const o of this.lights.objects) this.group.add(o);

    // Textures generated in code.
    const wearData = glassTexture(quality === 'high' ? 1024 : 512);
    const wear = new THREE.DataTexture(wearData.data, wearData.size, wearData.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    wear.wrapS = THREE.RepeatWrapping;
    wear.wrapT = THREE.RepeatWrapping;
    wear.generateMipmaps = true;
    wear.minFilter = THREE.LinearMipmapLinearFilter;
    wear.magFilter = THREE.LinearFilter;
    wear.anisotropy = 4;
    wear.colorSpace = THREE.NoColorSpace;
    wear.needsUpdate = true;
    this.atlasScale = quality === 'high' ? 1 : 0.5;
    this.atlas = drawDisplayAtlas(this.atlasScale);
    const atlas = new THREE.CanvasTexture(this.atlas.canvas);
    // Row 0 of the canvas is v = 0 (the panel shaders use canvas coordinates); the data is not colour.
    atlas.flipY = false;
    atlas.premultiplyAlpha = false;
    atlas.generateMipmaps = true;
    atlas.minFilter = THREE.LinearMipmapLinearFilter;
    atlas.magFilter = THREE.LinearFilter;
    atlas.anisotropy = 8;
    atlas.colorSpace = THREE.NoColorSpace;
    atlas.needsUpdate = true;
    this.atlasTexture = atlas;
    this.textures.push(wear, atlas);
    this.applyPercentLayout();

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
    // Transparent layers, back to front: the canopy glass (the farthest surface), then the holo panes, which always
    // float inside the canopy and so in front of the glass.
    const sources = g.panels.map((p) => ({
      x: p.center.x,
      z: p.center.z,
      halfW: p.width / 2,
      halfD: (p.height / 2) * Math.max(0.2, Math.abs(p.normal.y)),
      weight: p.type === 'holo' ? 0.9 : 1,
    }));
    add(g.glass, glassMaterial(u, wear, sources), 'glass', 5);
    for (const p of g.panels) {
      if (p.type === 'holo') add(p.geometry, holoMaterial(p.kind, atlas, u), `holo.${p.kind}`, 10);
    }
    this.buildMs = performance.now() - t0;
  }

  /**
   * Multiplier on interior lighting and panel emission that undoes FrameRenderer's exposure (1 / exposure). Prefer
   * `bindExposure()`, which keeps it in step automatically.
   */
  get exposureCompensation(): number {
    return this.compensation;
  }

  set exposureCompensation(v: number) {
    this.compensation = Number.isFinite(v) && v > 0 ? v : 1;
    this.compensationSet = true;
  }

  /** Follow a renderer exposure (e.g. FrameRenderer.exposure): each update() uses 1 / source.value. */
  bindExposure(source: ExposureSource | null): void {
    this.exposureSource = source;
  }

  /** Physical panels (for tests and tooling). */
  get panelKinds(): PanelKind[] {
    return this.geo.panels.map((p) => p.kind);
  }

  /** The display atlas canvas (debug tooling: R primary art, G glow, B secondary art). */
  get atlasCanvas(): HTMLCanvasElement {
    return this.atlas.canvas;
  }

  /** Redraw the display labels after a locale change (i18n setLocale). */
  relocalize(): void {
    const next = drawDisplayAtlas(this.atlasScale, this.atlas.canvas);
    this.atlas.percent = next.percent;
    this.applyPercentLayout();
    this.atlasTexture.needsUpdate = true;
  }

  private applyPercentLayout(): void {
    this.u.pctBefore.value = this.atlas.percent.before ? 1 : 0;
    this.u.pctGap.value = this.atlas.percent.gap ? 0.35 : 0;
  }

  /**
   * Take over from the cockpit this one replaces (a rebuild at another quality level): its brightness, its exposure
   * binding or compensation, and its last state, so the first frame drawn with this one already looks the same.
   */
  continueFrom(prev: Cockpit): void {
    this.panelBrightness = prev.panelBrightness;
    this.exposureSource = prev.exposureSource;
    if (prev.compensationSet) this.exposureCompensation = prev.compensation;
    if (prev.lastState) this.update(0, prev.lastState);
  }

  update(_dt: number, s: CockpitState): void {
    this.lastState = s;
    const u = this.u;
    if (this.exposureSource) {
      const e = this.exposureSource.value;
      this.compensation = Number.isFinite(e) && e > 0 ? 1 / e : 1;
    } else if (!this.compensationSet && !this.warned && import.meta.env.DEV) {
      this.warned = true;
      console.warn('Cockpit: no exposure source bound; call bindExposure(frame.exposure) so the instruments ignore the world exposure.');
    }
    const comp = this.compensation;
    const time = finiteOr(s.time, 0);
    u.time.value = time;
    u.throttle.value = clamp01(finiteOr(s.throttle, 0));
    u.speed.value = clamp01(finiteOr(s.speedFraction, 0));
    u.mode.value = Math.max(0, MODE_KEYS.indexOf(s.mode));
    const alert = clamp01(finiteOr(s.alert, 0));
    u.alert.value = alert;
    u.still.value = s.reducedMotion ? 1 : 0;
    u.gain.value = comp;

    // Panel colour: the accent until an alert, then amber shading to red with a pulse (steady under reduced motion).
    const look = panelLook(alert, time, s.reducedMotion);
    u.accent.value.setRGB(...look.emission);
    const gain = comp * this.panelBrightness * look.gain;
    u.panelGain.value = gain;

    // Sun.
    const sun = this.sun.copy(s.sunDirLocal);
    if (!(sun.lengthSq() > 1e-12) || !Number.isFinite(sun.lengthSq())) sun.set(0, 0, -1);
    sun.normalize();
    u.sunDir.value.copy(sun);
    const sunDisplay = Math.max(0, finiteOr(s.sunIntensity, 0));
    const sunI = sunDisplay * comp;
    u.sunI.value = sunI;
    u.sunColor.value.copy(SUN_COLOR).multiplyScalar(sunI * Math.PI);
    if (s.sunTint) u.sunColor.value.multiply(s.sunTint);
    for (const l of [this.lights.sunShadowed, this.lights.sunPlain]) {
      l.position.copy(sun).multiplyScalar(5);
      l.intensity = 1;
    }

    // Planet glow.
    const pg = s.planetGlow;
    const pd = pg ? this.planet.copy(pg.dirLocal) : null;
    const planetOn = pg !== null && pd !== null && pg.intensity > 0 && pd.lengthSq() > 1e-12;
    if (planetOn) {
      pd.normalize();
      u.planetDir.value.copy(pd);
      u.planetColor.value.copy(pg.color).multiplyScalar(pg.intensity * Math.PI * comp);
      for (const l of [this.lights.planetShadowed, this.lights.planetPlain]) l.position.copy(pd).multiplyScalar(5);
    } else {
      u.planetColor.value.setRGB(0, 0, 0);
    }

    // Soft interior ambient, lifted a little by sunlight bouncing around the cabin (display-referred, so the
    // compensation is applied once, below).
    const eyeSun = canopyTransmission([0, -0.25, -0.35], [sun.x, sun.y, sun.z] as V3, 0.0047);
    const bounce = Math.min(0.6, sunDisplay * eyeSun * 0.05);
    this.lights.hemi.intensity = (0.05 + bounce) * comp * Math.PI;
    // Instrument glow on nearby surfaces follows the panel colour.
    this.lights.glows.forEach((l, i) => {
      l.color.setRGB(...look.light);
      l.intensity = (i === 0 ? 0.05 : 0.03) * gain;
    });

    // Attitude display markers: polar plot centred on the nose, radius = angle from the nose.
    const sm = attitudeMarker(sun, LAYOUT.attitude);
    u.sunMarker.value.set(sm ? sm[0] : 0, sm ? sm[1] : 0, s.sunIntensity > 0 ? 1 : 0.35);
    const pm = planetOn ? attitudeMarker(pd, LAYOUT.attitude) : null;
    if (pm) u.planetMarker.value.set(pm[0], pm[1], 1);
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
