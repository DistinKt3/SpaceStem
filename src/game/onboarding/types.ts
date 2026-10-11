/**
 * What the guided opening needs to know about the game each frame. The game builds one snapshot per frame (see
 * docs/ONBOARDING.md, "Integration"); the demo page (onboarding.html) fakes it. Plain data, no engine types, so the
 * tour logic runs in unit tests without a renderer.
 */
export type OnboardingMode = 'thrusters' | 'impulse' | 'cruise' | 'hyperspeed';
export type OnboardingHyperPhase = 'idle' | 'spool' | 'jump';

export interface OnboardingSnapshot {
  /** Simulation time (s); informational, the tour times itself from update(dt). */
  t: number;
  mode: OnboardingMode;
  /** Throttle setpoint, -0.5..1. */
  throttle: number;
  /** Ship speed relative to the reference frame the HUD reports (m/s). */
  speed: number;
  /** Key of the nearest body ('earth', 'moon', ...). */
  nearKey: string;
  /** Height above the nearest body's mean radius (m), as SolarSystem.nearest reports it. */
  altitudeM: number;
  landed: boolean;
  /** Current target: a body id ('301' is the Moon) or a catalogue star ('*<index>'). */
  targetId: string | null;
  /** Target kind from the body catalogue ('planet', 'moon', 'star', ...). */
  targetKind: string | null;
  /** Distance from the ship to the target's surface (m). */
  targetDistanceM: number | null;
  /** The nose points at the target (see isAligned in snapshot.ts). */
  alignedToTarget: boolean;
  mapOpen: boolean;
  codexOpen: boolean;
  hyperPhase: OnboardingHyperPhase;
  /** Anchor of the ship's position: a body id, 'ism' during a jump, '*<index>' at a visited star. */
  anchor: string;
  /** Accumulated rotation of the view (head look plus ship attitude), radians. See LookTracker. */
  lookedAroundRad: number;
}

/** Minimal storage surface; window.localStorage satisfies it. */
export interface OnboardingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
