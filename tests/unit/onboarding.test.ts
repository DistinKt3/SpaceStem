import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACTIONS, ACTION_IDS, defaultBindings, isActionId } from '../../src/game/input/actions';
import type { BindingSlots } from '../../src/game/input/bindings';
import { t } from '../../src/game/i18n';
import { FACTS, circularSpeed, factParams, orbitPeriod } from '../../src/game/onboarding/facts';
import {
  ALIGN_TOLERANCE_RAD,
  LookTracker,
  actionLabel,
  angleBetween,
  bindingHalfLabel,
  dropOutClearanceM,
  elevation,
  isAligned,
  openingUp,
  pathBlocker,
} from '../../src/game/onboarding/snapshot';
import {
  APPROACH_DISTANCE_M,
  HYPER_MIN_STAR_DISTANCE_M,
  MOON_ID,
  STEPS,
  STEP_IDS,
  hyperspeedFloorM,
  type StepId,
} from '../../src/game/onboarding/steps';
import { Vec3d } from '../../src/core/vec3d';
import { Hyperspeed } from '../../src/game/ship/hyperspeed';
import type { Ship } from '../../src/game/ship/ship';
import type { SolarSystem } from '../../src/world/solarSystem';
import {
  DEFAULT_TIMING,
  ONBOARDING_STORAGE_KEY,
  TourMachine,
  parsePersisted,
  type TourTiming,
} from '../../src/game/onboarding/tour';
import type { OnboardingSnapshot, OnboardingStorage } from '../../src/game/onboarding/types';

class MemoryStorage implements OnboardingStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class BrokenStorage implements OnboardingStorage {
  getItem(): string | null {
    throw new Error('SecurityError');
  }
  setItem(): void {
    throw new Error('QuotaExceededError');
  }
  removeItem(): void {
    throw new Error('SecurityError');
  }
}

/** The opening: 420 km above Earth, Moon targeted, nothing done yet. */
const BASE: OnboardingSnapshot = {
  t: 0,
  mode: 'thrusters',
  throttle: 0,
  speed: 0,
  nearKey: 'earth',
  nearName: 'Earth',
  nearKind: 'planet',
  nearRadiusM: 6.371e6,
  altitudeM: 420e3,
  aglM: 420e3,
  landed: false,
  autoAlign: false,
  targetId: MOON_ID,
  targetName: 'Moon',
  targetKind: 'moon',
  targetDistanceM: 3.76e8,
  alignedToTarget: false,
  targetOffNoseRad: 1,
  targetBlockedBy: null,
  mapOpen: false,
  mapMode: null,
  codexOpen: false,
  hyperPhase: 'idle',
  anchor: '399',
  beyondSol: false,
  lookedAroundRad: 0,
  thrustersTopSpeedMS: 3000,
};

const snap = (patch: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot => ({ ...BASE, ...patch });

/** Snapshots that satisfy each step's goal, cumulatively (as a real playthrough would). */
const GOAL: Record<Exclude<StepId, 'done'>, Partial<OnboardingSnapshot>> = {
  look: { lookedAroundRad: 1.2 },
  throttle: { lookedAroundRad: 1.2, throttle: 0.4 },
  target: { throttle: 0.4 },
  align: { throttle: 0.4, alignedToTarget: true },
  cruise: { throttle: 0.4, alignedToTarget: true, mode: 'cruise' },
  approach: {
    throttle: 0.4,
    alignedToTarget: true,
    mode: 'cruise',
    nearKey: 'moon',
    altitudeM: 1.5e7,
    targetDistanceM: 1.5e7,
  },
  land: {
    mode: 'thrusters',
    nearKey: 'moon',
    altitudeM: 2.5,
    targetDistanceM: 2.5,
    landed: true,
    alignedToTarget: true,
  },
  map: { nearKey: 'moon', altitudeM: 2.5, targetDistanceM: 2.5, landed: true, mapOpen: true },
  hyperspeed: {
    nearKey: 'moon',
    altitudeM: 4e7,
    targetId: '*1',
    targetKind: 'star',
    targetDistanceM: 4e16,
    hyperPhase: 'spool',
  },
};

const FAST: TourTiming = { minDwell: 1, hold: 0.25, grace: 1.5, doneLinger: 10 };

function run(m: TourMachine, seconds: number, s: OnboardingSnapshot, dt = 0.05): void {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += dt) m.update(dt, s);
}

/** Runs until the step changes (at most 20 s of game time). */
function advance(m: TourMachine, s: OnboardingSnapshot): void {
  const from = m.stepId;
  for (let i = 0; i < 400 && m.stepId === from; i++) m.update(0.05, s);
}

function machine(
  storage: OnboardingStorage | null = new MemoryStorage(),
  timing: Partial<TourTiming> = FAST,
  log?: string[],
): TourMachine {
  return new TourMachine({ storage, timing, ...(log ? { onStepChange: (id: string) => log.push(id) } : {}) });
}

