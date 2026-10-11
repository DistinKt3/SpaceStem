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
import { KeyboardControls } from './keyboardControls';
import { Ship, type ShipControls } from './ship';
import { Hyperspeed } from './hyperspeed';
import { AU_M, PARSEC_M } from '../../core/constants';
import type { Provenance } from '../../core/provenance';
import { inferStar } from '../../world/starCatalog';

export interface ControlSource {
  read(): ShipControls;
  endFrame(): void;
  pressed(code: string): boolean;
}

export class ShipController implements Controller {
  readonly ship: Ship;
  readonly hud: Hud;
  input: ControlSource;
  targetId: string | null = '301';
  readonly hyper = new Hyperspeed();
  readonly managesAnchor = true;
  /** Transient message (i18n key) shown in the HUD warning area. */
  private message: { key: string; until: number } | null = null;
  /** Head-look rotation relative to the ship (cockpit view). */
  readonly headLook = new THREE.Quaternion();

  constructor(private readonly app: App) {
    this.ship = new Ship({ anchor: app.cam.pos.anchor, offset: app.cam.pos.offset.clone() }, app.cam.quat);
    // Start with the velocity of the surface frame so the opening view is calm.
    const anchor = app.sys.byId.get(this.ship.pos.anchor);
    if (anchor && anchor.def.kind !== 'star') this.ship.vel.copy(Ship.bodyOmega(anchor, app.simTime).cross(this.ship.pos.offset));
    this.hud = new Hud(document.body);
    this.input = new KeyboardControls(app.canvas);
    this.hyper.onArrive = (anchor) => {
      // The destination star becomes a real, lit body; other visited stars are released.
      for (const v of [...app.sys.views]) if (v.def.id.startsWith('*') && v.def.id !== anchor) app.sys.removeBody(v.def.id, app.frame);
      if (anchor.startsWith('*') && app.catalog) void app.sys.addBody(app.catalog.bodyDef(Number(anchor.slice(1))), app.pool, app.frame);
    };
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

  update(dt: number, app: App): void {
    const c = this.input.read();
    const ship = this.ship;
    if (this.input.pressed('KeyY')) this.autoAlign = !this.autoAlign;
    if (this.input.pressed('KeyJ')) this.engageHyperspeed();
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
    if (this.input.pressed('KeyT')) this.targetId = this.candidates(fwd)[0]?.id ?? null;
    if (this.input.pressed('Tab')) {
      const list = this.candidates(fwd).slice(0, 8);
      const i = list.findIndex((x) => x.id === this.targetId);
      this.targetId = list[(i + 1) % list.length]?.id ?? null;
    }
    this.input.endFrame();

    // Camera = ship cockpit view.
    app.cam.pos = ship.pos;
    app.cam.quat.copy(ship.quat).multiply(this.headLook);
    app.cam.speed = ship.telemetry.speed;
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
  }

  private dropMsgUntil = 0;
}
