/**
 * Application shell: boots the renderer and world, runs the frame loop, owns the camera state and the HUD.
 * Controllers (free camera now, the ship in M2) move `state.cam`; the world is drawn camera-relative.
 */
import * as THREE from 'three/webgpu';
import { SPEED_OF_LIGHT_M_PER_S } from '../core/constants';
import { unixMsToTdbSecondsSinceJ2000, tdbSecondsSinceJ2000ToUnixMs } from '../core/time';
import { Vec3d } from '../core/vec3d';
import { createRenderer, effectiveDepthMode, type BackendRequest, type DepthMode, type RendererInfo } from '../render/bootstrap';
import { FrameRenderer } from '../render/frameRenderer';
import { Starfield } from '../render/starfield';
import { StarCatalog } from '../world/starCatalog';
import { MapView } from './map/mapView';
import { Settings, type SettingsData } from './settings/settings';
import { InputManager } from './input/inputManager';
import { SettingsPanel } from './ui/settingsPanel';
import { Captions } from './ui/captions';
import { AudioEngine } from './audio/audioEngine';
import { Cockpit } from '../render/cockpit/cockpit';
import { PARSEC_M } from '../core/constants';
import { loadBodies } from '../world/catalog';
import { Ephemeris } from '../world/ephemeris';
import { ChunkWorkerPool } from '../world/planet/workerPool';
import { SolarSystem, type SystemPos } from '../world/solarSystem';
import { formatDistance, formatDuration, formatSpeed } from './format';
import { t } from './i18n';
import { above, facing, subSolar, type Placement } from './views';

export interface CameraState {
  pos: SystemPos;
  quat: THREE.Quaternion;
  /** Velocity relative to the anchor body (m/s), for the HUD. */
  speed: number;
}

export interface Controller {
  /** True when the controller keeps the camera anchored itself (the ship re-anchors with velocity). */
  readonly managesAnchor?: boolean;
  update(dt: number, app: App): void;
  /** Optional per-frame HUD/overlay update after the world has been positioned. */
  updateHud?(app: App): void;
  /** Called when the App teleports the camera (named views, share links). */
  onPlace?(app: App): void;
}

/** Fixed seed for the generative score, so every player hears the same piece (see docs/DECISIONS.md D-033). */
const SCORE_SEED = 7;

export class App {
  readonly params = new URLSearchParams(location.search);
  renderer!: THREE.WebGPURenderer;
  info!: RendererInfo;
  frame!: FrameRenderer;
  sys!: SolarSystem;
  pool!: ChunkWorkerPool;
  readonly stars = new Starfield();
  catalog: StarCatalog | null = null;
  map: MapView | null = null;
  reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  depthMode: DepthMode = 'reversed';
  /** Simulation time, TDB seconds since J2000. */
  simTime = 0;
  timeScale = 1;
  cam: CameraState = { pos: { anchor: '399', offset: new Vec3d(7e6, 0, 0) }, quat: new THREE.Quaternion(), speed: 0 };
  controller: Controller | null = null;
  readonly hud: HTMLElement;
  private last = performance.now();
  private frameMs = 16;
  private readonly frameTimes: number[] = [];
  private hudTimer = 0;
  paused = false;

  /** Player settings (accessibility, audio, graphics, bindings), persisted in localStorage. */
  readonly settings = new Settings();
  readonly input: InputManager;
  readonly panel: SettingsPanel;
  readonly captions: Captions;
  readonly audio: AudioEngine;
  cockpit: Cockpit | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.hud = document.getElementById('hud')!;
    this.settings.applyToDocument();
    this.input = new InputManager(canvas, this.settings);
    this.panel = new SettingsPanel(this.settings, this.input);
    this.captions = new Captions(this.settings);
    this.audio = new AudioEngine({ seed: SCORE_SEED, onCaption: (key, secs) => this.captions.show(key, secs) });
    this.reducedMotion = this.settings.data.reducedMotion;
    // Browsers only start audio from a user gesture.
    const unlock = (): void => {
      void this.audio.unlock().then(() => {
        if (!this.audio.unlocked) return;
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
      });
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    canvas.addEventListener('click', () => {
      if (!this.map?.isOpen && !this.panel.isOpen && this.params.get('lock') !== '0') this.input.requestPointerLock();
    });
    this.settings.onChange((_, changed) => this.applySettings(changed));
  }

