/**
 * The fuel loop in the game (docs/FUEL.md section 8): connects the FuelSystem and its HUD gauge to the ship, the
 * hyperspeed drive, audio and the cockpit. ShipController owns one ShipFuel and calls it at a few fixed points:
 *
 * - update(dt) after the flight step: scoop and hull heat from the system's star, events, saves, the paid jump.
 * - steerClimb(dt, controls) before the flight step: the forced emergency climb when the hull is at its limit.
 * - chargeJump(distanceM) when hyperspeed engages: pays for the jump, or cancels the spool when the tank is short.
 * - updateHud(targetId, distanceM) after the HUD update: feeds the gauge and keeps it clear of the HUD panels.
 * - climbing and cockpitAlert: read by the HUD warning line and the cockpit status.
 * - onPlace() after a teleport: refunds a jump that never left the spool and ends a climb.
 *
 * Everything here is a game mechanic (fiction) driven by one real quantity, the star's flux at the ship.
 */
import * as THREE from 'three/webgpu';
import { LIGHT_YEAR_M } from '../../core/constants';
import { Vec3d } from '../../core/vec3d';
import type { App } from '../app';
import { FuelSystem, defaultFuelStorage, loadFuel, saveFuel, type FuelEvent, type FuelStorage, type HeatState, type StarEnv } from './fuel';
import { FuelGauge, type FuelGaugeState } from './fuelGauge';
import { FuelHudLayout } from './fuelLayout';
import type { Hyperspeed } from './hyperspeed';
import type { Ship, ShipControls } from './ship';

/** Hyperspeed refuses targets closer than this (hyperspeed.ts), so the gauge shows no cost for them. */
export const MIN_JUMP_LY = 0.01;
/** Seconds of forced climb after the hull reaches its limit (extended while it stays critical). */
const CLIMB_S = 4;
/** Turn rate of the forced climb (rad/s). */
const CLIMB_TURN = 2.5;
const SAVE_INTERVAL_S = 5;

/** `?fuel=0..1` (tests, screenshots): a finite number, clamped; anything else (missing, empty, text) means no override. */
export function parseFuelOverride(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}

/** Cockpit status level for a heat state: Alert (amber) from the warning level, red at critical and above. */
export function heatAlertLevel(state: HeatState): number {
  return state === 'emergency' ? 1 : state === 'critical' ? 0.8 : state === 'warning' ? 0.5 : 0;
}

/**
 * What the gauge shows for the jump: the selected target's cost, 'tooClose', 'underway' (with the paid cost), or no
 * target. Pure, so the rules are unit-tested.
 */
export function jumpFeed(opts: {
  /** A jump is spooling or in transit. */
  underway: boolean;
  /** Cost paid for the jump in progress, if known. */
  paidCost: number | null;
  /** The selected target is something hyperspeed can jump to (a star). */
  targetIsStar: boolean;
  /** Ship-to-target distance (m), or null without a target. */
  distanceM: number | null;
  costOf: (ly: number) => number;
}): Pick<FuelGaugeState, 'nextJumpCost' | 'jumpStatus'> {
  if (opts.underway) return { nextJumpCost: opts.paidCost, jumpStatus: 'underway' };
  if (!opts.targetIsStar || opts.distanceM === null || !Number.isFinite(opts.distanceM)) return { nextJumpCost: null, jumpStatus: null };
  const ly = opts.distanceM / LIGHT_YEAR_M;
  if (ly < MIN_JUMP_LY) return { nextJumpCost: null, jumpStatus: 'tooClose' };
  return { nextJumpCost: opts.costOf(ly), jumpStatus: null };
}

export class ShipFuel {
  readonly system: FuelSystem;
  readonly gauge: FuelGauge;
  private readonly layout: FuelHudLayout;
  /** Null when `?fuel=` overrides the tank: the player's saved tank is then left alone. */
  private readonly storage: FuelStorage | null;
  private climb = 0;
  private saveTimer = SAVE_INTERVAL_S;
  private lastSaved = '';
  /** The jump being paid for: refunded if the spool ends without the transit starting (a teleport aborts it). */
  private paid: { cost: number; transit: boolean } | null = null;

