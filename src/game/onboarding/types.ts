/**
 * What the guided opening needs to know about the game each frame. The game builds one snapshot per frame
 * (gameTour.ts, see docs/ONBOARDING.md "Integration"); the demo page (onboarding.html) fakes it. Plain data, no engine
 * types, so the tour logic runs in unit tests without a renderer.
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
  /** Display name of the nearest body. */
  nearName: string;
  /** Catalogue kind of the nearest body ('planet', 'moon', 'star', ...). */
  nearKind: string;
  /** Mean radius of the nearest body (m). */
  nearRadiusM: number;
  /** Height above the nearest body's mean radius (m), as SolarSystem.nearest reports it. */
  altitudeM: number;
  /** Height above the ground below (m), as the HUD shows it. */
  aglM: number;
  landed: boolean;
  /** Auto-align is holding the nose on the target. */
  autoAlign: boolean;
  /** Current target: a body id ('301' is the Moon) or a catalogue star ('*<index>'). */
  targetId: string | null;
  /** Display name of the target. */
  targetName: string | null;
  /** Target kind from the body catalogue ('planet', 'moon', 'star', ...). */
  targetKind: string | null;
  /** Distance from the ship to the target's surface (m). */
  targetDistanceM: number | null;
  /** The nose points at the target (see isAligned in snapshot.ts): within 3 degrees, or anywhere on its disc. */
  alignedToTarget: boolean;
  /** Angle between the nose and the target's centre (rad); null without a target. */
  targetOffNoseRad: number | null;
  /**
   * Display name of a body in the way of a non-star target: flown straight at the target, a drive would drop out at
   * that body's surface (see pathBlocker in snapshot.ts). Null when the way is clear.
   */
  targetBlockedBy: string | null;
  /** Display name of the nearest body when flying along the nose would run into it (drop-out height); else null. */
  noseBlockedBy: string | null;
  mapOpen: boolean;
  /** Which map is showing while it is open. */
  mapMode: 'system' | 'stars' | null;
  codexOpen: boolean;
  hyperPhase: OnboardingHyperPhase;
  /** Anchor of the ship's position: a body id, 'ism' during a jump, '*<index>' at a visited star. */
  anchor: string;
  /** The ship has arrived at a star beyond the Solar System (a visited catalogue star or exoplanet system). */
  beyondSol: boolean;
  /** Accumulated rotation of the view (head look plus ship attitude), radians. See LookTracker. */
  lookedAroundRad: number;
  /** Top speed of the thrusters without boost (m/s): a game tunable (FLIGHT.thrustersMaxSpeed in ship.ts). */
  thrustersTopSpeedMS: number;
}

/** Minimal storage surface; window.localStorage satisfies it. */
export interface OnboardingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