  /** Show or hide the cockpit model (the HUD layout adapts via a body class). */
  setCockpitVisible(v: boolean): void {
    const on = v && this.cockpit !== null;
    if (this.frame) this.frame.cockpitEnabled = on;
    document.body.classList.toggle('ks-cockpit-on', on);
  }

  /** Push settings to the systems that use them (all of them when `changed` is omitted). */
  applySettings(changed?: ReadonlySet<keyof SettingsData>): void {
    const d = this.settings.data;
    const has = (k: keyof SettingsData): boolean => !changed || changed.has(k);
    if (has('reducedMotion')) this.reducedMotion = d.reducedMotion;
    if (has('fovDeg') && this.frame) this.frame.setFov(d.fovDeg);
    if (has('volumes')) this.audio.setVolumes(d.volumes);
    if (has('showFps')) this.hud.style.display = d.showFps || this.params.get('free') === '1' ? 'block' : '';
  }

  progress(msg: string): void {
    const el = document.getElementById('boot-status');
    if (el) el.textContent = msg;
  }

  async boot(): Promise<void> {
    const backend = (this.params.get('backend') ?? 'auto') as BackendRequest;
    const requested = (this.params.get('depth') ?? 'reversed') as DepthMode;
    this.progress(t('boot.loading', { item: 'renderer' }));
    const created = await createRenderer(this.canvas, backend, requested);
    this.renderer = created.renderer;
    this.info = created.info;
    this.depthMode = effectiveDepthMode(requested, this.info);
    this.frame = new FrameRenderer(this.renderer, { depthMode: this.depthMode, msaaSamples: this.params.get('msaa') === '0' ? 0 : 4 });
    this.frame.bloomStrength.value = Number(this.params.get('bloom') ?? 0.5);
    if (this.params.get('cockpit') !== '0') {
      this.cockpit = new Cockpit({ quality: this.settings.data.quality === 'low' ? 'low' : 'high' });
      this.frame.cockpitScene.add(this.cockpit.group);
    }
    this.setCockpitVisible(this.cockpit !== null);
    this.applySettings();
    const resize = (): void => this.frame.resize(innerWidth, innerHeight);
    window.addEventListener('resize', resize);
    resize();

    this.progress(t('boot.loading', { item: 'ephemeris' }));
    const [eph, bodies] = await Promise.all([Ephemeris.load(), loadBodies()]);
    const tParam = this.params.get('t');
    const startMs = tParam ? Date.parse(tParam) : Date.now();
    this.simTime = eph.clampTime(unixMsToTdbSecondsSinceJ2000(startMs));
    this.progress(t('boot.loading', { item: 'stars' }));
    await this.stars.load();
    this.frame.backgroundScene.add(this.stars.group);
    this.catalog = new StarCatalog(this.stars.positions, this.stars.absMags);
    await this.catalog.load();
    this.pool = new ChunkWorkerPool();
    this.sys = await SolarSystem.create(eph, bodies, this.pool, this.frame, (name) => this.progress(t('boot.loading', { item: name })));
    const catalog = this.catalog;
    this.sys.externalAnchor = (anchor, time, out) => {
      if (anchor === 'ism') return out.set(0, 0, 0);
      if (anchor.startsWith('*') && catalog) {
        return catalog.positionM(Number(anchor.slice(1)), out).add(eph.ssb('10', time, new Vec3d()));
      }
      return null;
    };
    // One update so lighting/rotation are known before placing the camera.
    this.sys.update(this.cam.pos, this.simTime, this.pxPerRadian());
    this.place(this.view(this.params.get('view') ?? 'leo'));
    document.getElementById('boot')?.classList.add('hidden');
    // Large, non-essential assets stream in after the first frame.
    void this.stars.loadMilkyWay().catch((e: unknown) => console.warn('Milky Way map failed to load', e));
  }

  pxPerRadian(): number {
    const h = this.renderer.domElement.height || innerHeight;
    return h / THREE.MathUtils.degToRad(this.frame.camera.fov);
  }

  place(p: Placement): void {
    this.cam.pos = p.pos;
    this.cam.quat.copy(p.quat);
    this.controller?.onPlace?.(this);
  }

