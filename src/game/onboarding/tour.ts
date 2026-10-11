/**
 * The guided opening's state machine, without any DOM: which step is showing, when it completes and advances, and
 * what is remembered between sessions. The Onboarding card (onboarding.ts) renders it.
 *
 * Timing per step: the step is shown for at least `minDwell` seconds (reading time); its goal must then hold for
 * `hold` seconds without interruption (one-frame flickers do not count); the step then shows as complete for `grace`
 * seconds before the next one appears. If the player reaches a later step's goal early (a `catchUp` step, or the step
 * after an optional one), the tour jumps there rather than asking for things that no longer matter.
 *
 * Persistence: localStorage key 'knownsky.onboarding', versioned JSON. Every access is guarded; unreadable or corrupt
 * data starts a fresh tour, and storage failures never break the game (the tour then lasts one session).
 */
import { STEPS, type StepDef, type StepId } from './steps';
import type { OnboardingSnapshot, OnboardingStorage } from './types';

export const ONBOARDING_STORAGE_KEY = 'knownsky.onboarding';
export const ONBOARDING_VERSION = 1;

/** 'new': never started (or reset); 'active': in progress; 'skipped' and 'done' end the tour for good. */
export type TourStatus = 'new' | 'active' | 'skipped' | 'done';
export type StepPhase = 'pending' | 'complete';

export interface TourTiming {
  /** Default minimum reading time of a step (s). */
  minDwell: number;
  /** Default time a goal must hold without interruption (s). */
  hold: number;
  /** Time a completed step stays on screen before the next one (s). */
  grace: number;
  /** Time the final card stays before closing by itself (s). */
  doneLinger: number;
}

export const DEFAULT_TIMING: Readonly<TourTiming> = { minDwell: 2, hold: 0.25, grace: 1.5, doneLinger: 15 };

export interface PersistedTour {
  v: number;
  status: Exclude<TourStatus, 'new'>;
  step: StepId;
  collapsed: boolean;
}

const STATUSES: readonly string[] = ['active', 'skipped', 'done'];

/** Reads stored progress; null when missing, unreadable, from an unknown version or otherwise corrupt. */
export function parsePersisted(text: string | null, steps: readonly StepDef[] = STEPS): PersistedTour | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== ONBOARDING_VERSION) return null;
  const status = r['status'];
  if (typeof status !== 'string' || !STATUSES.includes(status)) return null;
  const step = r['step'];
  const known = typeof step === 'string' && steps.some((s) => s.id === step);
  // A finished tour does not need a valid step; an active one restarts if its step is unknown.
  if (!known && status === 'active') return null;
  return {
    v: ONBOARDING_VERSION,
    status: status as PersistedTour['status'],
    step: known ? (step as StepId) : steps[0]!.id,
    collapsed: r['collapsed'] === true,
  };
}

function defaultStorage(): OnboardingStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // Accessing localStorage itself throws when storage is blocked.
  }
}

export interface TourOptions {
  /** Defaults to localStorage when reachable; null keeps progress in memory only. */
  storage?: OnboardingStorage | null;
  /** The step list; the last entry is always the closing card (the finale), which is not counted as progress. */
  steps?: readonly StepDef[];
  timing?: Partial<TourTiming>;
  /** Called with the new step id whenever the visible step changes, and with 'skipped' when the tour is skipped. */
  onStepChange?: (id: string) => void;
}

export interface TourProgress {
  /** Index of the current step among the counted steps (0-based); equals `total` on the finale. */
  index: number;
  total: number;
  /** Per counted step: completed (true) or not. */
  done: boolean[];
  optional: boolean[];
}

export class TourMachine {
  readonly steps: readonly StepDef[];
  readonly timing: Readonly<TourTiming>;
  status: TourStatus = 'new';
  /** Why stored progress was ignored on load, or null when it read cleanly (or there was none). */
  loadIssue: 'corrupt' | 'unavailable' | null = null;
  private readonly storage: OnboardingStorage | null;
  private readonly onStepChange: ((id: string) => void) | undefined;
  private running = false;
  private index = 0;
  private stepPhase: StepPhase = 'pending';
  private dwell = 0;
  private holdTimer = 0;
  private graceTimer = 0;
  private catchIndex = -1;
  private catchTimer = 0;
  private lingerTimer = 0;
  private collapsedState = false;

  constructor(opts: TourOptions = {}) {
    this.steps = opts.steps ?? STEPS;
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.onStepChange = opts.onStepChange;
    this.load();
  }

  /** True while a step (or the finale) is showing. */
  get active(): boolean {
    return this.running;
  }

  get stepId(): StepId | null {
    return this.running ? (this.steps[this.index]?.id ?? null) : null;
  }

  get step(): StepDef | null {
    return this.running ? (this.steps[this.index] ?? null) : null;
  }

  get phase(): StepPhase {
    return this.stepPhase;
  }

  get collapsed(): boolean {
    return this.collapsedState;
  }

  /** True on the closing card. */
  get finale(): boolean {
    return this.running && this.index === this.steps.length - 1;
  }

  /** Seconds the current step has been showing. */
  get stepTime(): number {
    return this.dwell;
  }

