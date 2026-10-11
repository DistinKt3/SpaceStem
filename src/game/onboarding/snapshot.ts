/**
 * Helpers the game uses to build an OnboardingSnapshot each frame (plain math, no engine types): accumulated view
 * rotation, nose-on-target alignment, and the label of an action's current binding.
 */
import type { ActionId } from '../input/actions';
import type { BindingSlots, InputContext } from '../input/bindings';
import { bindingLabel } from '../input/labels';

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
}

/**
 * Label of the first bound slot of an action for the device in use (e.g. "Tab", "Mouse R", "Y"), or the "Not bound"
 * text when neither slot is bound. Pass settings.data and input.activeDevice.
 */
export function actionLabel(source: BindingSource, device: InputContext, id: ActionId): string {
  const slots = (device === 'pad' ? source.padBindings : source.bindings)[id];
  return bindingLabel(slots?.[0] ?? slots?.[1] ?? null);
}