  /** Named placements (also used by tests). */
  view(name: string): Placement {
    const s = this.sys;
    const [eLat, eLon] = subSolar(s, '399');
    const [mLat, mLon] = subSolar(s, '301');
    switch (name) {
      case 'earth-disk':
        return facing(s, '399', 4.2e7, 35, 12);
      case 'earth-low':
        return above(s, '399', 27.99, 86.93 - 0.6, 9000, 90, -4); // west of Everest, looking east
      case 'earth-sunset':
        return above(s, '399', eLat * 0.3, eLon + 84, 2500, 90, 2);
      case 'moon-orbit':
        return above(s, '301', mLat + 10, mLon - 35, 120_000, 90, -25);
      case 'moon-surface':
        return above(s, '301', mLat + 20, mLon - 50, 60, 90, -6);
      case 'earthrise': {
        // Stand near the limb as seen from Earth (lon ±85) on whichever side is sunlit, looking toward lon 0.
        const east = Math.cos(((85 - mLon) * Math.PI) / 180) > Math.cos(((-85 - mLon) * Math.PI) / 180);
        return above(s, '301', 0, east ? 86 : -86, 2500, east ? 270 : 90, 4);
      }
      case 'mars':
        return facing(s, '499', 2.2e7, 30, 10);
      case 'jupiter':
        return facing(s, '599', 4.5e8, 25, 8);
      case 'saturn':
        return facing(s, '699', 6.0e8, 30, 22);
      case 'sun':
        return facing(s, '10', 6e9, 20, 5);
      case 'leo':
        return above(s, '399', eLat * 0.5, eLon - 55, 420_000, 70, -18);
      default: {
        // "body:<id>": a sunlit three-quarter view of any loaded body from 3.5 radii.
        const id = name.startsWith('body:') ? name.slice(5) : '';
        const v = s.byId.get(id);
        if (v) return facing(s, id, v.def.radiusM * 3.5, 30, 10);
        return above(s, '399', eLat * 0.5, eLon - 55, 420_000, 70, -18);
      }
    }
  }

