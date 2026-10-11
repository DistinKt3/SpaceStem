/**
 * The guided opening, step by step: Earth orbit, the Moon, then the stars. Each step has a goal the game state can
 * confirm (a predicate over the per-frame snapshot), text keys (onboarding.step.<id>.goal / .hint / .science) and,
 * where the player can get stuck, a contextual nudge. Steps never gate play: they only watch what the player does.
 *
 * Hint templates name actions as {actionId} placeholders, or {actionId+} / {actionId-} for one direction of an axis;
 * the card renders each as a keycap with the player's current binding (labelFor), so a remapped key is always shown
 * correctly.
 *
 * The nudges follow the real flight model (src/game/ship/ship.ts) and hyperspeed rules (src/game/ship/hyperspeed.ts);
 * the constants below mirror them and tests/unit/onboarding.test.ts checks the hyperspeed rule against the engine.
 */
import { LIGHT_YEAR_M } from '../../core/constants';
import { formatDistance } from '../format';
import { formatNumber } from '../i18n';
import type { OnboardingSnapshot } from './types';

export const STEP_IDS = [
  'look',
  'throttle',
  'target',
  'align',
  'cruise',
  'approach',
  'land',
  'map',
  'hyperspeed',
  'done',
] as const;
export type StepId = (typeof STEP_IDS)[number];

/** Body id of the Moon in the catalogue (NAIF id). */
export const MOON_ID = '301';
/** "Approach the Moon" completes within this distance of its surface (m): 20,000 km. */
export const APPROACH_DISTANCE_M = 2e7;
/** Accumulated view rotation that counts as having looked around (rad, about 57 degrees). */
export const LOOK_AROUND_RAD = 1;
/** Throttle setpoint that counts as having throttled up. */
export const THROTTLE_MIN = 0.2;
/**
 * Hyperspeed refuses to engage closer than max(10,000 km, 2 radii) to a planet or moon (docs/DECISIONS.md D-026,
 * Hyperspeed.engage).
 */
export const HYPER_MIN_ALTITUDE_M = 1e7;
/** Hyperspeed refuses a destination star closer than this (Hyperspeed.engage: "Already at this star"). */
export const HYPER_MIN_STAR_DISTANCE_M = 0.01 * LIGHT_YEAR_M;
/** Touchdown needs the throttle at or below this (ship.ts resolveTerrain). */
export const LANDING_THROTTLE_MAX = 0.05;
/** Height above the ground (m) at which the ship counts as resting on it (the terrain clearance is 2.5 m). */
export const ON_GROUND_AGL_M = 5;
/** For a landing the nose points within this angle of the Moon's centre (straight down), as auto-align holds it. */
export const LANDING_NOSE_RAD = (15 * Math.PI) / 180;

/** Altitude below which hyperspeed will not engage near a body (m), as Hyperspeed.engage decides it. */
export function hyperspeedFloorM(nearKind: string, nearRadiusM: number): number {
  return nearKind === 'star' ? 0 : Math.max(HYPER_MIN_ALTITUDE_M, 2 * nearRadiusM);
}

/** A contextual line shown under the hint when the player needs something else first. */
export interface Nudge {
  readonly key: string;
  readonly params?: Readonly<Record<string, string>>;
}

export interface StepDef {
  readonly id: StepId;
  /** Optional steps can be skipped individually, and pass by themselves when the next step's goal is met. */
  readonly optional?: boolean;
  /** When the player reaches this step's goal early, the tour catches up to it instead of nagging about earlier ones. */
  readonly catchUp?: boolean;
  /** Minimum reading time before the step can complete (s); defaults to TourTiming.minDwell. */
  readonly minDwell?: number;
  /** How long the goal must hold without interruption (s); defaults to TourTiming.hold. */
  readonly hold?: number;
  /** The goal, judged from the snapshot. */
  readonly done: (s: OnboardingSnapshot) => boolean;
  readonly nudge?: (s: OnboardingSnapshot) => Nudge | null;
}

const nearMoon = (s: OnboardingSnapshot): boolean =>
  (s.targetId === MOON_ID && s.targetDistanceM !== null && s.targetDistanceM <= APPROACH_DISTANCE_M) ||
  (s.nearKey === 'moon' && s.altitudeM <= APPROACH_DISTANCE_M);

const moonTarget = (s: OnboardingSnapshot): Nudge | null =>
  s.targetId === MOON_ID ? null : { key: 'onboarding.nudge.moonTarget' };

/** A body in the way of the Moon: a drive flown straight at it would drop out at that body first. */
const blocked = (s: OnboardingSnapshot): Nudge | null =>
  s.targetBlockedBy === null
    ? null
    : {
        key: s.autoAlign ? 'onboarding.nudge.blockedAutoAlign' : 'onboarding.nudge.blocked',
        params: { body: s.targetBlockedBy },
      };