function stored(storage: MemoryStorage): Record<string, unknown> | null {
  const text = storage.getItem(ONBOARDING_STORAGE_KEY);
  return text === null ? null : (JSON.parse(text) as Record<string, unknown>);
}

describe('onboarding tour: state machine', () => {
  it('starts at the first step and remembers it', () => {
    const storage = new MemoryStorage();
    const m = machine(storage);
    expect(m.active).toBe(false);
    expect(m.stepId).toBeNull();
    expect(m.start()).toBe(true);
    expect(m.active).toBe(true);
    expect(m.stepId).toBe('look');
    expect(m.phase).toBe('pending');
    expect(stored(storage)).toEqual({ v: 1, status: 'active', step: 'look', collapsed: false });
    expect(m.progress()).toMatchObject({ index: 0, total: STEP_IDS.length - 1 });
  });

  it('advances only after the reading time, the hold and the grace delay', () => {
    const m = machine();
    m.start();
    const done = snap(GOAL.look);
    // The goal is met at once, but the step stays for its reading time (look: 4 s).
    run(m, 3.9, done);
    expect(m.stepId).toBe('look');
    expect(m.phase).toBe('pending');
    let waited = 0;
    while (m.phase === 'pending' && waited < 1) {
      m.update(0.01, done);
      waited += 0.01;
    }
    expect(m.phase).toBe('complete');
    expect(waited).toBeLessThan(0.15);
    expect(m.progress().done[0]).toBe(true);
    // Completed steps stay on screen, ticked, for the grace delay.
    run(m, 1.45, done, 0.01);
    expect(m.stepId).toBe('look');
    run(m, 0.1, done, 0.01);
    expect(m.stepId).toBe('throttle');
    expect(m.phase).toBe('pending');
  });

  it('keeps showing a completed step through the grace delay even if the goal lapses', () => {
    const m = machine();
    m.start();
    run(m, 4.5, snap(GOAL.look));
    expect(m.phase).toBe('complete');
    run(m, 1.6, snap());
    expect(m.stepId).toBe('throttle');
  });

  it('ignores goals that flicker for less than the hold time', () => {
    const m = machine(new MemoryStorage(), { ...FAST, hold: 0.5 });
    m.start();
    run(m, 5, snap());
    for (let i = 0; i < 40; i++) {
      m.update(0.05, snap(GOAL.look));
      m.update(0.05, snap());
    }
    expect(m.phase).toBe('pending');
    run(m, 0.6, snap(GOAL.look));
    expect(m.phase).toBe('complete');
  });

  it('plays through every step in order and finishes', () => {
    const storage = new MemoryStorage();
    const log: string[] = [];
    const m = machine(storage, FAST, log);
    m.start();
    for (const id of STEP_IDS.slice(0, -1) as Exclude<StepId, 'done'>[]) {
      expect(m.stepId).toBe(id);
      advance(m, snap(GOAL[id]));
    }
    expect(m.stepId).toBe('done');
    expect(m.finale).toBe(true);
    expect(stored(storage)?.['status']).toBe('done');
    expect(log).toEqual([...STEP_IDS]);
    expect(m.progress().done.every(Boolean)).toBe(true);
    // The closing card goes away by itself.
    run(m, FAST.doneLinger + 0.1, snap(GOAL.hyperspeed));
    expect(m.active).toBe(false);
    expect(m.stepId).toBeNull();
    // A finished tour does not start again.
    expect(m.start()).toBe(false);
    expect(machine(storage).start()).toBe(false);
  });

  it('skip ends the tour and is remembered', () => {
    const storage = new MemoryStorage();
    const log: string[] = [];
    const m = machine(storage, FAST, log);
    m.start();
    run(m, 6, snap(GOAL.look));
    m.skip();
    expect(m.active).toBe(false);
    expect(m.status).toBe('skipped');
    expect(log.at(-1)).toBe('skipped');
    expect(stored(storage)?.['status']).toBe('skipped');
    expect(m.start()).toBe(false);
    // A new session reads the choice back.
    const next = machine(storage);
    expect(next.status).toBe('skipped');
    expect(next.start()).toBe(false);
    expect(next.active).toBe(false);
  });

  it('skip on the closing card only closes it', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({ v: 1, status: 'active', step: 'hyperspeed', collapsed: false }),
    );
    const m = machine(storage);
    m.start();
    run(m, 4, snap(GOAL.hyperspeed));
    expect(m.stepId).toBe('done');
    m.skip();
    expect(m.active).toBe(false);
    expect(stored(storage)?.['status']).toBe('done');
  });

  it('resumes at the remembered step in a new session', () => {
    const storage = new MemoryStorage();
    const m = machine(storage);
    m.start();
    advance(m, snap(GOAL.look));
    advance(m, snap(GOAL.throttle));
    advance(m, snap(GOAL.target));
    expect(m.stepId).toBe('align');
    m.setCollapsed(true);
    const next = machine(storage);
    expect(next.active).toBe(false);
    expect(next.start()).toBe(true);
    expect(next.stepId).toBe('align');
    expect(next.collapsed).toBe(true);
    expect(next.progress().done.slice(0, 4)).toEqual([true, true, true, false]);
  });

  it.each([
    ['not JSON', '{oops'],
    ['an array', '[1,2]'],
    ['null', 'null'],
    ['a future version', JSON.stringify({ v: 99, status: 'active', step: 'align' })],
    ['an unknown status', JSON.stringify({ v: 1, status: 'paused', step: 'align' })],
    ['an unknown step', JSON.stringify({ v: 1, status: 'active', step: 'warp-drive' })],
    ['a wrong-typed step', JSON.stringify({ v: 1, status: 'active', step: 3 })],
  ])('starts fresh when stored progress is %s', (_, text) => {
    const storage = new MemoryStorage();
    storage.setItem(ONBOARDING_STORAGE_KEY, text);
    const m = machine(storage);
    expect(m.loadIssue).toBe('corrupt');
    expect(m.status).toBe('new');
    expect(m.start()).toBe(true);
    expect(m.stepId).toBe('look');
    // The bad record is replaced by a valid one.
    expect(stored(storage)).toEqual({ v: 1, status: 'active', step: 'look', collapsed: false });
  });

  it('keeps working when storage throws', () => {
    const m = machine(new BrokenStorage());
    expect(m.loadIssue).toBe('unavailable');
    expect(m.start()).toBe(true);
    run(m, 6, snap(GOAL.look));
    expect(m.stepId).toBe('throttle');
    expect(() => m.setCollapsed(true)).not.toThrow();
    expect(() => m.skip()).not.toThrow();
    expect(() => m.reset()).not.toThrow();
    expect(machine(null).start()).toBe(true);
  });

  it('reset forgets progress and start replays from the first step', () => {
    const storage = new MemoryStorage();
    const m = machine(storage);
    m.start();
    run(m, 6, snap(GOAL.look));
    m.skip();
    m.reset();
    expect(storage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
    expect(m.active).toBe(false);
    expect(m.start()).toBe(true);
    expect(m.stepId).toBe('look');
  });

  it('catches up when the player reaches a later goal early', () => {
    const m = machine();
    m.start();
    run(m, 6, snap(GOAL.look));
    expect(m.stepId).toBe('throttle');
    // Already at the Moon: target, align and cruise no longer matter.
    run(m, 0.5, snap(GOAL.approach));
    expect(m.stepId).toBe('approach');
    expect(m.phase).toBe('complete');
    expect(m.progress().done.slice(0, 6).every(Boolean)).toBe(true);
    run(m, 1.6, snap(GOAL.approach));
    expect(m.stepId).toBe('land');
  });

  it('does not catch up on teaching steps (opening the map early skips nothing)', () => {
    const m = machine();
    m.start();
    run(m, 6, snap({ ...GOAL.look, mapOpen: true }));
    expect(m.stepId).toBe('throttle');
    run(m, 3, snap({ mapOpen: true }));
    expect(m.stepId).toBe('throttle');
  });

  it('passes the optional landing when the player moves on, or on request', () => {
    const storage = new MemoryStorage();
    storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ v: 1, status: 'active', step: 'land', collapsed: false }));
    const m = machine(storage);
    m.start();
    expect(m.step?.optional).toBe(true);
    run(m, 0.5, snap({ nearKey: 'moon', altitudeM: 1e6, mapOpen: true }));
    expect(m.stepId).toBe('map');
    expect(m.phase).toBe('complete');

    const again = machine(new MemoryStorage());
    again.start();
    expect(again.skipStep()).toBe(false); // 'look' is not optional
    const s2 = new MemoryStorage();
    s2.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ v: 1, status: 'active', step: 'land', collapsed: false }));
    const m2 = machine(s2);
    m2.start();
    expect(m2.skipStep()).toBe(true);
    expect(m2.stepId).toBe('map');
    expect(m2.phase).toBe('pending');
  });

  it('landing on Earth does not count as landing on the Moon', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({ v: 1, status: 'active', step: 'throttle', collapsed: false }),
    );
    const m = machine(storage);
    m.start();
    run(m, 0.5, snap({ landed: true, nearKey: 'earth', altitudeM: 2.5 }));
    expect(m.stepId).toBe('throttle');
  });

  it('reads parsePersisted defensively', () => {
    expect(parsePersisted(null)).toBeNull();
    expect(parsePersisted(JSON.stringify({ v: 1, status: 'done', step: 'nope' }))).toEqual({
      v: 1,
      status: 'done',
      step: 'look',
      collapsed: false,
    });
    expect(parsePersisted(JSON.stringify({ v: 1, status: 'active', step: 'map', collapsed: 'yes' }))?.collapsed).toBe(
      false,
    );
  });

  it('uses sensible default timing', () => {
    expect(DEFAULT_TIMING.grace).toBeGreaterThan(0.5);
    expect(DEFAULT_TIMING.grace).toBeLessThan(3);
    expect(DEFAULT_TIMING.hold).toBeLessThan(DEFAULT_TIMING.grace);
  });
});