  start(): void {
    const loop = (): void => {
      this.tick();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** Advance and render one frame. Public so tests can render synchronously. */
  tick(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.frameMs = this.frameMs * 0.9 + (now - this.last) * 0.1;
    this.frameTimes.push(now - this.last);
    if (this.frameTimes.length > 240) this.frameTimes.shift();
    this.last = now;
    this.input.update(dt);
    if (this.input.justPressed('pause')) {
      if (this.map?.isOpen) this.map.close();
      else this.panel.open();
    }
    if (this.input.justPressed('toggleMap') && this.map) {
      if (!this.map.isOpen) this.input.releasePointerLock();
      this.map.toggle();
    }
    const paused = this.paused || this.panel.isOpen;
    if (!paused) this.simTime = this.sys.ephemeris.clampTime(this.simTime + dt * this.timeScale);
    if (this.map?.isOpen) {
      this.map.render();
      return;
    }
    if (!paused) this.controller?.update(dt, this);
    this.renderFrame();
    if (this.settings.data.showFps && this.controller?.updateHud) {
      this.hudTimer -= dt;
      if (this.hudTimer <= 0) {
        this.hudTimer = 0.25;
        this.updateHud();
      }
    }
    if (this.controller?.updateHud) this.controller.updateHud(this);
    else {
      this.hudTimer -= dt;
      if (this.hudTimer <= 0) {
        this.hudTimer = 0.1;
        this.updateHud();
      }
    }
  }

  renderFrame(): void {
    // Keep the anchor on the dominant body so offsets stay small where precision matters.
    if (!this.controller?.managesAnchor) {
      const dom = this.sys.dominantBody(this.cam.pos, this.simTime);
      if (dom !== this.cam.pos.anchor) this.cam.pos = this.sys.reanchor(this.cam.pos, dom, this.simTime);
    }
    this.sys.update(this.cam.pos, this.simTime, this.pxPerRadian());
    this.frame.camera.quaternion.copy(this.cam.quat);
    this.frame.camera.position.set(0, 0, 0);
    this.updateExposure();
    this.updateSky();
    this.frame.render();
  }

  private exposureState = -1;
  private skyVisibility = 1;

  /**
   * Stars and the Milky Way keep a constant apparent brightness through eye adaptation (gain / exposure), dimmed when
   * the camera is inside a sunlit atmosphere (daytime sky) or when a bright body fills the view.
   */
  private updateSky(): void {
    const camSsb = this.sys.toSsb(this.cam.pos, this.simTime, new Vec3d());
    const sunSsb = this.sys.ephemeris.ssb('10', this.simTime, new Vec3d());
    this.stars.camPc.value.set((camSsb.x - sunSsb.x) / PARSEC_M, (camSsb.y - sunSsb.y) / PARSEC_M, (camSsb.z - sunSsb.z) / PARSEC_M);
    let v = 1;
    const [near, alt] = this.sys.nearest(this.cam.pos, this.simTime);
    const atm = near.def.atmosphere;
    if (atm && alt < atm.heightM) {
      const up = near.rel.clone().scale(-1).normalize();
      const s = near.uniforms.sunDir.value;
      const elev = up.x * s.x + up.y * s.y + up.z * s.z;
      const day = Math.min(1, Math.max(0, (elev + 0.12) / 0.17));
      const density = Math.exp(-Math.max(0, alt) / atm.rayleighScaleHeightM);
      v *= 1 - 0.985 * Math.min(1, density * day * 4);
    }
    const cover = Math.min(1, near.angularRadiusPx / (this.renderer.domElement.height * 0.5));
    v *= 1 - 0.5 * cover;
    this.skyVisibility += (v - this.skyVisibility) * 0.1;
    const inv = 1 / Math.max(this.frame.exposure.value, 1e-3);
    this.stars.gain.value = this.skyVisibility * inv * 0.6;
    this.stars.skyGain.value = this.skyVisibility * inv * 0.6;
    this.stars.viewport.value.set(this.renderer.domElement.width, this.renderer.domElement.height);
    this.stars.setPlanets(this.sys.pointSources());
  }

  /**
   * Eye adaptation: compensate most of the inverse-square fall-off of sunlight, then adapt toward the reflectance of
   * a body that fills the view (a camera exposes the Moon's dark regolith brighter than Earth's clouds). Smoothed.
   */
  private updateExposure(dt = 1 / 60): void {
    const sun = this.sys.primaryStar(this.cam.pos, this.simTime);
    const irr = ((sun.def.luminositySun ?? 1) * 1.495978707e11 ** 2) / Math.max(sun.rel.length(), 1e6) ** 2;
    let target = Math.pow(irr, -0.8);
    const [near] = this.sys.nearest(this.cam.pos, this.simTime);
    if (near.def.kind !== 'star') {
      const cover = Math.min(1, near.angularRadiusPx / (this.renderer.domElement.height * 0.5));
      // Surface maps are calibrated to the measured geometric albedo (bodies.py), so adapt to that directly.
      const refl = Math.max(0.03, near.def.geometricAlbedo);
      const k = Math.min(1.6, Math.max(0.7, 0.22 / refl));
      target *= 1 + (k - 1) * cover;
    }
    target = Math.min(80, Math.max(0.002, target)) * 1.15;
    const tau = 0.6;
    this.exposureState = this.exposureState < 0 ? target : this.exposureState + (target - this.exposureState) * (1 - Math.exp(-dt / tau));
    this.frame.exposure.value = this.exposureState;
  }

  updateHud(): void {
    const [near, alt] = this.sys.nearest(this.cam.pos, this.simTime);
    const sun = this.sys.primaryStar(this.cam.pos, this.simTime);
    const dSun = sun.rel.length();
    const utc = new Date(tdbSecondsSinceJ2000ToUnixMs(this.simTime)).toISOString().replace('T', ' ').slice(0, 19);
    const surf = this.sys.surfaceHeightBelow(near, this.cam.pos, this.simTime);
    const rows: [string, string][] = [
      [t('hud.near'), t(`body.${near.def.key}`)],
      [t('hud.altitude'), formatDistance(alt - surf)],
      [t('hud.speed'), formatSpeed(this.cam.speed)],
      [t('hud.sunDistance'), `${formatDistance(dSun)} · ${t('hud.lightTime')} ${formatDuration(dSun / SPEED_OF_LIGHT_M_PER_S)}`],
      [t('hud.utc'), utc],
      [t('hud.backend'), `${this.info.backend} · ${this.depthMode} · ${t('hud.fps', { v: Math.round(1000 / this.frameMs) })}`],
    ];
    this.hud.innerHTML = rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  }

  stats(): Record<string, unknown> {
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const pct = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    return {
      backend: this.info.backend,
      depthMode: this.depthMode,
      adapter: this.info.adapter,
      drawCalls: this.frame.stats.drawCalls,
      triangles: this.frame.stats.triangles,
      partitions: this.frame.stats.partitions,
      frameMsP50: pct(0.5),
      frameMsP95: pct(0.95),
      pendingChunks: this.pool.pending,
      anchor: this.cam.pos.anchor,
    };
  }
}
