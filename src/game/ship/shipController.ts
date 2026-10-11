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
  /** Head-look rotation relative to the ship (cockpit view). */
  readonly headLook = new THREE.Quaternion();

  constructor(private readonly app: App) {
    this.ship = new Ship({ anchor: app.cam.pos.anchor, offset: app.cam.pos.offset.clone() }, app.cam.quat);
    // Start with the velocity of the surface frame so the opening view is calm.
    const anchor = app.sys.byId.get(this.ship.pos.anchor)!;
    this.ship.vel.copy(Ship.bodyOmega(anchor, app.simTime).cross(this.ship.pos.offset));
    this.hud = new Hud(document.body);
    this.input = new KeyboardControls(app.canvas);
  }

  /** Bodies sorted by angle from a view direction. */
  private candidates(dir: Vec3d): { id: string; angle: number }[] {
    return this.app.sys.views
      .map((v) => {
        const d = v.rel.length();
        return { id: v.def.id, angle: Math.acos(Math.max(-1, Math.min(1, v.rel.dot(dir) / Math.max(d, 1)))) };
      })
      .sort((a, b) => a.angle - b.angle);
  }

  /** Auto-align: rotate the nose toward the target (toggle with Y). */
  autoAlign = false;

  private alignToTarget(dt: number, app: App): boolean {
    if (!this.targetId) return false;
    if (!app.sys.byId.has(this.targetId)) return false;
    const dir = app.sys.bodyRelative(this.targetId, this.ship.pos, app.simTime, new Vec3d()).normalize();
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
    if (this.autoAlign) {
      c.pitch = 0;
      c.yaw = 0;
      this.alignToTarget(dt, app);
    }
    ship.update(dt, c, app.sys, app.simTime);

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
    const sun = sys.views.find((v) => v.def.kind === 'star')!;
    const target = this.targetId ? sys.byId.get(this.targetId) : undefined;
    // Velocity relative to the reference frame the HUD reports.
    let velDir: Vec3d | null = null;
    const anchor = sys.byId.get(ship.pos.anchor)!;
    const frameVel = ship.mode === 'thrusters' ? Ship.bodyOmega(anchor, app.simTime).cross(ship.pos.offset) : new Vec3d();
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
    const state: HudState = {
      mode: ship.mode,
      throttle: ship.throttle,
      speed: ship.mode === 'thrusters' ? tel.surfaceSpeed : tel.speed,
      speedLabel: ship.mode === 'thrusters' ? 'surface' : 'drive',
      governorSpeed: tel.governorSpeed,
      altitude: tel.agl,
      verticalSpeed: tel.verticalSpeed,
      nearName: t(`body.${tel.near}`),
      flightAssist: ship.flightAssist,
      landed: ship.landed,
      velocityDir: velDir,
      target: target
        ? {
            id: target.def.id,
            name: t(`body.${target.def.key}`),
            rel: target.rel,
            radius: target.def.radiusM,
            provenance: target.def.provenance,
            kind: target.def.kind,
          }
        : null,
      labels,
      utc: new Date(tdbSecondsSinceJ2000ToUnixMs(app.simTime)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      sunDistance: sun.rel.length(),
      warnings,
      footer: '',
    };
    this.hud.update(state, app.frame.camera);
  }

  private dropMsgUntil = 0;
}
