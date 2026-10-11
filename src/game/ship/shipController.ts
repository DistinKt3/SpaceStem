/**
 * Connects input, the ship's flight model, the camera and the HUD. Targeting: Tab cycles through bodies nearest the
 * view direction, T picks the body closest to the reticle.
 */
import * as THREE from 'three/webgpu';
import { Vec3d } from '../../core/vec3d';
import type { App, Controller } from '../app';
import { Hud, type HudLabel, type HudState } from '../hud/hud';
import { t } from '../i18n';
import { tdbSecondsSinceJ2000ToUnixMs } from '../../core/time';
import { FLIGHT, Ship, type ShipControls } from './ship';
import { SPEED_OF_LIGHT_M_PER_S } from '../../core/constants';
import type { AudioState } from '../audio/audioEngine';
import type { CockpitState } from '../../render/cockpit/cockpit';
import { POINT_COLORS } from '../../world/solarSystem';
import { Hyperspeed } from './hyperspeed';
import { AU_M, PARSEC_M } from '../../core/constants';
import type { Provenance } from '../../core/provenance';
import { inferStar } from '../../world/starCatalog';
import { MapView } from '../map/mapView';

/** Mouse steering gain (control units per CSS pixel of mouse movement). */
const MOUSE_STEER = 0.02;
/** Head look: radians per CSS pixel, and limits (the eye sits close to the headrest beyond ~140 degrees). */
const HEAD_LOOK_RAD_PER_PX = 0.003;
const HEAD_YAW_MAX = (140 * Math.PI) / 180;
const HEAD_PITCH_MAX = (75 * Math.PI) / 180;
/** Throttle step per throttleUp/throttleDown press (keys or mouse wheel notch). */
const THROTTLE_STEP = 0.05;
/** Relative surface air density used for wind sound (Earth = 1). Venus, Titan and the giants clamp to 1. */
const SURFACE_AIR: Record<string, number> = { earth: 1, mars: 0.0065, venus: 1, titan: 1 };

export class ShipController implements Controller {
  readonly ship: Ship;
  readonly hud: Hud;
  targetId: string | null = '301';
  readonly hyper = new Hyperspeed();
  readonly managesAnchor = true;
  /** Transient message (i18n key) shown in the HUD warning area. */
  private message: { key: string; until: number } | null = null;
  /** Head-look rotation relative to the ship (cockpit view). */
  readonly headLook = new THREE.Quaternion();
  private headYaw = 0;
  private headPitch = 0;
  /** Previous-frame state for audio cues. */
  private prev = { target: null as string | null, mode: '', landed: false, phase: 'idle', alert: false };
  private alert = 0;

  constructor(private readonly app: App) {
    this.ship = new Ship({ anchor: app.cam.pos.anchor, offset: app.cam.pos.offset.clone() }, app.cam.quat);
    // Start with the velocity of the surface frame so the opening view is calm.
    const anchor = app.sys.byId.get(this.ship.pos.anchor);
    if (anchor && anchor.def.kind !== 'star') this.ship.vel.copy(Ship.bodyOmega(anchor, app.simTime).cross(this.ship.pos.offset));
    this.hud = new Hud(document.body);
    const map = new MapView(app);
    map.onSelect = (id) => {
      if (id) this.targetId = id;
    };
    map.getSelected = () => this.targetId;
    app.map = map;
    this.hyper.onArrive = (anchor) => {
      // The destination star becomes a real, lit body; other visited stars are released.
      for (const v of [...app.sys.views]) if (v.def.id.startsWith('*') && v.def.id !== anchor) app.sys.removeBody(v.def.id, app.frame);
      if (anchor.startsWith('*') && app.catalog) void app.sys.addBody(app.catalog.bodyDef(Number(anchor.slice(1))), app.pool, app.frame);
    };
  }

  /** Teleport: the ship takes the App's new camera placement, at rest relative to the local surface frame. */
  onPlace(app: App): void {
    const ship = this.ship;
    this.hyper.abort();
    ship.resetFlight();
    ship.pos = { anchor: app.cam.pos.anchor, offset: app.cam.pos.offset.clone() };
    ship.quat.copy(app.cam.quat);
    this.headLook.identity();
    const anchor = app.sys.byId.get(ship.pos.anchor);
    ship.vel.set(0, 0, 0);
    if (anchor && anchor.def.kind !== 'star') ship.vel.copy(Ship.bodyOmega(anchor, app.simTime).cross(ship.pos.offset));
  }

