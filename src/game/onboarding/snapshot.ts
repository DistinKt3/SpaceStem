/**
 * Helpers the game uses to build an OnboardingSnapshot each frame (plain math, no engine types): accumulated view
 * rotation, nose-on-target alignment, bodies in the way of a target, the opening placement, and the label of an
 * action's current binding (or of one direction of an axis).
 */
import type { ActionId } from '../input/actions';
import type { Binding, BindingSlots, InputContext } from '../input/bindings';
import { bindingLabel, inputLabel } from '../input/labels';

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface QuatLike extends Vec3Like {
  readonly w: number;
}

/** Per-frame rotations above this are teleports or view switches, not looking around (rad). */
const MAX_STEP_RAD = 0.5;

/** Accumulates how far the view has turned (head look plus ship attitude), in radians. */
export class LookTracker {
  private prev: [number, number, number, number] | null = null;
  private total = 0;

  /** Feed the camera orientation once per frame; returns the accumulated rotation (rad). */
  update(q: QuatLike): number {
    const p = this.prev;
    if (p) {
      const dot = Math.min(1, Math.abs(p[0] * q.x + p[1] * q.y + p[2] * q.z + p[3] * q.w));
      const angle = 2 * Math.acos(dot);
      if (angle < MAX_STEP_RAD) this.total += angle;
      p[0] = q.x;
      p[1] = q.y;
      p[2] = q.z;
      p[3] = q.w;
    } else {
      this.prev = [q.x, q.y, q.z, q.w];
    }
    return this.total;
  }

  get radians(): number {
    return this.total;
  }

  reset(): void {
    this.prev = null;
    this.total = 0;
  }
}

/** Alignment tolerance: the nose within 3 degrees of the target centre, or anywhere on its disc when it is larger. */
export const ALIGN_TOLERANCE_RAD = (3 * Math.PI) / 180;

/** Angle between two directions (rad); 0 when either is zero-length. */
export function angleBetween(a: Vec3Like, b: Vec3Like): number {
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  if (la === 0 || lb === 0) return 0;
  const c = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  return Math.acos(Math.min(1, Math.max(-1, c)));
}

/**
 * True when the ship's nose (`forward`, any length) points at a target whose centre lies at `rel` from the ship (m)
 * with radius `radiusM` (m).
 */
export function isAligned(forward: Vec3Like, rel: Vec3Like, radiusM = 0): boolean {
  const d = Math.hypot(rel.x, rel.y, rel.z);
  if (d === 0) return true;
  const disc = Math.asin(Math.min(1, Math.max(0, radiusM) / d));
  return angleBetween(forward, rel) <= Math.max(ALIGN_TOLERANCE_RAD, disc);
}

export interface BindingSource {
  readonly bindings: Readonly<Record<string, BindingSlots>>;
  readonly padBindings: Readonly<Record<string, BindingSlots>>;
  /** The "Invert Y" setting (settings.data.invertY). */
  readonly invertY?: boolean;
}

/** One direction of an axis action: '+' gives +1 (thrust forward, strafe up...), '-' gives -1. */
export type AxisHalf = '+' | '-';

/**
 * Label of one direction of a binding: the positive or negative key of a key pair, trigger of a trigger pair, or
 * direction of a stick (following its invert flag). Bindings without directions keep their whole label.
 */
export function bindingHalfLabel(b: Binding | null, half: AxisHalf): string {
  if (!b) return bindingLabel(null);
  const pos = half === '+';
  switch (b.type) {
    case 'keyAxis':
      return inputLabel(`key:${pos ? b.pos : b.neg}`);
    case 'padButtonAxis':
      return inputLabel(`pad:b${pos ? b.pos : b.neg}`);
    case 'padAxis':
      // The action reads stick * (invert ? -1 : 1): its positive half is the stick's negative side when inverted.
      return inputLabel(`pad:a${b.axis}${pos !== b.invert ? '+' : '-'}`);
    default:
      return bindingLabel(b);
  }
}

/**
 * Label of the first bound slot of an action for the device in use (e.g. "Tab", "Mouse R", "Y"), or the "Not bound"
 * text when neither slot is bound. With `half`, only that direction of an axis ("W" for thrust '+', "S" for '-').
 * Pass settings.data and input.activeDevice.
 */
export function actionLabel(source: BindingSource, device: InputContext, id: ActionId, half?: AxisHalf): string {
  const slots = (device === 'pad' ? source.padBindings : source.bindings)[id];
  const b = slots?.[0] ?? slots?.[1] ?? null;
  if (!half) return bindingLabel(b);
  // "Invert Y" flips a stick bound to pitch (InputManager.evaluate), so "nose up" is then the other direction.
  const flip = id === 'pitch' && source.invertY === true && b?.type === 'padAxis';
  return bindingHalfLabel(b, flip ? (half === '+' ? '-' : '+') : half);
}

