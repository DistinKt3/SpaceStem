/**
 * Pure parameter mappings from ship state to sound. No Web Audio here, so every curve is unit-tested.
 *
 * The listening rule (PRD Q9, "honest silence"):
 * - Space is silent. Nothing outside the ship is ever heard directly in vacuum.
 * - Inside, the cabin always hums and the instruments make small tones.
 * - Anything from the drive reaches the pilot as vibration carried by the hull: low, low-passed, felt more than heard.
 * - Wind exists only where there is air: it scales with outside density x airspeed and is zero in vacuum.
 */
import type { AudioState } from './audioEngine';

export const DRIVE_MODES = ['thrusters', 'impulse', 'cruise', 'hyperspeed'] as const;

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number): number => clamp(x, 0, 1);
/** Replace NaN/Infinity with a fallback. */
export const finite = (x: unknown, fallback = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export const DEFAULT_STATE: AudioState = {
  thrust: 0,
  rcs: 0,
  mode: 'thrusters',
  speedFraction: 0,
  hyperspeed: 0,
  atmosphereDensity: 0,
  airspeed: 0,
  scoopHeat: 0,
  landed: false,
};

/** Clamp every field to its documented range; NaN, Infinity and unknown modes fall back to safe values. */
export function sanitizeState(s: Partial<AudioState> | null | undefined): AudioState {
  const src = s ?? {};
  const mode = DRIVE_MODES.includes(src.mode as AudioState['mode']) ? (src.mode as AudioState['mode']) : 'thrusters';
  return {
    thrust: clamp01(finite(src.thrust)),
    rcs: clamp01(finite(src.rcs)),
    mode,
    speedFraction: clamp01(finite(src.speedFraction)),
    hyperspeed: clamp01(finite(src.hyperspeed)),
    atmosphereDensity: clamp01(finite(src.atmosphereDensity)),
    airspeed: clamp(finite(src.airspeed), 0, 20_000),
    scoopHeat: clamp01(finite(src.scoopHeat)),
    landed: src.landed === true,
  };
}

/** Frame time guard: NaN/negative -> 0, long stalls capped. */
export const sanitizeDt = (dt: number): number => clamp(finite(dt), 0, 0.25);

/** Slider value 0..1 to linear gain. Square law approximates perceived loudness and keeps the low end usable. */
export const volumeToGain = (v: number): number => {
  const x = clamp01(finite(v));
  return x * x;
};

/** Reference dynamic "pressure" (density x airspeed, m/s at sea-level density) for the wind curve knee. */
export const WIND_Q_REF = 90;

/** Wind intensity 0..1: zero in vacuum or still air, saturating smoothly as density x airspeed grows. */
export function windIntensity(density: number, airspeed: number): number {
  const q = Math.max(0, finite(density)) * Math.max(0, finite(airspeed));
  return 1 - Math.exp(-q / WIND_Q_REF);
}

export interface EngineMix {
  /** Sub-bass hull rumble oscillator. */
  rumbleGain: number;
  rumbleHz: number;
  /** Low-passed brown-noise roar. */
  noiseGain: number;
  noiseCutoff: number;
  /** Tonal drive hum (stronger in impulse and cruise). */
  toneGain: number;
  toneHz: number;
  /** Everything passes a hull low-pass: vibration carried through the structure. */
  hullCutoff: number;
}

interface ModeCharacter {
  rumbleHz: [number, number];
  noise: number;
  tone: number;
  toneHz: [number, number];
  cutoff: [number, number];
}
const CHARACTER: Record<AudioState['mode'], ModeCharacter> = {
  thrusters: { rumbleHz: [34, 52], noise: 1, tone: 0.2, toneHz: [68, 96], cutoff: [140, 600] },
  impulse: { rumbleHz: [41, 62], noise: 0.55, tone: 0.75, toneHz: [82, 128], cutoff: [150, 480] },
  cruise: { rumbleHz: [44, 64], noise: 0.35, tone: 1, toneHz: [92, 132], cutoff: [160, 420] },
  hyperspeed: { rumbleHz: [44, 64], noise: 0.25, tone: 0.6, toneHz: [92, 132], cutoff: [150, 380] },
};

export function engineMix(s: AudioState): EngineMix {
  const c = CHARACTER[s.mode];
  const t = s.thrust;
  // In hyperspeed the hyperspeed layer carries the drive; the main engine recedes.
  const modeGain = s.mode === 'hyperspeed' ? 0.35 : 1;
  const level = Math.pow(t, 0.75) * modeGain;
  const speedLift = s.mode === 'cruise' ? 1 + 0.35 * s.speedFraction : 1;
  return {
    rumbleGain: 0.08 * level,
    rumbleHz: c.rumbleHz[0] + (c.rumbleHz[1] - c.rumbleHz[0]) * t,
    noiseGain: 0.26 * c.noise * level,
    noiseCutoff: c.cutoff[0] + (c.cutoff[1] - c.cutoff[0]) * t,
    toneGain: 0.045 * c.tone * level,
    toneHz: (c.toneHz[0] + (c.toneHz[1] - c.toneHz[0]) * t) * speedLift,
    hullCutoff: 380 + 420 * t,
  };
}

export interface RcsMix {
  gain: number;
  /** Band centre of the valve hiss as heard through the hull. */
  centerHz: number;
}
export function rcsMix(s: AudioState): RcsMix {
  return { gain: 0.18 * Math.pow(s.rcs, 0.8), centerHz: 700 + 500 * s.rcs };
}

export interface WindMix {
  intensity: number;
  gain: number;
  /** Broad body of the wind (band-pass centre). */
  bodyHz: number;
  /** Narrow whistle resonance. */
  whistleHz: number;
  whistleGain: number;
  /** Hull/canopy low-pass. */
  cutoff: number;
  /** Depth of the slow gust modulation, 0..1. */
  gust: number;
}
export function windMix(s: AudioState): WindMix {
  const i = windIntensity(s.atmosphereDensity, s.airspeed);
  return {
    intensity: i,
    gain: 0.3 * Math.pow(i, 1.3),
    bodyHz: 260 + 1300 * i,
    whistleHz: 700 + 2300 * i,
    whistleGain: 0.35 * smoothstep(0.15, 0.8, i),
    cutoff: 900 + 4600 * i,
    gust: 0.25 + 0.35 * (1 - i),
  };
}

export interface HeatMix {
  /** Low structural groan. */
  groanGain: number;
  groanHz: number;
  /** Faint high tick/sizzle of hot panels. */
  sizzleGain: number;
}
export function heatMix(s: AudioState): HeatMix {
  const h = smoothstep(0.25, 1, s.scoopHeat);
  return { groanGain: 0.36 * Math.pow(h, 1.5), groanHz: 70 + 50 * h, sizzleGain: 0.035 * h * h };
}

export interface HyperMix {
  /** Rising filtered spool tone. */
  spoolGain: number;
  spoolHz: number;
  spoolCutoff: number;
  /** Deep engaged drone through the hull. */
  droneGain: number;
}
export function hyperMix(s: AudioState): HyperMix {
  const h = s.hyperspeed;
  const engaged = s.mode === 'hyperspeed' ? smoothstep(0.85, 1, h) : smoothstep(0.92, 1, h) * 0.6;
  return {
    spoolGain: 0.06 * smoothstep(0.02, 0.25, h) * (1 - 0.75 * engaged),
    spoolHz: 40 + 130 * Math.pow(h, 1.5),
    spoolCutoff: 160 + 2400 * h,
    droneGain: 0.05 * engaged,
  };
}

export interface CabinMix {
  humGain: number;
  /** Life-support air (low-passed pink noise). */
  airGain: number;
  /** Avionics cooling fan (band-passed noise). */
  fanGain: number;
}
export function cabinMix(s: AudioState): CabinMix {
  const settled = s.landed ? 0.8 : 1;
  return { humGain: 0.012 * settled, airGain: 0.025, fanGain: 0.006 };
}

/** Pad filter cutoff (Hz) for a chord brightness 0..1. */
export const padCutoff = (brightness: number): number => 700 + 1500 * clamp01(finite(brightness, 0.5));
