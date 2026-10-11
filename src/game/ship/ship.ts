/**
 * The player's ship: state and flight model.
 *
 * Position is anchored to a body (SystemPos: anchor centre + float64 offset, ICRF axes); velocity is inertial,
 * relative to the anchor's centre. Ship-local axes: -Z forward, +Y up, +X right (same as the camera).
 *
 * Modes (the universe is real; the drive is fictional, see the Codex):
 * - thrusters: Newtonian with the anchor body's gravity. Flight assist (FA) holds a velocity setpoint relative to the
 *   rotating surface and cancels gravity, so hovering and landing are easy.
 * - impulse / cruise: the drive sets speed directly along the nose, limited by a governor proportional to the
 *   distance from the nearest surface (approaches decelerate smoothly). Gravity is ignored by the drive.
 * - hyperspeed: interstellar travel (handled by the hyperspeed controller).
 */
import * as THREE from 'three/webgpu';
import { SPEED_OF_LIGHT_M_PER_S } from '../../core/constants';
import { Mat3d, Vec3d } from '../../core/vec3d';
import type { BodyView, SolarSystem, SystemPos } from '../../world/solarSystem';
import { rotationAngles } from '../../world/rotation';

export type FlightMode = 'thrusters' | 'impulse' | 'cruise' | 'hyperspeed';
export const MODES: FlightMode[] = ['thrusters', 'impulse', 'cruise'];

export interface ShipControls {
  /** -1..1 rotational inputs (pitch up +, yaw left +, roll left +). */
  pitch: number;
  yaw: number;
  roll: number;
  /** -1..1 change of the throttle setpoint per second. */
  throttleRate: number;
  /** -1..1 lateral / vertical translation (thrusters mode). */
  strafeX: number;
  strafeY: number;
  boost: boolean;
  zeroThrottle: boolean;
  modeNext: boolean;
  modePrev: boolean;
  toggleFlightAssist: boolean;
}

export const NO_CONTROLS: ShipControls = {
  pitch: 0,
  yaw: 0,
  roll: 0,
  throttleRate: 0,
  strafeX: 0,
  strafeY: 0,
  boost: false,
  zeroThrottle: false,
  modeNext: false,
  modePrev: false,
  toggleFlightAssist: false,
};

/** Tunables (game design, not physics). */
export const FLIGHT = {
  thrustersMaxSpeed: 3_000, // m/s relative to the surface frame
  thrustersAccel: 30, // m/s^2 (about 3 g)
  impulseCap: 0.05 * SPEED_OF_LIGHT_M_PER_S,
  cruiseCap: 3_000 * SPEED_OF_LIGHT_M_PER_S,
  governorImpulse: 0.6, // max speed = k * distance to nearest surface (1/s)
  governorCruise: 0.9,
  minCruiseSpeed: 2_000,
  turnRate: 1.1, // rad/s at full input (thrusters)
  turnRateCruise: 0.6,
  clearanceM: 2.5,
  landingSpeed: 4,
  dropOutAltitudeFraction: 0.01, // cruise/impulse drop to thrusters below this fraction of the radius (min 20 km)
};

const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();

export class Ship {
  pos: SystemPos;
  /** Inertial velocity relative to the anchor body's centre (m/s, ICRF). */
  vel = new Vec3d();
  quat = new THREE.Quaternion();
  /** Angular velocity in ship-local axes (rad/s). */
  angVel = new THREE.Vector3();
  mode: FlightMode = 'thrusters';
  /** Throttle setpoint, -0.5..1 (negative = reverse, thrusters only). */
  throttle = 0;
  flightAssist = true;
  landed = false;
  /** When landed: position in the body-fixed frame (m). */
  private landedBf: Vec3d | null = null;
  /** Telemetry for HUD/audio. */
  readonly telemetry = {
    speed: 0,
    surfaceSpeed: 0,
    verticalSpeed: 0,
    altitude: 0,
    agl: 0,
    near: '',
    governorSpeed: 0,
    thrust: 0,
    rcs: 0,
    droppedOut: false,
  };