  /** Camera-relative info for a body ("399") or catalog star ("*<index>"). */
  targetInfo(id: string): { name: string; rel: Vec3d; radius: number; provenance: Provenance; kind: string } | null {
    const app = this.app;
    const v = app.sys.byId.get(id);
    if (v) return { name: v.def.kind === 'star' && v.def.id !== '10' ? v.def.name : t(`body.${v.def.key}`), rel: v.rel, radius: v.def.radiusM, provenance: v.def.provenance, kind: v.def.kind };
    if (id.startsWith('*') && app.catalog) {
      const i = Number(id.slice(1));
      const camSsb = app.sys.toSsb(this.ship.pos, app.simTime, new Vec3d());
      const rel = app.catalog.positionM(i, new Vec3d()).add(app.sys.ephemeris.ssb('10', app.simTime, new Vec3d())).sub(camSsb);
      const inf = inferStar(app.catalog.absMags[i] ?? 5, app.catalog.info(i)?.bv ?? 0.65);
      return { name: app.catalog.name(i), rel, radius: inf.radiusM, provenance: 'measured', kind: 'star' };
    }
    return null;
  }

  /** Bodies and destination stars sorted by angle from a view direction. */
  private candidates(dir: Vec3d): { id: string; angle: number }[] {
    const app = this.app;
    const ids = app.sys.views.map((v) => v.def.id);
    if (app.catalog) {
      const camSsb = app.sys.toSsb(this.ship.pos, app.simTime, new Vec3d());
      const sun = app.sys.ephemeris.ssb('10', app.simTime, new Vec3d());
      const pc = camSsb.sub(sun).scale(1 / PARSEC_M);
      for (const i of app.catalog.destinations(pc, 31, 40)) ids.push(`*${i}`);
    }
    return ids
      .map((id) => {
        const info = this.targetInfo(id);
        if (!info) return { id, angle: 9 };
        const d = info.rel.length();
        return { id, angle: Math.acos(Math.max(-1, Math.min(1, info.rel.dot(dir) / Math.max(d, 1)))) };
      })
      .sort((a, b) => a.angle - b.angle);
  }

  /** Display name for a body key (catalog stars use their catalogue name). */
  private bodyName(key: string): string {
    const v = this.app.sys.views.find((x) => x.def.key === key);
    if (v && v.def.id.startsWith('*')) return v.def.name;
    return t(`body.${key}`);
  }

  private flash(key: string, seconds = 3): void {
    this.message = { key, until: performance.now() + seconds * 1000 };
  }

  /** Engage hyperspeed toward the current target star (or the Sun when far from it). */
  engageHyperspeed(): void {
    const app = this.app;
    const id = this.targetId;
    if (!id) return this.flash('hyper.error.noTarget');
    const isStar = id.startsWith('*') || id === '10';
    if (!isStar) return this.flash('hyper.error.notStar');
    const info = this.targetInfo(id);
    if (!info) return;
    const camSsb = app.sys.toSsb(this.ship.pos, app.simTime, new Vec3d());
    const targetSsb = camSsb.clone().add(info.rel);
    const lum = id === '10' ? 1 : inferStar(app.catalog!.absMags[Number(id.slice(1))] ?? 5, app.catalog!.info(Number(id.slice(1)))?.bv ?? 0.65).luminositySun;
    const arrival = Math.max(1.6 * Math.sqrt(lum) * AU_M, info.radius * 120);
    const err = this.hyper.engage(app.sys, this.ship, app.simTime, id, info.name, targetSsb, arrival);
    if (err) this.flash(err);
  }

  /** Auto-align: rotate the nose toward the target (toggle with Y). */
  autoAlign = false;

  private alignToTarget(dt: number): boolean {
    if (!this.targetId) return false;
    const info = this.targetInfo(this.targetId);
    if (!info) return false;
    const dir = info.rel.clone().normalize();
    // Keep the current roll as much as possible: rotate the current forward onto the target direction.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.ship.quat);
    const delta = new THREE.Quaternion().setFromUnitVectors(fwd, new THREE.Vector3(dir.x, dir.y, dir.z));
    const angle = 2 * Math.acos(Math.min(1, Math.abs(delta.w)));
    const step = Math.min(1, (1.2 * dt) / Math.max(angle, 1e-6));
    this.ship.quat.premultiply(new THREE.Quaternion().slerp(delta, step)).normalize();
    return angle < 0.002;
  }