/** A body that can stand in the way of a target (positions relative to the ship, m). */
export interface ObstacleLike {
  readonly key: string;
  readonly id: string;
  readonly rel: Vec3Like;
  readonly radiusM: number;
}

/**
 * Drop-out clearance around a body (m): the impulse and cruise drives fall back to thrusters below
 * max(20 km, 1% of the radius) while closing on a surface (ship.ts updateDrive, FLIGHT.dropOutAltitudeFraction).
 */
export function dropOutClearanceM(radiusM: number): number {
  return radiusM + Math.max(20_000, radiusM * 0.01);
}

/**
 * The body whose drop-out sphere the straight path from the ship (the origin) to `targetRel` passes through while
 * closing on it, or null when the way is clear. Bodies behind the ship (the path moves away from them) and the target
 * itself never block.
 */
export function pathBlocker(
  targetRel: Vec3Like,
  targetId: string,
  bodies: Iterable<ObstacleLike>,
  clearance: (radiusM: number) => number = dropOutClearanceM,
): ObstacleLike | null {
  const dd = targetRel.x * targetRel.x + targetRel.y * targetRel.y + targetRel.z * targetRel.z;
  if (!(dd > 0)) return null;
  let best: ObstacleLike | null = null;
  let bestT = Infinity;
  for (const b of bodies) {
    if (b.id === targetId) continue;
    const c = b.rel;
    const along = c.x * targetRel.x + c.y * targetRel.y + c.z * targetRel.z;
    if (along <= 0) continue; // behind: the path leaves it
    const t = Math.min(1, along / dd);
    const dx = c.x - targetRel.x * t;
    const dy = c.y - targetRel.y * t;
    const dz = c.z - targetRel.z * t;
    const r = clearance(b.radiusM);
    if (dx * dx + dy * dy + dz * dz < r * r && t < bestT) {
      best = b;
      bestT = t;
    }
  }
  return best;
}

const unit = (v: Vec3Like): [number, number, number] => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return [v.x / l, v.y / l, v.z / l];
};

/**
 * Where the opening starts: the local vertical ("up", a unit vector in the same frame as the inputs) above which the
 * ship is placed so the Moon stands at least `minMoonElevRad` above the horizontal, with the Sun as high as that
 * allows (ideally `sunAngleRad` from the zenith, the lighting of App.view('leo')). Inputs are directions from the
 * body's centre to the Sun and to the Moon. The result lies on the great circle from the Sun's direction toward the
 * Moon's; when the two are (anti)parallel, `fallback` picks the plane.
 */
export function openingUp(
  sun: Vec3Like,
  moon: Vec3Like,
  fallback: Vec3Like,
  sunAngleRad = (55 * Math.PI) / 180,
  // 13 degrees from the body's centre: at least 12 from a ship in low orbit (the Moon's parallax there is <= 1 degree).
  minMoonElevRad = (13 * Math.PI) / 180,
): Vec3Like {
  const s = unit(sun);
  const m = unit(moon);
  const phi = Math.acos(Math.min(1, Math.max(-1, s[0] * m[0] + s[1] * m[1] + s[2] * m[2])));
  // A unit vector perpendicular to the Sun's direction, toward the Moon (or toward the fallback when degenerate).
  let p: [number, number, number] = [m[0] - s[0] * Math.cos(phi), m[1] - s[1] * Math.cos(phi), m[2] - s[2] * Math.cos(phi)];
  if (Math.hypot(...p) < 1e-6) {
    const f = unit(fallback);
    const k = f[0] * s[0] + f[1] * s[1] + f[2] * s[2];
    p = [f[0] - s[0] * k, f[1] - s[1] * k, f[2] - s[2] * k];
    if (Math.hypot(...p) < 1e-6) p = Math.abs(s[2]) < 0.9 ? [-s[1], s[0], 0] : [0, -s[2], s[1]];
  }
  const pl = Math.hypot(...p);
  p = [p[0] / pl, p[1] / pl, p[2] / pl];
  // Moon elevation = 90 deg - angle(up, moon) = 90 deg - |phi - a|: keep it >= minMoonElev.
  const a = Math.max(sunAngleRad, phi - (Math.PI / 2 - minMoonElevRad));
  return {
    x: s[0] * Math.cos(a) + p[0] * Math.sin(a),
    y: s[1] * Math.cos(a) + p[1] * Math.sin(a),
    z: s[2] * Math.cos(a) + p[2] * Math.sin(a),
  };
}

/** Elevation of a direction above the horizontal plane of `up` (rad). */
export function elevation(up: Vec3Like, dir: Vec3Like): number {
  return Math.PI / 2 - angleBetween(up, dir);
}
