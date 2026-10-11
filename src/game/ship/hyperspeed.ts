/**
 * Hyperspeed: the fictional interstellar drive. A jump spools for a few seconds, then carries the ship along a
 * straight line to an arrival point near the destination star with a smooth speed profile, taking ~20-40 s whatever
 * the distance. The HUD shows real distances and light-travel times; speeds far above c are fiction (Codex: "The
 * drive is fiction").
 */
import { LIGHT_YEAR_M, SPEED_OF_LIGHT_M_PER_S } from '../../core/constants';
import { Vec3d } from '../../core/vec3d';
import type { SolarSystem } from '../../world/solarSystem';
import type { Ship } from './ship';

export type HyperPhase = 'idle' | 'spool' | 'jump';

const smootherstep = (x: number): number => x * x * x * (x * (x * 6 - 15) + 10);
const dSmootherstep = (x: number): number => 30 * x * x * (x - 1) * (x - 1);

export class Hyperspeed {
  phase: HyperPhase = 'idle';
  targetAnchor = '';
  targetName = '';
  /** Current speed (m/s) and distance left (m), for the HUD. */
  speed = 0;
  remaining = 0;
  spoolTime = 3;
  private elapsed = 0;
  private duration = 0;
  private readonly start = new Vec3d();
  private readonly end = new Vec3d();
  private readonly dir = new Vec3d();
  onArrive: ((anchor: string) => void) | null = null;

  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** 0..1 visual intensity for streaks. */
  get streak(): number {
    if (this.phase === 'spool') return 0.15 * (this.elapsed / this.spoolTime);
    if (this.phase === 'jump') return Math.min(1, Math.sqrt(this.speed / SPEED_OF_LIGHT_M_PER_S / 2e5));
    return 0;
  }

  get etaSeconds(): number {
    if (this.phase === 'spool') return this.spoolTime - this.elapsed + this.duration;
    if (this.phase === 'jump') return Math.max(0, this.duration - this.elapsed);
    return 0;
  }

  /**
   * Start a jump to `targetAnchor` (a catalog star "*<i>" or the Sun "10"). `targetSsb` is its SSB position (m);
   * the ship arrives `arrivalM` short of it. Returns an i18n error key, or null on success.
   */
  engage(sys: SolarSystem, ship: Ship, t: number, targetAnchor: string, targetName: string, targetSsb: Vec3d, arrivalM: number): string | null {
    if (this.active) return 'hyper.error.busy';
    if (ship.landed) return 'hyper.error.landed';
    const [near, alt] = sys.nearest(ship.pos, t);
    if (near.def.kind !== 'star' && alt < Math.max(1e7, near.def.radiusM * 2)) return 'hyper.error.gravityWell';
    const from = sys.toSsb(ship.pos, t, new Vec3d());
    const toTarget = new Vec3d().subVectors(targetSsb, from);
    const dist = toTarget.length();
    if (dist < arrivalM * 2 || dist < 0.01 * LIGHT_YEAR_M) return 'hyper.error.tooClose';
    this.dir.copy(toTarget).normalize();
    this.start.copy(from);
    this.end.copy(targetSsb).addScaled(this.dir, -arrivalM);
    const ly = this.start.distanceTo(this.end) / LIGHT_YEAR_M;
    this.duration = 20 + 6 * Math.log10(1 + ly);
    this.targetAnchor = targetAnchor;
    this.targetName = targetName;
    this.phase = 'spool';
    this.elapsed = 0;
    this.speed = 0;
    this.remaining = dist;
    return null;
  }

  cancel(): void {
    if (this.phase === 'spool') this.phase = 'idle';
  }

  /** Drop out of any phase immediately (teleports). */
  abort(): void {
    this.phase = 'idle';
    this.speed = 0;
    this.elapsed = 0;
  }

  update(dt: number, sys: SolarSystem, ship: Ship, t: number): void {
    if (this.phase === 'idle') return;
    this.elapsed += dt;
    if (this.phase === 'spool') {
      if (this.elapsed >= this.spoolTime) {
        // Detach from the system: anchor to interstellar space (SSB origin) for the transit.
        ship.pos = { anchor: 'ism', offset: sys.toSsb(ship.pos, t, new Vec3d()) };
        this.start.copy(ship.pos.offset);
        ship.vel.set(0, 0, 0);
        ship.mode = 'hyperspeed';
        ship.throttle = 0;
        this.phase = 'jump';
        this.elapsed = 0;
      }
      return;
    }
    const x = Math.min(1, this.elapsed / this.duration);
    const span = new Vec3d().subVectors(this.end, this.start);
    const L = span.length();
    ship.pos.offset.copy(this.start).addScaled(span, smootherstep(x));
    this.speed = (L * dSmootherstep(x)) / this.duration;
    ship.vel.copy(this.dir).scale(this.speed);
    this.remaining = L * (1 - smootherstep(x));
    if (x >= 1) {
      ship.pos = sys.reanchor(ship.pos, this.targetAnchor, t);
      ship.vel.set(0, 0, 0);
      ship.mode = 'cruise';
      ship.throttle = 0;
      this.phase = 'idle';
      this.speed = 0;
      this.onArrive?.(this.targetAnchor);
    }
  }
}