  /** Ship controls from the InputManager (actions follow the player's bindings). Ship axes: +yaw = left, +roll = left. */
  private readControls(dt: number): ShipControls {
    const inp = this.app.input;
    const look = inp.held('headLook');
    const m = inp.mouseDelta();
    if (look) {
      this.headYaw = Math.max(-HEAD_YAW_MAX, Math.min(HEAD_YAW_MAX, this.headYaw - m.x * HEAD_LOOK_RAD_PER_PX));
      this.headPitch = Math.max(-HEAD_PITCH_MAX, Math.min(HEAD_PITCH_MAX, this.headPitch + m.y * HEAD_LOOK_RAD_PER_PX));
    } else {
      // Ease back to centre when released.
      const k = Math.exp(-dt * 6);
      this.headYaw *= k;
      this.headPitch *= k;
    }
    this.headLook.setFromEuler(new THREE.Euler(this.headPitch, this.headYaw, 0, 'YXZ'));
    const steps = inp.pressCount('throttleUp') - inp.pressCount('throttleDown');
    if (steps !== 0) this.ship.throttle = Math.max(-0.5, Math.min(1, this.ship.throttle + steps * THROTTLE_STEP));
    return {
      pitch: inp.axis('pitch') + (look ? 0 : m.y * MOUSE_STEER),
      yaw: -inp.axis('yaw') - (look ? 0 : m.x * MOUSE_STEER),
      roll: -inp.axis('roll'),
      throttleRate: inp.axis('thrust'),
      strafeX: inp.axis('strafeX'),
      strafeY: inp.axis('strafeY'),
      boost: inp.held('boost'),
      zeroThrottle: inp.justPressed('throttleZero'),
      modeNext: inp.justPressed('modeNext'),
      modePrev: inp.justPressed('modePrev'),
      toggleFlightAssist: inp.justPressed('flightAssist'),
    };
  }

  update(dt: number, app: App): void {
    const inp = app.input;
    const c = this.readControls(dt);
    const ship = this.ship;
    if (inp.justPressed('autoAlign')) this.autoAlign = !this.autoAlign;
    if (inp.justPressed('hyperspeed')) this.engageHyperspeed();
    if (inp.justPressed('toggleHud')) this.hud.setVisible(!this.hud.isVisible);
    if (inp.justPressed('toggleView')) app.setCockpitVisible(!app.frame.cockpitEnabled);
    if (this.autoAlign || this.hyper.active) {
      c.pitch = 0;
      c.yaw = 0;
      this.alignToTarget(dt);
    }
    if (this.hyper.phase === 'jump') this.hyper.update(dt, app.sys, ship, app.simTime);
    else {
      ship.update(dt, c, app.sys, app.simTime);
      this.hyper.update(dt, app.sys, ship, app.simTime);
    }
    const reduce = app.reducedMotion;
    app.stars.streak.value = this.hyper.streak * (reduce ? 0.15 : 1);
    const v = ship.forward();
    app.stars.velDir.value.set(v.x, v.y, v.z);

    // Targeting.
    const fwd = ship.forward();
    if (inp.justPressed('targetReticle')) this.targetId = this.candidates(fwd)[0]?.id ?? null;
    const cycle = (inp.justPressed('targetNext') ? 1 : 0) - (inp.justPressed('targetPrev') ? 1 : 0);
    if (cycle !== 0) {
      const list = this.candidates(fwd).slice(0, 8);
      const i = list.findIndex((x) => x.id === this.targetId);
      this.targetId = list[(i + cycle + list.length) % list.length]?.id ?? null;
    }

    // Camera = ship cockpit view.
    app.cam.pos = ship.pos;
    app.cam.quat.copy(ship.quat).multiply(this.headLook);
    app.cam.speed = ship.telemetry.speed;
    app.frame.cockpitCamera.quaternion.copy(this.headLook);
    this.updateAudio(dt);
  }