  constructor(
    private readonly app: App,
    private readonly ship: Ship,
    private readonly hyper: Hyperspeed,
    hudRoot: HTMLElement,
  ) {
    const override = parseFuelOverride(app.params.get('fuel'));
    this.storage = override === null ? defaultFuelStorage() : null;
    // The ship always starts in a fresh placement (its position is not saved), so the hull starts cold; only the tank
    // is restored.
    this.system = new FuelSystem({ hyperFuel: override ?? loadFuel(this.storage).hyperFuel, heat: 0 });
    this.lastSaved = JSON.stringify(this.system.toJSON());
    this.gauge = new FuelGauge(hudRoot);
    this.layout = new FuelHudLayout(hudRoot, this.gauge);
    window.addEventListener('pagehide', () => this.save());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.save();
    });
  }

  /** True while the forced emergency climb has the controls. */
  get climbing(): boolean {
    return this.climb > 0;
  }

  /** Cockpit status level for the hull heat (0..1). */
  get cockpitAlert(): number {
    return heatAlertLevel(this.system.heatState);
  }

  /** Writes the tank to storage when it changed (nothing when `?fuel=` overrides it). */
  save(): void {
    if (!this.storage) return;
    const json = JSON.stringify(this.system.toJSON());
    if (json === this.lastSaved) return;
    saveFuel(this.system, this.storage);
    this.lastSaved = json;
  }

  /** The system's star seen from the ship (real luminosity, radius and temperature). */
  private starEnv(): StarEnv {
    const app = this.app;
    const star = app.sys.primaryStar(this.ship.pos, app.simTime);
    return {
      distanceM: app.sys.bodyRelative(star.def.id, this.ship.pos, app.simTime, new Vec3d()).length(),
      radiusM: star.def.radiusM,
      luminositySun: star.def.luminositySun ?? Number.NaN,
      teffK: star.def.surface.teffK ?? Number.NaN,
    };
  }

  private canClimb(): boolean {
    return !this.ship.landed && !this.hyper.active;
  }

  /** Advance scoop and hull heat by `dt` (after the flight step); react to events; track the paid jump; save. */
  update(dt: number): void {
    const ship = this.ship;
    const events = this.system.update(dt, this.starEnv(), { mode: ship.mode, throttle: ship.throttle, landed: ship.landed });
    for (const e of events) this.onEvent(e);
    const state = this.system.heatState;
    // At the limit the ship always climbs, even without a fresh event; it keeps climbing while the hull is critical.
    if (state === 'emergency' && this.climb <= 0 && this.canClimb()) this.climb = CLIMB_S;
    if (this.climb > 0 && (state === 'critical' || state === 'emergency')) this.climb = Math.max(this.climb, 0.5);
    if (!this.canClimb()) this.climb = 0;
    this.trackJump();
    this.saveTimer -= dt;
    if (this.saveTimer <= 0) {
      this.saveTimer = SAVE_INTERVAL_S;
      this.save();
    }
  }

  private onEvent(e: FuelEvent): void {
    const audio = this.app.audio;
    switch (e) {
      case 'heat-warning':
        audio.play('scoop-warning');
        break;
      case 'heat-critical':
      case 'heat-emergency':
        audio.play('heat-critical');
        break;
      case 'fuel-low':
        audio.play('fuel-low');
        break;
      case 'tank-full':
      case 'scoop-stop':
        this.save();
        break;
      case 'scoop-start':
        break;
    }
  }

  /**
   * Emergency climb (before the flight step): ignores the player's steering, turns the nose radially away from the star
   * and, once it points roughly away, climbs in cruise at full throttle (cruise's governor scales with the distance, so
   * the climb is fast near the star), then throttles back. Returns true while it has the controls.
   */
  steerClimb(dt: number, c: ShipControls): boolean {
    if (this.climb <= 0 || !this.canClimb()) return false;
    const app = this.app;
    const ship = this.ship;
    this.climb = Math.max(0, this.climb - dt);
    c.pitch = 0;
    c.yaw = 0;
    c.roll = 0;
    c.throttleRate = 0;
    c.zeroThrottle = false;
    c.modeNext = false;
    c.modePrev = false;
    const star = app.sys.primaryStar(ship.pos, app.simTime);
    const away = app.sys.bodyRelative(star.def.id, ship.pos, app.simTime, new Vec3d()).scale(-1).normalize();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quat);
    const delta = new THREE.Quaternion().setFromUnitVectors(fwd, new THREE.Vector3(away.x, away.y, away.z));
    const angle = 2 * Math.acos(Math.min(1, Math.abs(delta.w)));
    ship.quat.premultiply(new THREE.Quaternion().slerp(delta, Math.min(1, (CLIMB_TURN * dt) / Math.max(angle, 1e-6)))).normalize();
    ship.setMode('cruise');
    // Full throttle once the nose is within about 30 degrees of "away" (never toward the star while turning).
    ship.throttle = this.climb > 0 && angle < 0.5 ? 1 : 0;
    return true;
  }

  /**
   * Pays for a jump that hyperspeed has just engaged (distance to the target star, m). When the tank cannot pay, the
   * spool is cancelled and false is returned (the caller shows the refusal).
   */
  chargeJump(distanceM: number): boolean {
    const ly = distanceM / LIGHT_YEAR_M;
    if (!this.system.canJump(ly)) {
      this.hyper.cancel();
      return false;
    }
    const cost = this.system.jumpCost(ly);
    this.system.consumeJump(ly);
    this.paid = { cost, transit: false };
    this.climb = 0;
    this.save();
    return true;
  }

  /** Refund a jump whose spool ended without the transit starting (hyperspeed aborted by a teleport). */
  private trackJump(): void {
    const p = this.paid;
    if (!p) return;
    if (this.hyper.phase === 'jump') p.transit = true;
    else if (this.hyper.phase === 'idle') {
      if (!p.transit) {
        this.system.refuel(p.cost);
        this.save();
      }
      this.paid = null;
    }
  }

  /** After a teleport (ShipController.onPlace, which has aborted hyperspeed): settle the paid jump, end any climb. */
  onPlace(): void {
    this.trackJump();
    this.climb = 0;
  }

  /** True for targets hyperspeed can jump to: the same rule as ShipController.engageHyperspeed (a star). */
  private isJumpTarget(id: string | null): boolean {
    return id !== null && (id === '10' || id.startsWith('*') || this.app.exo.some((s) => s.spec.id === id));
  }

  /**
   * Feed the gauge (after the HUD update) and keep it clear of the HUD panels. `distanceM`: ship to the selected
   * target's centre, or null without a target.
   */
  updateHud(targetId: string | null, distanceM: number | null): void {
    const s = this.system;
    const feed = jumpFeed({
      underway: this.hyper.active,
      paidCost: this.paid?.cost ?? null,
      targetIsStar: this.isJumpTarget(targetId),
      distanceM,
      costOf: (ly) => s.jumpCost(ly),
    });
    this.gauge.update({
      hyperFuel: s.hyperFuel,
      heat: s.heat,
      scooping: s.scooping,
      ...feed,
      secondsToFull: s.secondsToFull,
      heatState: s.heatState,
    });
    this.layout.update();
  }
}