  progress(): TourProgress {
    const counted = this.steps.slice(0, -1);
    return {
      index: Math.min(this.index, counted.length),
      total: counted.length,
      done: counted.map((_, i) => i < this.index || (i === this.index && this.stepPhase === 'complete')),
      optional: counted.map((s) => s.optional === true),
    };
  }

  /** Re-reads stored progress. Missing, corrupt or unreadable data means a fresh tour. */
  load(): void {
    this.loadIssue = null;
    let text: string | null = null;
    try {
      text = this.storage?.getItem(ONBOARDING_STORAGE_KEY) ?? null;
    } catch {
      this.loadIssue = 'unavailable';
    }
    const p = parsePersisted(text, this.steps);
    if (text !== null && p === null) this.loadIssue = 'corrupt';
    if (!p) {
      this.status = 'new';
      this.index = 0;
      this.collapsedState = false;
      return;
    }
    this.status = p.status;
    this.index = Math.max(0, this.steps.findIndex((s) => s.id === p.step));
    this.collapsedState = p.collapsed;
  }

  /**
   * Starts the tour, or resumes it at the remembered step. Does nothing once the tour was skipped or finished (call
   * reset() first to replay it). Returns true when a step is now showing.
   */
  start(): boolean {
    if (this.running) return true;
    if (this.status === 'skipped' || this.status === 'done') return false;
    if (this.status === 'new') this.index = 0;
    this.status = 'active';
    this.running = true;
    this.enter(this.index, 'pending');
    return true;
  }

  update(dt: number, s: OnboardingSnapshot): void {
    if (!this.running || !(dt >= 0)) return;
    const step = this.steps[this.index];
    if (!step) return;
    this.dwell += dt;
    if (this.finale) {
      this.lingerTimer += dt;
      if (this.lingerTimer >= this.timing.doneLinger) this.close();
      return;
    }
    if (this.stepPhase === 'complete') {
      this.graceTimer += dt;
      if (this.graceTimer >= this.timing.grace) this.enter(this.index + 1, 'pending');
      return;
    }
    // Catch up to the furthest later goal already reached.
    const target = this.catchUpTarget(s);
    if (target !== this.catchIndex) {
      this.catchIndex = target;
      this.catchTimer = 0;
    } else if (target >= 0) {
      this.catchTimer += dt;
    }
    if (target >= 0 && this.catchTimer >= (this.steps[target]?.hold ?? this.timing.hold)) {
      this.enter(target, 'complete');
      return;
    }
    this.holdTimer = step.done(s) ? this.holdTimer + dt : 0;
    if (this.dwell >= (step.minDwell ?? this.timing.minDwell) && this.holdTimer >= (step.hold ?? this.timing.hold)) {
      this.stepPhase = 'complete';
      this.graceTimer = 0;
    }
  }

  /** Skips the current step when it is optional. Returns true if it was skipped. */
  skipStep(): boolean {
    const step = this.step;
    if (!step?.optional || this.stepPhase !== 'pending') return false;
    this.enter(this.index + 1, 'pending');
    return true;
  }

  /** Ends the tour and remembers it. On the finale this just closes the card (the tour is already done). */
  skip(): void {
    if (this.finale || this.status === 'done') {
      this.close();
      return;
    }
    if (this.status === 'skipped' && !this.running) return;
    this.running = false;
    this.status = 'skipped';
    this.save();
    this.onStepChange?.('skipped');
  }

  /** Closes the finale card. */
  close(): void {
    this.running = false;
  }

  /** Forgets all progress (stored too) and stops the tour; start() then begins at the first step. */
  reset(): void {
    this.running = false;
    this.status = 'new';
    this.index = 0;
    this.stepPhase = 'pending';
    this.collapsedState = false;
    try {
      this.storage?.removeItem(ONBOARDING_STORAGE_KEY);
    } catch {
      // Storage blocked: the in-memory reset still applies.
    }
  }

  setCollapsed(v: boolean): void {
    if (v === this.collapsedState) return;
    this.collapsedState = v;
    if (this.status !== 'new') this.save();
  }

  private catchUpTarget(s: OnboardingSnapshot): number {
    const cur = this.steps[this.index];
    for (let j = this.steps.length - 2; j > this.index; j--) {
      const st = this.steps[j]!;
      const eligible = st.catchUp === true || (cur?.optional === true && j === this.index + 1);
      if (eligible && st.done(s)) return j;
    }
    return -1;
  }

  private enter(index: number, phase: StepPhase): void {
    this.index = Math.min(index, this.steps.length - 1);
    this.stepPhase = phase;
    this.dwell = 0;
    this.holdTimer = 0;
    this.graceTimer = 0;
    this.catchIndex = -1;
    this.catchTimer = 0;
    this.lingerTimer = 0;
    if (this.finale) this.status = 'done';
    this.save();
    this.onStepChange?.(this.steps[this.index]!.id);
  }

  private save(): void {
    if (this.status === 'new') return;
    const data: PersistedTour = { v: ONBOARDING_VERSION, status: this.status, step: this.steps[this.index]!.id, collapsed: this.collapsedState };
    try {
      this.storage?.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Quota exceeded or storage blocked: the tour still works for this session.
    }
  }
}
