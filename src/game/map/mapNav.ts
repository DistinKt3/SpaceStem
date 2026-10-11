/**
 * Keyboard and gamepad helpers for the map dialog. Pure functions (no DOM), so the rules are unit-tested.
 *
 * While the map is open it owns the keyboard and gamepad: game input is disabled, Tab and the arrow keys move focus
 * through the dialog, and the map closes on Escape, the gamepad Menu or B button, or whatever the player bound to
 * "toggle map" (keyboard, mouse or gamepad).
 */
import type { Binding } from '../input/bindings';

/** The index a list-navigation key moves to from `index` in a list of `count` items, or null if the key is not one. */
export function listStep(key: string, index: number, count: number, page = 10): number | null {
  if (count <= 0) return null;
  const clamp = (i: number): number => Math.max(0, Math.min(count - 1, i));
  switch (key) {
    case 'ArrowDown':
      return clamp(index + 1);
    case 'ArrowUp':
      return clamp(index - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageDown':
      return clamp(index + page);
    case 'PageUp':
      return clamp(index - page);
    default:
      return null;
  }
}

/** True when a keyboard event code triggers this binding (single-key bindings only). */
export function keyTriggers(b: Binding | null, code: string): boolean {
  return b?.type === 'key' && b.code === code;
}

/** True when a mouse button triggers this binding. */
export function mouseTriggers(b: Binding | null, button: number): boolean {
  return b?.type === 'mouseButton' && b.button === button;
}

/** Minimal gamepad shape (tests pass plain objects). */
export interface PadLike {
  readonly connected: boolean;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

const PAD_PRESS = 0.5;

/** True while any connected pad holds the input of a gamepad button binding (or stick-direction binding). */
export function padHolds(b: Binding | null, pads: readonly (PadLike | null)[]): boolean {
  if (!b) return false;
  for (const p of pads) {
    if (!p?.connected) continue;
    if (b.type === 'padButton') {
      const btn = p.buttons[b.button];
      if (btn && (btn.pressed || btn.value > PAD_PRESS)) return true;
    } else if (b.type === 'padAxisDir') {
      if ((p.axes[b.axis] ?? 0) * b.dir > PAD_PRESS) return true;
    }
  }
  return false;
}

/** Radial deadzone for the right stick used to orbit the map camera. */
export const ORBIT_DEADZONE = 0.2;
/** Orbit speed at full stick deflection (radians per second), and the keyboard step per press (radians). */
export const ORBIT_RATE = 1.6;
export const ORBIT_KEY_STEP = 0.12;
/** Zoom per keyboard press (distance factor), and the trigger zoom rate at full pull (factor per second). */
export const ZOOM_KEY_STEP = 1.2;
export const ZOOM_RATE = 2.5;

/** Camera orbit (yaw, pitch in radians) and zoom (distance factor) from the right stick and triggers over `dt` seconds. */
export function padCamera(pads: readonly (PadLike | null)[], dt: number): { yaw: number; pitch: number; zoom: number } {
  let x = 0;
  let y = 0;
  let zin = 0;
  let zout = 0;
  for (const p of pads) {
    if (!p?.connected) continue;
    const ax = p.axes[2] ?? 0;
    const ay = p.axes[3] ?? 0;
    if (Math.hypot(ax, ay) > Math.hypot(x, y)) {
      x = ax;
      y = ay;
    }
    zin = Math.max(zin, p.buttons[7]?.value ?? 0);
    zout = Math.max(zout, p.buttons[6]?.value ?? 0);
  }
  const mag = Math.hypot(x, y);
  const k = mag < ORBIT_DEADZONE ? 0 : (Math.min(1, (mag - ORBIT_DEADZONE) / (1 - ORBIT_DEADZONE)) / mag) * ORBIT_RATE * dt;
  const trig = (v: number): number => (v < 0.06 ? 0 : (v - 0.06) / 0.94);
  return { yaw: x * k, pitch: y * k, zoom: Math.pow(ZOOM_RATE, (trig(zout) - trig(zin)) * dt) };
}

/** Keyboard camera control: Shift+arrows orbit, + and - zoom. Null when the key is not a camera key. */
export function keyCamera(code: string, shift: boolean): { yaw: number; pitch: number; zoom: number } | null {
  if (shift) {
    if (code === 'ArrowLeft') return { yaw: -ORBIT_KEY_STEP, pitch: 0, zoom: 1 };
    if (code === 'ArrowRight') return { yaw: ORBIT_KEY_STEP, pitch: 0, zoom: 1 };
    if (code === 'ArrowUp') return { yaw: 0, pitch: -ORBIT_KEY_STEP, zoom: 1 };
    if (code === 'ArrowDown') return { yaw: 0, pitch: ORBIT_KEY_STEP, zoom: 1 };
  }
  if (code === 'Equal' || code === 'NumpadAdd') return { yaw: 0, pitch: 0, zoom: 1 / ZOOM_KEY_STEP };
  if (code === 'Minus' || code === 'NumpadSubtract') return { yaw: 0, pitch: 0, zoom: ZOOM_KEY_STEP };
  return null;
}

/** Screen-space box (CSS px) for label collision tests. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Horizontal view shift that centres the scene in the area left of the destination list, and the width of that
 * area. `panelLeft`/`panelWidth` are the list's bounding box; `w` is the view width.
 */
export function freeArea(w: number, panelLeft: number, panelWidth: number): { shift: number; width: number } {
  if (!(panelWidth > 0) || panelLeft >= w) return { shift: 0, width: w };
  const width = Math.max(1, Math.min(w, panelLeft));
  return { shift: (w - width) / 2, width };
}

/** Camera distance (in units of the disc radius) that fits a disc into a view area `width` x `h` px (vertical FOV 50°). */
export function fitDistance(width: number, h: number): number {
  // 2.1 radii fits the tilted disc vertically; narrower areas need the camera further back.
  return Math.max(2.1, 2.25 * (h / Math.max(1, width)));
}