describe('onboarding tour: steps and nudges', () => {
  const step = (id: StepId) => STEPS.find((s) => s.id === id)!;

  it('judges goals from the snapshot', () => {
    expect(step('look').done(snap({ lookedAroundRad: 0.5 }))).toBe(false);
    expect(step('target').done(snap({ targetId: '499' }))).toBe(false);
    expect(step('target').done(snap())).toBe(true);
    expect(step('align').done(snap({ alignedToTarget: true, targetId: '499' }))).toBe(false);
    expect(step('approach').done(snap({ targetDistanceM: APPROACH_DISTANCE_M + 1 }))).toBe(false);
    expect(step('approach').done(snap({ targetDistanceM: APPROACH_DISTANCE_M }))).toBe(true);
    expect(step('approach').done(snap({ targetId: '499', nearKey: 'moon', altitudeM: 1e6 }))).toBe(true);
    expect(step('hyperspeed').done(snap({ anchor: '*42', beyondSol: true }))).toBe(true);
    expect(step('done').done(snap())).toBe(false);
  });

  it('nudges a pilot who is stuck', () => {
    const approach = step('approach').nudge!;
    expect(approach(snap({ targetId: '499' }))?.key).toBe('onboarding.nudge.moonTarget');
    expect(approach(snap())?.key).toBe('onboarding.nudge.useCruise');
    expect(approach(snap({ mode: 'cruise' }))?.key).toBe('onboarding.nudge.realign');
    expect(approach(snap({ mode: 'cruise', alignedToTarget: true }))?.key).toBe('onboarding.nudge.throttle');
    expect(approach(snap({ mode: 'cruise', alignedToTarget: true, throttle: 0.5 }))).toBeNull();
  });

  it('states the thrusters trip time as a property of the game drive, computed from its top speed (review)', () => {
    const n = step('approach').nudge!(snap())!;
    expect(n.key).toBe('onboarding.nudge.useCruise');
    // (376,000 km - 20,000 km) at 3 km/s is about 33 hours.
    expect(n.params).toEqual({ speed: '3', hours: '33' });
    const text = t(n.key, { ...n.params, modeNext: 'Space' });
    expect(text).toBe("At the thrusters' top speed (3 km/s) the Moon is about 33 hours away: switch to cruise with Space.");
    expect(text).not.toMatch(/more than a day/);
    // It follows the tunable, not a fixed claim.
    expect(step('approach').nudge!(snap({ thrustersTopSpeedMS: 9000 }))!.params).toEqual({ speed: '9', hours: '11' });
  });

  it('warns when Earth stands between the ship and the Moon, ahead of advice that would fly into it (review)', () => {
    const blocked = { targetBlockedBy: 'Earth' };
    for (const id of ['align', 'approach'] as const) {
      const n = step(id).nudge!(snap(blocked));
      expect(n?.key, id).toBe('onboarding.nudge.blocked');
      expect(n?.params?.['body']).toBe('Earth');
    }
    // Ahead of "use cruise", "realign" and "throttle".
    expect(step('approach').nudge!(snap({ ...blocked, mode: 'cruise', alignedToTarget: true }))?.key).toBe(
      'onboarding.nudge.blocked',
    );
    // With auto-align holding the nose on the Moon, the pilot must switch it off first.
    expect(step('approach').nudge!(snap({ ...blocked, autoAlign: true }))?.key).toBe('onboarding.nudge.blockedAutoAlign');
    expect(t('onboarding.nudge.blocked', { body: 'Earth' })).toContain('Earth is between you and the Moon');
  });

  it('teaches the landing the flight model allows from the tour’s attitude (review)', () => {
    const land = step('land').nudge!;
    const low = { nearKey: 'moon', nearName: 'Moon', nearKind: 'moon', nearRadiusM: 1.7374e6, mode: 'thrusters' as const };
    // Still in the drive on the way in: keep the throttle up and the nose on the Moon.
    expect(land(snap({ ...low, mode: 'cruise', altitudeM: 1e7, aglM: 1e7, alignedToTarget: true }))?.key).toBe(
      'onboarding.nudge.throttle',
    );
    expect(land(snap({ ...low, mode: 'cruise', altitudeM: 1e7, throttle: 1, alignedToTarget: true }))).toBeNull();
    // Dropped out 20 km up, nose off to the side: point it straight down (the Moon's disc alone is not enough).
    const above = { ...low, altitudeM: 2e4, aglM: 2e4, alignedToTarget: true };
    expect(land(snap({ ...above, targetOffNoseRad: 0.6 }))?.key).toBe('onboarding.nudge.noseDown');
    // Nose down, throttle cut: descend with forward thrust.
    expect(land(snap({ ...above, targetOffNoseRad: 0.01 }))?.key).toBe('onboarding.nudge.descend');
    expect(land(snap({ ...above, targetOffNoseRad: 0.01, throttle: 0.3 }))).toBeNull();
    // On the ground with the throttle up: cut it to touch down.
    const ground = { ...above, altitudeM: 2.5, aglM: 2.5, targetOffNoseRad: 0.01 };
    expect(land(snap({ ...ground, throttle: 0.3 }))?.key).toBe('onboarding.nudge.settle');
    expect(land(snap({ ...ground, landed: true }))).toBeNull();
    // The hint names forward thrust and the throttle cut, not the strafe that only slides along the surface.
    const en = JSON.parse(readFileSync('src/game/locales/en.onboarding.json', 'utf8')) as Record<string, string>;
    expect(en['onboarding.step.land.hint']).toContain('{thrust+}');
    expect(en['onboarding.step.land.hint']).toContain('{throttleZero}');
    expect(en['onboarding.step.land.hint']).not.toContain('{strafeY}');
    expect(en['onboarding.step.land.hint.pad']).toContain('{thrust-}');
  });

  it('knows every refusal hyperspeed makes (review)', () => {
    const hyper = step('hyperspeed').nudge!;
    const star = { targetKind: 'star', targetId: '*1', targetName: 'Proxima Centauri', targetDistanceM: 4e16 };
    expect(hyper(snap({ landed: true, ...star }))?.key).toBe('onboarding.nudge.liftOff');
    expect(hyper(snap())?.key).toBe('onboarding.nudge.pickStar');
    // On the map: the system map points to its star-map button; the star map to its list.
    expect(hyper(snap({ mapOpen: true, mapMode: 'system' }))?.key).toBe('onboarding.nudge.pickStarOnMap');
    expect(hyper(snap({ mapOpen: true, mapMode: 'stars' }))?.key).toBe('onboarding.nudge.pickStarInList');
    expect(hyper(snap({ ...star, mapOpen: true, mapMode: 'stars' }))?.key).toBe('onboarding.nudge.closeMap');
    // The Sun is listed as a star but is far too close inside the Solar System.
    const sun = { targetKind: 'star', targetId: '10', targetName: 'Sun', targetDistanceM: 1.49e11 };
    for (const s of [snap(sun), snap({ ...sun, mapOpen: true, mapMode: 'stars' })]) {
      const n = hyper(s);
      expect(n?.key).toBe('onboarding.nudge.starTooClose');
      expect(n?.params?.['name']).toBe('Sun');
    }
    // Earth's floor is two radii (12,742 km), above the 10,000 km minimum: no silent gap between the two.
    const well = hyper(snap({ ...star, altitudeM: 1.1e7 }));
    expect(well?.key).toBe('onboarding.nudge.gravityWell');
    expect(well?.params?.['alt']).toBe('13,000 km');
    expect(hyper(snap({ ...star, altitudeM: 1.28e7 }))).toBeNull();
    // The Moon is small: the 10,000 km floor applies.
    const moon = { nearKey: 'moon', nearName: 'Moon', nearKind: 'moon', nearRadiusM: 1.7374e6 };
    expect(hyper(snap({ ...star, ...moon, altitudeM: 5e6 }))?.params?.['alt']).toBe('10,000 km');
    expect(hyper(snap({ ...star, ...moon, altitudeM: 1.01e7 }))).toBeNull();
    // Near a star (a visited catalogue star or an exoplanet host) there is no floor.
    const host = { nearKey: 'trappist-1', nearName: 'TRAPPIST-1', nearKind: 'star', nearRadiusM: 8.4e7 };
    expect(hyper(snap({ ...star, ...host, altitudeM: 1e6 }))).toBeNull();
  });

  it('counts arriving at an exoplanet system as reaching the stars', () => {
    expect(step('hyperspeed').done(snap({ anchor: 'trappist-1', beyondSol: true }))).toBe(true);
    expect(step('hyperspeed').done(snap({ anchor: '399' }))).toBe(false);
  });

  it('applies the same gravity-well and distance rules as Hyperspeed.engage', () => {
    const fakeSys = (kind: string, radiusM: number, alt: number) =>
      ({
        nearest: () => [{ def: { kind, radiusM } }, alt],
        toSsb: (_p: unknown, _t: number, out: Vec3d) => out.set(0, 0, 0),
      }) as unknown as SolarSystem;
    const ship = { landed: false, pos: { anchor: '399', offset: new Vec3d() } } as unknown as Ship;
    for (const [kind, radiusM] of [
      ['planet', 6.371e6],
      ['moon', 1.7374e6],
      ['planet', 6.9911e7],
      ['star', 6.957e8],
    ] as const) {
      const floor = hyperspeedFloorM(kind, radiusM);
      for (const alt of [floor * 0.99, floor * 1.01 + 1, 5e6, 2e7, 2e8]) {
        const err = new Hyperspeed().engage(fakeSys(kind, radiusM, alt), ship, 0, '*1', 'x', new Vec3d(4e16, 0, 0), 1e11);
        expect(err === 'hyper.error.gravityWell', `${kind} ${radiusM} at ${alt}`).toBe(alt < floor);
      }
    }
    const sys = fakeSys('star', 6.957e8, 1e12);
    const near = HYPER_MIN_STAR_DISTANCE_M * 0.99;
    expect(new Hyperspeed().engage(sys, ship, 0, '10', 'Sun', new Vec3d(near, 0, 0), 1)).toBe('hyper.error.tooClose');
    expect(new Hyperspeed().engage(sys, ship, 0, '*1', 'x', new Vec3d(near / 0.98, 0, 0), 1)).toBeNull();
  });
});

