/**
 * The guided opening, step by step: Earth orbit, the Moon, then the stars. Each step has a goal the game state can
 * confirm (a predicate over the per-frame snapshot), text keys (onboarding.step.<id>.goal / .hint / .science) and,
 * where the player can get stuck, a contextual nudge. Steps never gate play: they only watch what the player does.
 *
 * Hint templates name actions as {actionId} placeholders; the card renders each as a keycap with the player's current
 * binding (labelFor), so a remapped key is always shown correctly.
 */
import { t } from '../i18n';
import type { OnboardingSnapshot } from './types';

export const STEP_IDS = ['look', 'throttle', 'target', 'align', 'cruise', 'approach', 'land', 'map', 'hyperspeed', 'done'] as const;
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
 * Hyperspeed refuses to engage closer than max(10,000 km, 2 radii) to a planet or moon (docs/DECISIONS.md D-026).
 * The card nudges below the 10,000 km floor; the HUD reports the exact refusal for larger bodies.
 */
export const HYPER_MIN_ALTITUDE_M = 1e7;

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

/** Body keys of stars: the Sun, and catalogue stars made into bodies when visited ('star-<index>'). */
const isStarKey = (key: string): boolean => key === 'sun' || key.startsWith('star-');

const moonTarget = (s: OnboardingSnapshot): Nudge | null => (s.targetId === MOON_ID ? null : { key: 'onboarding.nudge.moonTarget' });

export const STEPS: readonly StepDef[] = [
  { id: 'look', minDwell: 4, done: (s) => s.lookedAroundRad >= LOOK_AROUND_RAD },
  { id: 'throttle', done: (s) => s.throttle >= THROTTLE_MIN },
  // The game starts with the Moon targeted, so this step often completes at once: the reading time keeps it on screen.
  { id: 'target', minDwell: 4, done: (s) => s.targetId === MOON_ID },
  { id: 'align', hold: 0.4, done: (s) => s.targetId === MOON_ID && s.alignedToTarget, nudge: moonTarget },
  { id: 'cruise', done: (s) => s.mode === 'cruise' },
  {
    id: 'approach',
    catchUp: true,
    done: nearMoon,
    nudge: (s) => {
      if (s.targetId !== MOON_ID && s.nearKey !== 'moon') return { key: 'onboarding.nudge.moonTarget' };
      if (s.mode === 'thrusters' && s.nearKey !== 'moon') return { key: 'onboarding.nudge.useCruise' };
      if (!s.alignedToTarget) return { key: 'onboarding.nudge.realign' };
      if (s.throttle < 0.05) return { key: 'onboarding.nudge.throttle' };
      return null;
    },
  },
  { id: 'land', optional: true, catchUp: true, done: (s) => s.landed && s.nearKey === 'moon' },
  { id: 'map', done: (s) => s.mapOpen },
  {
    id: 'hyperspeed',
    catchUp: true,
    done: (s) => s.hyperPhase !== 'idle' || s.anchor.startsWith('*'),
    nudge: (s) => {
      if (s.landed) return { key: 'onboarding.nudge.liftOff' };
      if (s.targetKind !== 'star') return { key: s.mapOpen ? 'onboarding.nudge.pickStarOnMap' : 'onboarding.nudge.pickStar' };
      if (s.mapOpen) return { key: 'onboarding.nudge.closeMap' };
      if (s.altitudeM < HYPER_MIN_ALTITUDE_M && !isStarKey(s.nearKey)) {
        return { key: 'onboarding.nudge.gravityWell', params: { body: t(`body.${s.nearKey}`) } };
      }
      return null;
    },
  },
  // The finale: never "done" by itself; it closes after a while or when the player dismisses it.
  { id: 'done', done: () => false },
];

/** Steps that count toward progress (the finale is not one). */
export const COUNTED_STEPS = STEPS.length - 1;