/** Thrusters toward the Moon: how long the trip would take at their top speed (a game tunable, not physics). */
const useCruise = (s: OnboardingSnapshot): Nudge => {
  const top = Math.max(1, s.thrustersTopSpeedMS);
  const hours = Math.max(0, (s.targetDistanceM ?? 0) - APPROACH_DISTANCE_M) / top / 3600;
  return {
    key: 'onboarding.nudge.useCruise',
    params: { speed: formatNumber(top / 1000, 1), hours: formatNumber(Math.max(1, Math.round(hours))) },
  };
};

/** On the way to the Moon in a drive: what keeps the pilot from getting there. */
function enRoute(s: OnboardingSnapshot): Nudge | null {
  if (s.targetId !== MOON_ID && s.nearKey !== 'moon') return { key: 'onboarding.nudge.moonTarget' };
  const b = blocked(s);
  if (b) return b;
  if (s.mode === 'thrusters' && s.nearKey !== 'moon') return useCruise(s);
  if (!s.alignedToTarget) return { key: 'onboarding.nudge.realign' };
  if (s.throttle < 0.05) return { key: 'onboarding.nudge.throttle' };
  return null;
}

/**
 * Landing, as the flight model allows it from the tour's attitude (nose on the Moon, often with auto-align): forward
 * thrust carries the ship down along the nose, and touchdown needs the throttle cut while on the ground. Sideways
 * strafing does not descend in this attitude.
 */
function landing(s: OnboardingSnapshot): Nudge | null {
  if (s.landed) return null;
  if (s.nearKey !== 'moon' || s.mode !== 'thrusters') return enRoute(s);
  if (s.targetId !== MOON_ID) return { key: 'onboarding.nudge.moonTarget' };
  if (s.targetOffNoseRad !== null && s.targetOffNoseRad > LANDING_NOSE_RAD) return { key: 'onboarding.nudge.noseDown' };
  if (s.aglM > ON_GROUND_AGL_M) return s.throttle <= 0 ? { key: 'onboarding.nudge.descend' } : null;
  return s.throttle > LANDING_THROTTLE_MAX ? { key: 'onboarding.nudge.settle' } : { key: 'onboarding.nudge.descend' };
}

/** Hyperspeed: on the map, map advice first; back in the cockpit, whatever stands in the way of the jump. */
function toTheStars(s: OnboardingSnapshot): Nudge | null {
  const star = s.targetKind === 'star';
  const tooClose = star && s.targetDistanceM !== null && s.targetDistanceM < HYPER_MIN_STAR_DISTANCE_M;
  if (tooClose) return { key: 'onboarding.nudge.starTooClose', params: { name: s.targetName ?? '' } };
  if (s.mapOpen) {
    if (star) return { key: 'onboarding.nudge.closeMap' };
    return { key: s.mapMode === 'stars' ? 'onboarding.nudge.pickStarInList' : 'onboarding.nudge.pickStarOnMap' };
  }
  if (s.landed) return { key: 'onboarding.nudge.liftOff' };
  if (!star) return { key: 'onboarding.nudge.pickStar' };
  const floor = hyperspeedFloorM(s.nearKind, s.nearRadiusM);
  if (s.altitudeM < floor) {
    // Rounded up to two significant figures, so climbing to the quoted altitude is always enough.
    const p = 10 ** Math.max(0, Math.floor(Math.log10(floor)) - 1);
    return { key: 'onboarding.nudge.gravityWell', params: { alt: formatDistance(Math.ceil(floor / p) * p), body: s.nearName } };
  }
  return null;
}

export const STEPS: readonly StepDef[] = [
  { id: 'look', minDwell: 4, done: (s) => s.lookedAroundRad >= LOOK_AROUND_RAD },
  { id: 'throttle', done: (s) => s.throttle >= THROTTLE_MIN },
  // The game starts with the Moon targeted, so this step often completes at once: the reading time keeps it on screen.
  { id: 'target', minDwell: 4, done: (s) => s.targetId === MOON_ID },
  {
    id: 'align',
    hold: 0.4,
    done: (s) => s.targetId === MOON_ID && s.alignedToTarget,
    nudge: (s) => moonTarget(s) ?? blocked(s),
  },
  { id: 'cruise', done: (s) => s.mode === 'cruise' },
  { id: 'approach', catchUp: true, done: nearMoon, nudge: enRoute },
  { id: 'land', optional: true, catchUp: true, done: (s) => s.landed && s.nearKey === 'moon', nudge: landing },
  { id: 'map', done: (s) => s.mapOpen },
  {
    id: 'hyperspeed',
    catchUp: true,
    done: (s) => s.hyperPhase !== 'idle' || s.beyondSol,
    nudge: toTheStars,
  },
  // The finale: never "done" by itself; it closes after a while or when the player dismisses it.
  { id: 'done', done: () => false },
];

/** Steps that count toward progress (the finale is not one). */
export const COUNTED_STEPS = STEPS.length - 1;