describe('onboarding tour: text', () => {
  const en = JSON.parse(readFileSync('src/game/locales/en.onboarding.json', 'utf8')) as Record<string, string>;
  const facts = factParams();
  const known = new Set([
    ...Object.keys(facts),
    'thrusters',
    'impulse',
    'cruise',
    'button',
    'body',
    'name',
    'speed',
    'hours',
    'alt',
    'n',
    'total',
    'goal',
    'hint',
  ]);
  /** Placeholder names, including one-direction action placeholders such as {thrust+}. */
  const placeholders = (msg: string): string[] => [...msg.matchAll(/\{(\w+)[+-]?\}/g)].map((m) => m[1]!);
  const directional = (msg: string): string[] => [...msg.matchAll(/\{(\w+)[+-]\}/g)].map((m) => m[1]!);

  it('uses one-direction placeholders only for axis actions, where "hold" or "rise" names one key (review)', () => {
    for (const [key, msg] of Object.entries(en)) {
      for (const a of directional(msg)) {
        expect(isActionId(a), `${key}: {${a}±}`).toBe(true);
        expect(ACTIONS.find((x) => x.id === a)?.kind, `${key}: {${a}±} is not an axis`).toBe('axis');
      }
    }
    // "Hold X" / "rise with X" / "ease down with X" never names a whole axis pair (one half of it does the opposite).
    const axes = ACTIONS.filter((a) => a.kind === 'axis').map((a) => a.id);
    for (const [key, msg] of Object.entries(en)) {
      for (const m of msg.matchAll(/\b(?:hold|rise with|ease down with|raise the throttle with)\s+\{(\w+)\}/gi))
        expect(axes.includes(m[1] as (typeof axes)[number]), `${key}: "${m[0]}"`).toBe(false);
    }
    expect(en['onboarding.nudge.liftOff']).toContain('{strafeY+}');
    expect(en['onboarding.step.throttle.hint']).toContain('hold {thrust+}');
  });

  it('separates the science tag from the sentence for screen readers (review)', () => {
    expect(en['onboarding.scienceTag.separator']).toMatch(/^\S*\s$/);
  });

  it('does not overclaim: the closing line says what is inferred or generated (review)', () => {
    const done = en['onboarding.step.done.science']!;
    expect(done).not.toMatch(/Only the drive is fiction/);
    expect(done).toMatch(/fiction/);
    expect(done).toMatch(/inferred/);
    expect(done).toMatch(/generated/);
  });

  it('owns only onboarding.* keys', () => {
    for (const key of Object.keys(en)) expect(key.startsWith('onboarding.'), key).toBe(true);
  });

  it('has a goal, a key hint and a science line for every step', () => {
    for (const id of STEP_IDS) {
      for (const part of ['goal', 'hint', 'science'])
        expect(en[`onboarding.step.${id}.${part}`], `${id}.${part}`).toBeTruthy();
    }
  });

  it('names keys only through action placeholders, which the card fills from the bindings', () => {
    for (const [key, msg] of Object.entries(en)) {
      if (key.startsWith('onboarding.demo.')) continue;
      for (const p of placeholders(msg)) expect(isActionId(p) || known.has(p), `${key}: {${p}}`).toBe(true);
    }
    // Every step except the last tells the player which key to use.
    for (const id of STEP_IDS.slice(0, -1))
      expect(placeholders(en[`onboarding.step.${id}.hint`]!).some(isActionId), id).toBe(true);
  });

  it('gives gamepad wording only with actions a pad binds by default', () => {
    const pad = defaultBindings('pad');
    const variants = Object.keys(en).filter((k) => k.endsWith('.pad') && !k.startsWith('onboarding.demo.'));
    expect(variants.length).toBeGreaterThan(0);
    for (const key of variants) {
      expect(en[key.slice(0, -4)], `${key} has a keyboard original`).toBeTruthy();
      for (const p of placeholders(en[key]!)) {
        if (isActionId(p)) expect(pad[p]?.some((b) => b !== null), `${key}: {${p}} is unbound on a pad`).toBe(true);
      }
    }
    // The keyboard texts that mention the mouse or pad-unbound actions all have a pad version.
    for (const [key, msg] of Object.entries(en)) {
      if (key.endsWith('.pad') || key.startsWith('onboarding.demo.')) continue;
      const padless = placeholders(msg).filter((p) => isActionId(p) && !pad[p]?.some((b) => b !== null));
      if (padless.length > 0 || /mouse/.test(msg)) expect(en[`${key}.pad`], `${key} needs a .pad variant`).toBeTruthy();
    }
  });

  it('labels the fictional drives as fiction', () => {
    expect(en['onboarding.step.cruise.science']).toMatch(/fiction/);
    expect(en['onboarding.step.hyperspeed.science']).toMatch(/fiction/);
    expect(en['onboarding.step.done.science']).toMatch(/fiction/);
  });

  it('quotes numbers computed from cited constants', () => {
    expect(FACTS.orbitSpeedMS).toBeCloseTo(7661, -1);
    expect(circularSpeed(0)).toBeCloseTo(7910, -1);
    expect(orbitPeriod(420e3) / 60).toBeCloseTo(92.8, 1);
    expect(FACTS.moonLightTimeS).toBeCloseTo(1.282, 3);
    expect(FACTS.moonAngularDiameterDeg).toBeGreaterThan(0.5);
    expect(FACTS.moonAngularDiameterDeg).toBeLessThan(0.55);
    expect(FACTS.moonGravityFraction).toBeCloseTo(1 / 6, 2);
    expect(FACTS.apolloTransitDays).toBeCloseTo(3.16, 2);
    expect(FACTS.proximaDistanceLy).toBeCloseTo(4.2465, 3);
    expect(t('onboarding.step.look.science', facts)).toBe(
      'You are 420 km above Earth, near the height of the International Space Station. An orbit here takes about 93 minutes at 7.7 km/s.',
    );
    // True wherever the pilot is (the Moon may be behind Earth from the ship): a fact about Earth and the Moon.
    expect(t('onboarding.step.target.science', facts)).toBe('Light from the Moon takes about 1.3 seconds to reach Earth.');
    expect(t('onboarding.step.align.science', facts)).toContain('3,475 km across');
    expect(t('onboarding.step.cruise.science', facts)).toContain('about 3 days');
    expect(t('onboarding.step.approach.science', facts)).toContain('384,400 km from Earth on average, about 30 Earths');
    expect(t('onboarding.step.land.science', facts)).toContain('1.62 m/s², about 1/6 of');
    expect(t('onboarding.step.hyperspeed.science', facts)).toContain('4.2 light-years');
  });
});