  /** Fraction of the current drive's top speed (log scale for cruise, which spans 2 km/s to 3,000c). */
  private speedFraction(): number {
    const ship = this.ship;
    const s = ship.telemetry.speed;
    switch (ship.mode) {
      case 'thrusters':
        return Math.min(1, ship.telemetry.surfaceSpeed / FLIGHT.thrustersMaxSpeed);
      case 'impulse':
        return Math.min(1, s / FLIGHT.impulseCap);
      case 'cruise':
        return Math.min(1, Math.max(0, Math.log(s / FLIGHT.minCruiseSpeed) / Math.log(FLIGHT.cruiseCap / FLIGHT.minCruiseSpeed)));
      default:
        return this.hyper.phase === 'jump' ? Math.min(1, this.hyper.speed / (1e6 * SPEED_OF_LIGHT_M_PER_S)) : 0;
    }
  }

  private updateAudio(dt: number): void {
    const app = this.app;
    const ship = this.ship;
    const tel = ship.telemetry;
    const [near, alt] = app.sys.nearest(ship.pos, app.simTime);
    const atm = near.def.atmosphere;
    const density = atm ? Math.min(1, (SURFACE_AIR[near.def.key] ?? 1) * Math.exp(-Math.max(0, alt) / atm.rayleighScaleHeightM)) : 0;
    const state: AudioState = {
      thrust: Math.min(1, Math.abs(tel.thrust)),
      rcs: Math.min(1, Math.abs(tel.rcs)),
      mode: ship.mode,
      speedFraction: this.speedFraction(),
      hyperspeed: this.hyper.spoolProgress,
      atmosphereDensity: density,
      airspeed: tel.surfaceSpeed,
      scoopHeat: 0,
      landed: ship.landed,
    };
    app.audio.update(dt, state);
    // One-shot cues on state changes.
    const p = this.prev;
    if (this.targetId !== p.target && this.targetId) app.audio.play('target-lock');
    if (p.mode && ship.mode !== p.mode && ship.mode !== 'hyperspeed' && p.mode !== 'hyperspeed') app.audio.play('mode-change');
    if (this.hyper.phase !== p.phase) {
      if (this.hyper.phase === 'spool') app.audio.play('hyperspeed-spool');
      else if (this.hyper.phase === 'jump') app.audio.play('hyperspeed-engage');
      else if (p.phase === 'jump') app.audio.play('hyperspeed-exit');
    }
    if (ship.landed && !p.landed) app.audio.play('landing-contact');
    const alert = this.alert > 0.5;
    if (alert && !p.alert) app.audio.play('alert');
    this.prev = { target: this.targetId, mode: ship.mode, landed: ship.landed, phase: this.hyper.phase, alert };
  }