  constructor(pos: SystemPos, quat: THREE.Quaternion) {
    this.pos = pos;
    this.quat.copy(quat);
  }

  /** Back to thrusters, at rest in attitude, not landed (used when teleporting). */
  resetFlight(): void {
    this.mode = 'thrusters';
    this.throttle = 0;
    this.angVel.set(0, 0, 0);
    this.landed = false;
    this.landedBf = null;
  }

  forward(out = new Vec3d()): Vec3d {
    tmpV.set(0, 0, -1).applyQuaternion(this.quat);
    return out.set(tmpV.x, tmpV.y, tmpV.z);
  }

  /** Angular velocity vector of a body's rotation (rad/s, ICRF). */
  static bodyOmega(view: BodyView, t: number): Vec3d {
    const r = view.def.rotation;
    const radPerS = (((r.pm[1] ?? 0) * Math.PI) / 180) / 86_400;
    const { ra, dec } = rotationAngles(r, t);
    const a = (ra * Math.PI) / 180;
    const d = (dec * Math.PI) / 180;
    return new Vec3d(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)).scale(radPerS);
  }

  /** Re-express position and velocity relative to another anchor body. */
  reanchor(sys: SolarSystem, anchor: string, t: number): void {
    if (anchor === this.pos.anchor) return;
    const dv = sys.anchorVelocity(this.pos.anchor, anchor, t, new Vec3d());
    this.pos = sys.reanchor(this.pos, anchor, t);
    this.vel.add(dv);
    if (this.landedBf) this.landed = false;
    this.landedBf = null;
  }

  update(dt: number, c: ShipControls, sys: SolarSystem, t: number): void {
    const tel = this.telemetry;
    tel.droppedOut = false;
    // Anchor on the dominant body (sphere of influence) to keep offsets small and gravity meaningful.
    const dom = sys.dominantBody(this.pos, t);
    if (dom !== this.pos.anchor && !this.landed) this.reanchor(sys, dom, t);

    if (c.toggleFlightAssist) this.flightAssist = !this.flightAssist;
    if (c.modeNext || c.modePrev) {
      const i = Math.max(0, MODES.indexOf(this.mode));
      const n = (i + (c.modeNext ? 1 : MODES.length - 1)) % MODES.length;
      const was = this.mode;
      this.setMode(MODES[n]!);
      // Leaving a drive for thrusters must not keep drive velocity (up to 3,000c): match the local frame.
      if (this.mode === 'thrusters' && was !== 'thrusters') this.matchLocalFrame(sys, t);
    }
    if (c.zeroThrottle) this.throttle = 0;
    this.throttle = Math.min(1, Math.max(this.mode === 'thrusters' ? -0.5 : 0, this.throttle + c.throttleRate * dt * 0.6));

    const anchor = sys.byId.get(this.pos.anchor);
    const [near, alt] = sys.nearest(this.pos, t);
    const ground = sys.surfaceHeightBelow(near, this.pos, t);
    tel.near = near.def.key;
    tel.altitude = alt;
    tel.agl = alt - ground;

    // Rotation: rate command with damping (always assisted; the drive has reaction wheels).
    const rate = this.mode === 'thrusters' ? FLIGHT.turnRate : FLIGHT.turnRateCruise;
    const target = new THREE.Vector3(c.pitch, c.yaw, c.roll * 1.4).multiplyScalar(rate);
    if (!this.landed) this.angVel.lerp(target, 1 - Math.exp(-dt * 6));
    else this.angVel.set(0, 0, 0);
    if (this.angVel.lengthSq() > 0) {
      tmpQ.setFromAxisAngle(tmpV.copy(this.angVel).normalize(), this.angVel.length() * dt);
      this.quat.multiply(tmpQ).normalize();
    }
    tel.rcs = Math.min(1, target.length() / rate);

    if (this.landed) {
      this.updateLanded(c, sys, t);
      return;
    }

    if (this.mode === 'thrusters') this.updateThrusters(dt, c, anchor, t);
    else if (this.mode === 'impulse' || this.mode === 'cruise') this.updateDrive(dt, sys, near, alt, t);

    this.pos.offset.addScaled(this.vel, dt);
    this.resolveTerrain(sys, near, t);
    tel.speed = this.vel.length();
  }

  setMode(m: FlightMode): void {
    if (m === this.mode) return;
    this.mode = m;
    if (m !== 'thrusters' && this.throttle < 0) this.throttle = 0;
  }

  /**
   * Come to rest in the local frame: co-rotating with the nearest body's surface when within 10 radii of it
   * (re-anchored to it), otherwise at rest relative to the current anchor.
   */
  matchLocalFrame(sys: SolarSystem, t: number): void {
    const [near, alt] = sys.nearest(this.pos, t);
    if (near.def.kind !== 'star' && alt < 10 * near.def.radiusM) {
      if (this.pos.anchor !== near.def.id) this.reanchor(sys, near.def.id, t);
      this.vel.copy(this.surfaceVelocity(near, t, this.pos.offset));
    } else {
      this.vel.set(0, 0, 0);
    }
  }

  private surfaceVelocity(view: BodyView | undefined, t: number, rel: Vec3d): Vec3d {
    // Velocity of the co-rotating surface frame at the ship's position (relative to the body centre).
    if (!view || view.def.kind === 'star') return new Vec3d();
    return Ship.bodyOmega(view, t).cross(rel);
  }

  private updateThrusters(dt: number, c: ShipControls, anchor: BodyView | undefined, t: number): void {
    const tel = this.telemetry;
    const rel = this.pos.offset; // relative to the anchor centre
    const r = Math.max(rel.length(), 1);
    const g = anchor ? new Vec3d().copy(rel).scale(-anchor.def.gmM3S2 / (r * r * r)) : new Vec3d();
    const frame = this.surfaceVelocity(anchor, t, rel);
    const vRel = new Vec3d().subVectors(this.vel, frame);
    const boost = c.boost ? 3 : 1;
    const local = new THREE.Vector3(c.strafeX, c.strafeY, -this.throttle).multiplyScalar(FLIGHT.thrustersMaxSpeed * boost);
    // Slow down near the ground so landing speeds are natural.
    const groundScale = Math.min(1, Math.max(0.02, tel.agl / 3000));
    local.multiplyScalar(groundScale);
    local.applyQuaternion(this.quat);
    let accel: Vec3d;
    const aMax = FLIGHT.thrustersAccel * boost;
    if (this.flightAssist) {
      // FA: drive surface-relative velocity to the setpoint and cancel gravity.
      const desired = new Vec3d(local.x, local.y, local.z);
      const err = new Vec3d().subVectors(desired, vRel);
      const want = err.scale(1.8);
      const mag = want.length();
      if (mag > aMax) want.scale(aMax / mag);
      // Net acceleration is `want`; the drive also supplies -g (gravity compensation).
      tel.thrust = Math.min(1, want.clone().sub(g).length() / aMax);
      accel = want;
    } else {
      const dir = new Vec3d(local.x, local.y, local.z);
      const len = dir.length();
      accel = len > 0 ? dir.scale((aMax * Math.min(1, len / FLIGHT.thrustersMaxSpeed)) / len) : new Vec3d();
      tel.thrust = Math.min(1, accel.length() / aMax);
      accel.add(g);
    }
    this.vel.addScaled(accel, dt);
    const vRel2 = new Vec3d().subVectors(this.vel, frame);
    tel.surfaceSpeed = vRel2.length();
    tel.verticalSpeed = vRel2.dot(rel) / r;
  }

  private updateDrive(dt: number, sys: SolarSystem, near: BodyView, alt: number, t: number): void {
    const tel = this.telemetry;
    const cap = this.mode === 'impulse' ? FLIGHT.impulseCap : FLIGHT.cruiseCap;
    const k = this.mode === 'impulse' ? FLIGHT.governorImpulse : FLIGHT.governorCruise;
    const gov = Math.max(FLIGHT.minCruiseSpeed, k * Math.max(0, alt));
    tel.governorSpeed = Math.min(cap, gov);
    const speed = this.throttle * tel.governorSpeed;
    // The drive moves with the anchor body's frame (no gravity); smooth velocity changes.
    const fwd = this.forward();
    const target = fwd.scale(speed);
    const blend = 1 - Math.exp(-dt * 2.5);
    this.vel.lerp(target, blend);
    tel.thrust = this.throttle;
    tel.surfaceSpeed = this.vel.length();
    // Drop out to thrusters when close to a surface.
    const dropAlt = Math.max(20_000, near.def.radiusM * FLIGHT.dropOutAltitudeFraction);
    if (alt < dropAlt && this.vel.dot(sys.bodyRelative(near.def.id, this.pos, t, new Vec3d())) > 0) {
      this.mode = 'thrusters';
      this.throttle = 0;
      // Match the surface frame of the body we dropped out at (not the anchor's, e.g. Mars at Deimos).
      if (this.pos.anchor !== near.def.id) this.reanchor(sys, near.def.id, t);
      this.vel.copy(this.surfaceVelocity(near, t, this.pos.offset));
      tel.droppedOut = true;
    }
  }

  private resolveTerrain(sys: SolarSystem, near: BodyView, t: number): void {
    const tel = this.telemetry;
    const rel = sys.bodyRelative(near.def.id, this.pos, t, new Vec3d()).scale(-1); // ship relative to body
    const r = rel.length();
    const ground = near.def.radiusM + sys.surfaceHeightBelow(near, this.pos, t);
    tel.agl = r - ground;
    if (tel.agl < FLIGHT.clearanceM) {
      const up = rel.clone().scale(1 / r);
      const push = FLIGHT.clearanceM - tel.agl;
      // Move the ship up along the local vertical (expressed in the anchor frame: same axes).
      this.pos.offset.addScaled(up, push);
      tel.agl = FLIGHT.clearanceM;
      // Remove the into-ground component of velocity relative to the surface frame.
      const frame = this.surfaceVelocity(sys.byId.get(this.pos.anchor), t, this.pos.offset);
      const vRel = new Vec3d().subVectors(this.vel, frame);
      const vn = vRel.dot(up);
      if (vn < 0) vRel.addScaled(up, -vn);
      if (this.mode !== 'thrusters') this.mode = 'thrusters';
      // Touchdown: slow enough relative to the surface -> landed (locked to the rotating body).
      if (vRel.length() < FLIGHT.landingSpeed && this.throttle <= 0.05) {
        this.land(sys, near, t);
        return;
      }
      this.vel.copy(frame).add(vRel.scale(0.9));
    }
  }

  private land(sys: SolarSystem, near: BodyView, t: number): void {
    if (this.pos.anchor !== near.def.id) this.reanchor(sys, near.def.id, t);
    this.landed = true;
    this.throttle = 0;
    this.landedBf = this.pos.offset.clone().applyMat3Transpose(near.rotation);
  }

  private updateLanded(c: ShipControls, sys: SolarSystem, t: number): void {
    const view = sys.byId.get(this.pos.anchor);
    if (!view) {
      this.landed = false;
      return;
    }
    const rot = new Mat3d().copy(view.rotation);
    if (this.landedBf) this.pos.offset.copy(this.landedBf).applyMat3(rot);
    this.vel.copy(this.surfaceVelocity(view, t, this.pos.offset));
    const tel = this.telemetry;
    tel.surfaceSpeed = 0;
    tel.verticalSpeed = 0;
    tel.speed = 0;
    tel.thrust = 0;
    // Lift off with upward strafe or forward throttle.
    if (c.strafeY > 0.2 || c.throttleRate > 0.2) {
      this.landed = false;
      this.landedBf = null;
      const up = this.pos.offset.clone().normalize();
      this.pos.offset.addScaled(up, 1.0);
      this.vel.addScaled(up, 3);
    }
  }
}