describe('onboarding tour: snapshot helpers', () => {
  it('accumulates view rotation and ignores teleports', () => {
    const look = new LookTracker();
    const yaw = (a: number) => ({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) });
    expect(look.update(yaw(0))).toBe(0);
    for (let i = 1; i <= 10; i++) look.update(yaw(i * 0.1));
    expect(look.radians).toBeCloseTo(1, 6);
    // Turning back counts too: it is distance travelled, not net angle.
    for (let i = 9; i >= 0; i--) look.update(yaw(i * 0.1));
    expect(look.radians).toBeCloseTo(2, 6);
    look.update(yaw(2.5)); // a jump of 2.5 rad in one frame is a teleport
    expect(look.radians).toBeCloseTo(2, 6);
    look.reset();
    expect(look.radians).toBe(0);
  });

  it('judges alignment with a tolerance, or the target disc when it is larger', () => {
    const fwd = { x: 0, y: 0, z: -1 };
    const off = (deg: number, d = 1e8) => ({
      x: Math.sin((deg * Math.PI) / 180) * d,
      y: 0,
      z: -Math.cos((deg * Math.PI) / 180) * d,
    });
    expect(angleBetween(fwd, off(10))).toBeCloseTo((10 * Math.PI) / 180, 9);
    expect(isAligned(fwd, off(2))).toBe(true);
    expect(isAligned(fwd, off((ALIGN_TOLERANCE_RAD * 180) / Math.PI + 0.5))).toBe(false);
    // Close to the Moon its disc is wide: anywhere on it counts.
    expect(isAligned(fwd, off(20, 3e6), 1.7374e6)).toBe(true);
    expect(isAligned(fwd, off(-150))).toBe(false);
  });

  it('labels actions from the current bindings and device', () => {
    const bindings = defaultBindings('kbm');
    const padBindings = defaultBindings('pad');
    expect(actionLabel({ bindings, padBindings }, 'kbm', 'targetNext')).toBe('Tab');
    expect(actionLabel({ bindings, padBindings }, 'kbm', 'thrust')).toBe('S / W');
    expect(actionLabel({ bindings, padBindings }, 'pad', 'hyperspeed')).toBe('Y');
    // Rebinding shows the new key; an unbound first slot falls back to the second; nothing bound says so.
    const rebound = {
      ...bindings,
      targetNext: [{ type: 'key' as const, code: 'KeyO' }, null] as [{ type: 'key'; code: string }, null],
    };
    expect(actionLabel({ bindings: rebound, padBindings }, 'kbm', 'targetNext')).toBe('O');
    const second = { ...bindings, yaw: [null, bindings['yaw']![1]] as (typeof bindings)['yaw'] & object };
    expect(actionLabel({ bindings: second, padBindings }, 'kbm', 'yaw')).toBe('← / →');
    expect(actionLabel({ bindings, padBindings }, 'pad', 'autoAlign')).toBe(t('input.unbound'));
    expect(ACTION_IDS.length).toBeGreaterThan(0);
  });

  it('labels one direction of an axis: the key, trigger or stick direction that does it (review)', () => {
    const src = { bindings: defaultBindings('kbm'), padBindings: defaultBindings('pad') };
    expect(actionLabel(src, 'kbm', 'thrust', '+')).toBe('W');
    expect(actionLabel(src, 'kbm', 'thrust', '-')).toBe('S');
    expect(actionLabel(src, 'kbm', 'strafeY', '+')).toBe('R');
    expect(actionLabel(src, 'kbm', 'strafeY', '-')).toBe('F');
    // Pad: the triggers (LT lowers, RT raises the throttle) and the left stick, inverted so up is +1.
    expect(actionLabel(src, 'pad', 'thrust', '+')).toBe(t('input.pad.xbox.b7'));
    expect(actionLabel(src, 'pad', 'thrust', '-')).toBe(t('input.pad.xbox.b6'));
    const up = t('input.pad.stick', { stick: t('input.pad.stick.left'), dir: '↑' });
    const down = t('input.pad.stick', { stick: t('input.pad.stick.left'), dir: '↓' });
    expect(actionLabel(src, 'pad', 'strafeY', '+')).toBe(up);
    expect(actionLabel(src, 'pad', 'strafeY', '-')).toBe(down);
    expect(bindingHalfLabel({ type: 'padAxis', axis: 1, invert: false }, '+')).toBe(down);
    // Buttons have no direction; unbound stays unbound.
    expect(actionLabel(src, 'kbm', 'targetNext', '+')).toBe('Tab');
    expect(bindingHalfLabel(null, '+')).toBe(t('input.unbound'));
    // A rebind is followed.
    const thrust: BindingSlots = [{ type: 'keyAxis', neg: 'KeyK', pos: 'KeyI' }, null];
    expect(actionLabel({ ...src, bindings: { ...src.bindings, thrust } }, 'kbm', 'thrust', '+')).toBe('I');
  });

  it('finds a body in the way of the target (Earth hiding the Moon from low orbit) (review)', () => {
    const R = 6.371e6;
    // Ship 420 km above Earth's surface: Earth's centre is straight "down" (-y).
    const earth = { key: 'earth', id: '399', rel: { x: 0, y: -(R + 4.2e5), z: 0 }, radiusM: R };
    const moon = (elevDeg: number) => {
      const a = (elevDeg * Math.PI) / 180;
      return { x: Math.cos(a) * 3.844e8, y: Math.sin(a) * 3.844e8, z: 0 };
    };
    expect(pathBlocker(moon(-60), '301', [earth])?.key).toBe('earth');
    expect(pathBlocker(moon(-30), '301', [earth])?.key).toBe('earth');
    // Above the horizon, or just below it where the path still clears the drop-out height: clear.
    expect(pathBlocker(moon(10), '301', [earth])).toBeNull();
    expect(pathBlocker(moon(-10), '301', [earth])).toBeNull();
    expect(pathBlocker(moon(90), '301', [earth])).toBeNull();
    // The target itself never blocks; nor does a body behind the ship.
    expect(pathBlocker(earth.rel, '399', [earth])).toBeNull();
    expect(pathBlocker({ x: 0, y: 1e9, z: 0 }, '301', [earth])).toBeNull();
    // The drop-out clearance is max(20 km, 1 % of the radius), as in ship.ts.
    expect(dropOutClearanceM(R)).toBeCloseTo(R * 1.01, 3);
    expect(dropOutClearanceM(1.7374e6)).toBe(1.7374e6 + 20_000);
  });

  it('opens where the Moon is above the horizon on every day of a lunar month (review)', () => {
    const fallback = { x: 0, y: 0, z: 1 };
    const sun = { x: 1, y: 0, z: 0 };
    for (let deg = 0; deg <= 180; deg += 5) {
      const a = (deg * Math.PI) / 180;
      const moon = { x: Math.cos(a), y: Math.sin(a) * 0.9, z: Math.sin(a) * Math.sqrt(1 - 0.81) };
      const up = openingUp(sun, moon, fallback);
      expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 9);
      // The Moon at least 12 degrees up (parallax from 420 km is under 1 degree).
      expect((elevation(up, moon) * 180) / Math.PI, `elongation ${deg}`).toBeGreaterThan(11.99);
      // The Sun 35 degrees up (as in the 'leo' view) whenever the Moon allows it, and never lower than needed.
      const sunUp = (elevation(up, sun) * 180) / Math.PI;
      expect(sunUp, `elongation ${deg}`).toBeCloseTo(Math.min(35, 90 - (deg - 78)), 6);
    }
    // At full Moon both sit low: the Sun just below the horizon of the point below (still above the visible limb).
    const full = openingUp(sun, { x: -1, y: 0, z: 0 }, fallback);
    expect((elevation(full, sun) * 180) / Math.PI).toBeCloseTo(-12, 6);
  });
});