  /** Called by the App after the world update (body positions are camera-relative and current). */
  updateHud(app: App): void {
    const ship = this.ship;
    const tel = ship.telemetry;
    const sys = app.sys;
    const sun = sys.primaryStar(ship.pos, app.simTime);
    const info = this.targetId ? this.targetInfo(this.targetId) : null;
    // Velocity relative to the reference frame the HUD reports.
    let velDir: Vec3d | null = null;
    const anchor = sys.byId.get(ship.pos.anchor);
    const frameVel =
      ship.mode === 'thrusters' && anchor && anchor.def.kind !== 'star' ? Ship.bodyOmega(anchor, app.simTime).cross(ship.pos.offset) : new Vec3d();
    const vRel = new Vec3d().subVectors(ship.vel, frameVel);
    if (vRel.length() > 0.5) velDir = vRel.normalize();
    const labels: HudLabel[] = sys.views
      .filter((v) => v.def.id !== this.targetId && v.angularRadiusPx < 400)
      .map((v) => ({ id: v.def.id, name: t(`body.${v.def.key}`), rel: v.rel, radius: v.def.radiusM }))
      .sort((a, b) => a.rel.length() - b.rel.length())
      .slice(0, 7);
    const warnings: string[] = [];
    if (ship.mode === 'thrusters' && !ship.landed && tel.agl < 300 && tel.verticalSpeed < -30) warnings.push(t('hud.warn.pullUp'));
    this.alert = warnings.length > 0 ? 1 : 0;
    if (tel.droppedOut) this.dropMsgUntil = performance.now() + 3000;
    if (performance.now() < this.dropMsgUntil) warnings.push(t('hud.warn.droppedOut'));
    if (this.message && performance.now() < this.message.until) warnings.push(t(this.message.key));
    if (this.hyper.phase === 'spool') warnings.push(t('hyper.spooling', { name: this.hyper.targetName }));
    const state: HudState = {
      mode: ship.mode,
      throttle: ship.throttle,
      speed: this.hyper.phase === 'jump' ? this.hyper.speed : ship.mode === 'thrusters' ? tel.surfaceSpeed : tel.speed,
      speedLabel: ship.mode === 'thrusters' ? 'surface' : 'drive',
      etaOverride: this.hyper.active ? this.hyper.etaSeconds : null,
      governorSpeed: tel.governorSpeed,
      altitude: tel.agl,
      verticalSpeed: tel.verticalSpeed,
      nearName: this.bodyName(tel.near),
      flightAssist: ship.flightAssist,
      landed: ship.landed,
      velocityDir: velDir,
      target: info && this.targetId ? { id: this.targetId, ...info } : null,
      labels,
      utc: new Date(tdbSecondsSinceJ2000ToUnixMs(app.simTime)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      sunDistance: sun.rel.length(),
      sunName: this.bodyName(sun.def.key),
      warnings,
      footer: this.hyper.phase === 'jump' ? t('hyper.eta', { s: Math.ceil(this.hyper.etaSeconds) }) : '',
    };
    this.hud.update(state, app.frame.camera);
    this.updateCockpit(app, sun.rel, sun.def.luminositySun ?? 1);
  }

  /** Drive the cockpit model: lighting from the local star and the nearest body, displays from the ship state. */
  private updateCockpit(app: App, sunRel: Vec3d, luminositySun: number): void {
    const cockpit = app.cockpit;
    if (!cockpit) return;
    const ship = this.ship;
    const exposure = Math.max(1e-3, app.frame.exposure.value);
    const toLocal = ship.quat.clone().invert();
    const local = (v: Vec3d): THREE.Vector3 => new THREE.Vector3(v.x, v.y, v.z).normalize().applyQuaternion(toLocal);
    const dSun = Math.max(sunRel.length(), 1);
    const irr = (luminositySun * AU_M * AU_M) / (dSun * dSun);
    // Sunlight is blocked when the nearest body sits between the ship and the star.
    const [near] = app.sys.nearest(ship.pos, app.simTime);
    let sunVis = 1;
    if (near.def.kind !== 'star') {
      const sDir = sunRel.clone().scale(1 / dSun);
      const tc = near.rel.dot(sDir);
      const miss = Math.sqrt(Math.max(0, near.rel.lengthSq() - tc * tc));
      if (tc > 0 && tc < dSun) sunVis = Math.min(1, Math.max(0, (miss - near.def.radiusM * 0.995) / (near.def.radiusM * 0.01)));
    }
    let planetGlow: CockpitState['planetGlow'] = null;
    if (near.def.kind !== 'star') {
      const d = Math.max(near.rel.length(), near.def.radiusM * 1.0001);
      const solid = 1 - Math.cos(Math.asin(Math.min(1, near.def.radiusM / d)));
      // Fraction of the visible disc that is sunlit (phase), seen from the ship.
      const toShip = near.rel.clone().scale(-1 / d);
      const lit = 0.5 + 0.5 * toShip.dot(sunRel.clone().sub(near.rel).normalize());
      const c = POINT_COLORS[near.def.key] ?? [230, 230, 230];
      planetGlow = {
        dirLocal: local(near.rel),
        color: new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255),
        intensity: Math.min(3, solid * lit * near.def.geometricAlbedo * irr * exposure * 2),
      };
    }
    cockpit.exposureCompensation = 1 / exposure;
    cockpit.update(1 / 60, {
      time: performance.now() / 1000,
      throttle: Math.abs(ship.throttle),
      speedFraction: this.speedFraction(),
      mode: ship.mode,
      sunDirLocal: local(sunRel),
      sunIntensity: Math.min(3, irr * exposure * sunVis),
      planetGlow,
      alert: this.alert,
      reducedMotion: app.reducedMotion,
    });
  }

  private dropMsgUntil = 0;
}
