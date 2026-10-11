/**
 * Pure per-frame cockpit logic, kept free of three.js and the DOM so it is unit tested directly: where the Sun and
 * planet markers sit on the attitude display, and the instrument colour and brightness for an alert level.
 */
import { emissionFor, srgbToLinear, hexToSrgb, type RGB } from './tone';

/** The display accent and the alert colours, as the pilot should see them on screen (sRGB). */
export const ACCENT_HEX = '#7fd4ff';
export const AMBER_HEX = '#ffb03a';
export const RED_HEX = '#ff3b30';

/**
 * Linear HDR emission for a fully lit display line. Chosen so that, after FrameRenderer's AgX tone mapping, lines show
 * the accent's hue and saturation (AgX cannot show a saturated colour at full brightness, so lines land at ~85 % of
 * the accent's value; the bloom halo brightens them slightly).
 */
export const ACCENT_EMISSION: RGB = emissionFor(ACCENT_HEX, 0.7);
export const AMBER_EMISSION: RGB = emissionFor(AMBER_HEX, 0.66);
export const RED_EMISSION: RGB = emissionFor(RED_HEX, 0.66);

/** Plain linear colours, for light cast by the displays onto nearby surfaces (no tone-map compensation). */
export const ACCENT_LIGHT: RGB = hexToSrgb(ACCENT_HEX).map(srgbToLinear) as RGB;
export const AMBER_LIGHT: RGB = hexToSrgb(AMBER_HEX).map(srgbToLinear) as RGB;
export const RED_LIGHT: RGB = hexToSrgb(RED_HEX).map(srgbToLinear) as RGB;

export const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

const lerp3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export interface PanelLook {
  /** Emission colour of a fully lit display line (linear HDR, tone-map compensated). */
  emission: RGB;
  /** Colour of the light the displays cast (linear). */
  light: RGB;
  /** Brightness multiplier (the alert pulse dims and brightens the displays). */
  gain: number;
  /** 0 calm .. 1 fully in alert colours. */
  toAlert: number;
}

/**
 * Instrument colour for an alert level (clamped to 0..1) at a time (seconds). Calm displays use the accent; from
 * alert ~0.05 they turn amber, shading to red as the level rises, and pulse at 1.1 Hz between the two with a
 * brightness beat. Under reduced motion nothing pulses: the colour and brightness depend on the alert level only.
 */
export function panelLook(alert: number, time: number, reducedMotion: boolean): PanelLook {
  const a = clamp01(Number.isFinite(alert) ? alert : 0);
  const beat = reducedMotion ? 0.5 : 0.5 - 0.5 * Math.cos(time * Math.PI * 2 * 1.1);
  const hue = clamp01(a * 0.7 + (reducedMotion ? 0.15 : 0.3) * beat * a);
  const t = clamp01((a - 0.04) / 0.18);
  const toAlert = t * t * (3 - 2 * t);
  const emission = lerp3(ACCENT_EMISSION, lerp3(AMBER_EMISSION, RED_EMISSION, hue), toAlert);
  const light = lerp3(ACCENT_LIGHT, lerp3(AMBER_LIGHT, RED_LIGHT, hue), toAlert);
  const gain = 1 - toAlert * (reducedMotion ? 0.1 : 0.4 * beat);
  return { emission, light, gain, toAlert };
}

/** Attitude display geometry, in display pixels (see displayAtlas LAYOUT.attitude). */
export interface AttitudeGeometry {
  cx: number;
  cy: number;
  /** Radius of the ring for directions 90 degrees from the nose. */
  r90: number;
  /** Radius of the outer ring; directions straight behind sit just inside it. */
  rMax: number;
}

/**
 * Marker position on the attitude display for a direction in ship-local axes (-Z forward, +Y up, +X right): a polar
 * plot centred on the nose, with the radius proportional to the angle from the nose (linear to r90 at 90 degrees,
 * then compressed toward the outer ring for directions behind) and the bearing matching the direction's roll angle
 * (up is up, right is right). Returns [x, y] in display pixels (y down), or null for a zero vector.
 */
export function attitudeMarker(d: { x: number; y: number; z: number }, A: AttitudeGeometry): [number, number] | null {
  const len = Math.hypot(d.x, d.y, d.z);
  if (!(len > 1e-9)) return null;
  const x = d.x / len;
  const y = d.y / len;
  const z = d.z / len;
  const deg = Math.acos(Math.min(1, Math.max(-1, -z))) / (Math.PI / 180);
  const roll = Math.atan2(x, y);
  const r = deg <= 90 ? (A.r90 * deg) / 90 : A.r90 + ((A.rMax - 4 - A.r90) * (deg - 90)) / 90;
  return [A.cx + Math.sin(roll) * r, A.cy - Math.cos(roll) * r];
}

/**
 * How a percent readout is laid out in this locale, from a translatable pattern such as '{value}%', '{value} %' or
 * '%{value}': the unit text, whether it comes before the number, and whether a space separates them.
 */
export function percentLayout(pattern: string): { unit: string; before: boolean; gap: boolean } {
  const i = pattern.indexOf('{value}');
  if (i < 0) return { unit: '%', before: false, gap: false };
  const prefix = pattern.slice(0, i);
  const suffix = pattern.slice(i + '{value}'.length);
  const before = prefix.trim().length > 0 && suffix.trim().length === 0;
  const unit = (before ? prefix : suffix).trim() || '%';
  const gap = before ? /\s$/u.test(prefix) : /^\s/u.test(suffix);
  return { unit, before, gap };
}
