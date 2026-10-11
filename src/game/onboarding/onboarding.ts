/**
 * The guided opening (PRD Section 9 "Onboarding", milestone M6): a compact glass card that walks a new pilot from low
 * Earth orbit to the Moon and on to the stars. It only watches the game (one snapshot per frame) and never takes
 * input, pauses or blocks free play; it can be minimised, skipped, and restarted from Settings.
 *
 * Every key it names comes from the player's current binding (labelFor), every string from t(), and each step carries
 * one line of real science; gameplay fiction (the drives) is called fiction in the text. See docs/ONBOARDING.md.
 */
import './onboarding.css';
import { isActionId, type ActionId } from '../input/actions';
import { t } from '../i18n';
import { factParams } from './facts';
import type { Nudge } from './steps';
import { TourMachine, type StepPhase, type TourTiming } from './tour';
import type { OnboardingSnapshot, OnboardingStorage } from './types';

export type { OnboardingSnapshot, OnboardingStorage, OnboardingMode, OnboardingHyperPhase } from './types';
export { LookTracker, isAligned, angleBetween, actionLabel, ALIGN_TOLERANCE_RAD } from './snapshot';
export { STEP_IDS, STEPS, MOON_ID, APPROACH_DISTANCE_M, type StepId } from './steps';
export { ONBOARDING_STORAGE_KEY, DEFAULT_TIMING, type TourTiming } from './tour';

export interface OnboardingOptions {
  /** Element the card is added to (document.body in the game). */
  parent: HTMLElement;
  /** Progress storage; defaults to localStorage when reachable, null keeps progress in memory. */
  storage?: OnboardingStorage | null;
  /** Display label of an action's current binding (see actionLabel in snapshot.ts). */
  labelFor: (action: ActionId) => string;
  /** Called with each new step id, and with 'skipped' when the tour is skipped. */
  onStepChange?: (id: string) => void;
  /** Reduced-motion setting; the card also honours html[data-reduced-motion] and prefers-reduced-motion in CSS. */
  reducedMotion?: () => boolean;
  /** Timing overrides (the demo page and tests use shorter delays). */
  timing?: Partial<TourTiming>;
}

/** How long the "tour skipped" note stays before fading (ms). */
const FAREWELL_MS = 4500;
/** Key labels are refreshed at most this often (s), so a rebind or device switch shows up at once. */
const LABEL_REFRESH_S = 0.2;

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.append(e);
  return e;
}

function svg(viewBox: string, inner: string, cls: string): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  s.setAttribute('class', cls);
  s.innerHTML = inner;
  return s;
}

let instances = 0;

export class Onboarding {
  private readonly tour: TourMachine;
  private readonly labelFor: (action: ActionId) => string;
  private readonly reducedMotion: (() => boolean) | undefined;
  private readonly facts = factParams();
  private readonly uid = `ks-onb-${++instances}`;

  private readonly layer: HTMLElement;
  private readonly root: HTMLElement;
  private readonly live: HTMLElement;
  private readonly eyebrow: HTMLElement;
  private readonly mini: HTMLElement;
  private readonly count: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly collapseBtn: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly goal: HTMLElement;
  private readonly goalText: HTMLElement;
  private readonly goalDone: HTMLElement;
  private readonly optionalTag: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly nudge: HTMLElement;
  private readonly science: HTMLElement;
  private readonly scienceText: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly skipStepBtn: HTMLButtonElement;
  private readonly skipBtn: HTMLButtonElement;
  private readonly restartHint: HTMLElement;

  /** What the card currently shows: a step (and its phase), the skipped note, or nothing. */
  private shown: { step: string; phase: StepPhase } | 'farewell' | null = null;
  private nudgeSig = '';
  private labelTimer = 0;
  private userVisible = true;
  private codexOpen = false;
  private farewellTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private disposed = false;

  constructor(opts: OnboardingOptions) {
    this.labelFor = opts.labelFor;
    this.reducedMotion = opts.reducedMotion;
    this.tour = new TourMachine({
      ...(opts.storage !== undefined ? { storage: opts.storage } : {}),
      ...(opts.timing ? { timing: opts.timing } : {}),
      ...(opts.onStepChange ? { onStepChange: opts.onStepChange } : {}),
    });

    // A full-viewport, click-through layer: the size container the card's layout queries (see onboarding.css).
    this.layer = el('div', 'ks-onb-layer');
    const root = el('section', 'ks-onb', this.layer);
    root.id = this.uid;
    root.setAttribute('aria-label', t('onboarding.region'));
    root.hidden = true;
    this.root = root;

    // Header: eyebrow (or the goal when minimised), step count, segmented progress, minimise toggle.
    const head = el('div', 'ks-onb-head', root);
    this.eyebrow = el('p', 'ks-onb-eyebrow', head);
    this.mini = el('p', 'ks-onb-mini', head);
    this.mini.setAttribute('aria-hidden', 'true');
    this.count = el('span', 'ks-onb-count', head);
    this.count.setAttribute('aria-hidden', 'true');
    this.bar = el('div', 'ks-onb-bar', head);
    this.bar.setAttribute('role', 'progressbar');
    this.bar.setAttribute('aria-valuemin', '0');
    this.collapseBtn = el('button', 'ks-onb-icon-btn ks-onb-collapse', head);
    this.collapseBtn.type = 'button';
    this.collapseBtn.append(svg('0 0 16 16', '<path d="M4 6.5 8 10.5 12 6.5"/>', 'ks-onb-chevron'));
    this.collapseBtn.addEventListener('click', (e) => {
      this.tour.setCollapsed(!this.tour.collapsed);
      this.applyCollapsed();
      this.releaseFocus(e);
    });

    // Body: goal with status mark, key hint, contextual nudge, science line.
    this.body = el('div', 'ks-onb-body', root);
    this.body.id = `${this.uid}-body`;
    this.collapseBtn.setAttribute('aria-controls', this.body.id);
    this.goal = el('h2', 'ks-onb-goal', this.body);
    const mark = el('span', 'ks-onb-mark', this.goal);
    mark.setAttribute('aria-hidden', 'true');
    mark.append(
      svg(
        '0 0 20 20',
        '<circle class="ks-onb-ring" cx="10" cy="10" r="7.25"/><circle class="ks-onb-dot" cx="10" cy="10" r="2.2"/>',
        'ks-onb-mark-pending',
      ),
      svg(
        '0 0 20 20',
        '<circle class="ks-onb-disc" cx="10" cy="10" r="8"/><path class="ks-onb-check" d="M6.2 10.3 8.8 12.8 13.9 7.4"/>',
        'ks-onb-mark-done',
      ),
    );
    this.goalText = el('span', 'ks-onb-goal-text', this.goal);
    this.goalDone = el('span', 'ks-onb-sr', this.goal);
    this.optionalTag = el('span', 'ks-onb-optional', this.goal);
    this.hint = el('p', 'ks-onb-hint', this.body);
    this.nudge = el('p', 'ks-onb-nudge', this.body);
    this.nudge.hidden = true;
    this.science = el('p', 'ks-onb-science', this.body);
    const tag = el('span', 'ks-onb-science-tag', this.science);
    tag.textContent = t('onboarding.scienceTag');
    this.scienceText = el('span', 'ks-onb-science-text', this.science);

    // Footer: skip controls and where to restart.
    this.foot = el('div', 'ks-onb-foot', root);
    this.skipStepBtn = el('button', 'ks-onb-btn', this.foot);
    this.skipStepBtn.type = 'button';
    this.skipStepBtn.textContent = t('onboarding.skipStep');
    this.skipStepBtn.addEventListener('click', (e) => {
      this.tour.skipStep();
      this.sync();
      this.releaseFocus(e);
    });
    this.skipBtn = el('button', 'ks-onb-btn ks-onb-btn-quiet ks-onb-skip', this.foot);
    this.skipBtn.type = 'button';
    this.skipBtn.addEventListener('click', (e) => {
      this.releaseFocus(e);
      this.skip();
    });
    this.restartHint = el('p', 'ks-onb-restart', this.foot);

    // Announcements live outside the card so they still reach screen readers while it is minimised.
    this.live = el('p', 'ks-onb-sr');
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');
    this.live.setAttribute('aria-atomic', 'true');

    opts.parent.append(this.layer, this.live);
  }

  /** True while the tour shows a step or its closing card. */
  get active(): boolean {
    return this.tour.active;
  }

  get stepId(): string | null {
    return this.tour.stepId;
  }

  /** The card element (for layout checks and tests). */
  get element(): HTMLElement {
    return this.root;
  }

  /** Begins the tour, or resumes it at the remembered step. No-op once skipped or finished (see reset()). */
  start(): void {
    if (this.disposed) return;
    const wasShowing = !this.root.hidden;
    if (!this.tour.start()) return;
    this.clearFarewell();
    this.sync();
    if (!wasShowing) this.playEnter(this.root);
  }

  update(dt: number, s: OnboardingSnapshot): void {
    if (this.disposed) return;
    this.codexOpen = s.codexOpen;
    if (this.tour.active) this.tour.update(dt, s);
    this.sync(s);
    if (!this.tour.active) return;
    this.labelTimer -= dt;
    if (this.labelTimer <= 0) {
      this.labelTimer = LABEL_REFRESH_S;
      this.refreshLabels();
    }
  }

  /** Ends the tour (remembered); a short note says where to restart it. On the closing card, just closes it. */
  skip(): void {
    if (this.disposed) return;
    const finale = this.tour.finale;
    const wasActive = this.tour.active;
    this.tour.skip();
    if (finale || !wasActive) {
      this.sync();
      return;
    }
    this.showFarewell();
  }

  /** Skips the current step when it is optional (the landing). */
  skipStep(): void {
    this.tour.skipStep();
    this.sync();
  }

  /** Forgets all progress and hides the card; call start() to replay the tour from the first step. */
  reset(): void {
    if (this.disposed) return;
    this.tour.reset();
    this.clearFarewell();
    this.sync();
  }

  /** Hides or shows the card without touching the tour (HUD hidden, screenshot mode). */
  setVisible(v: boolean): void {
    this.userVisible = v;
    this.applyVisibility();
  }

  dispose(): void {
    this.disposed = true;
    this.clearFarewell();
    this.layer.remove();
    this.live.remove();
  }

  // --- Rendering --------------------------------------------------------------------------------------------------

  /** Brings the card in line with the tour state; rebuilds text only when the step or its phase changed. */
  private sync(s?: OnboardingSnapshot): void {
    const step = this.tour.step;
    if (!step) {
      if (this.shown !== 'farewell') this.shown = null;
      this.applyVisibility();
      return;
    }
    const phase = this.tour.phase;
    const prev = this.shown;
    const newStep = prev === null || prev === 'farewell' || prev.step !== step.id;
    if (newStep) {
      this.renderStep();
      // A step reached early (catch-up) appears already complete: say so instead of reading out its instructions.
      if (phase === 'complete') this.announceComplete();
      else this.announceStep();
      if (prev !== null) this.playEnter(this.body);
    } else if (prev.phase !== phase && phase === 'complete') {
      this.announceComplete();
    }
    if (newStep || prev.phase !== phase) {
      this.shown = { step: step.id, phase };
      this.root.dataset['phase'] = phase;
      this.goalDone.textContent = phase === 'complete' ? t('onboarding.doneMark') : '';
      this.renderProgress();
    }
    if (s) this.updateNudge(s);
    this.applyVisibility();
  }

  private renderStep(): void {
    const step = this.tour.step!;
    const id = step.id;
    const finale = this.tour.finale;
    this.root.dataset['step'] = id;
    this.root.dataset['state'] = finale ? 'done' : 'step';
    this.eyebrow.textContent = t(
      finale ? 'onboarding.eyebrow.done' : id === 'look' ? 'onboarding.eyebrow.welcome' : 'onboarding.eyebrow',
    );
    this.goalText.textContent = t(`onboarding.step.${id}.goal`);
    this.mini.textContent = this.goalText.textContent;
    this.optionalTag.textContent = step.optional ? t('onboarding.optional') : '';
    this.optionalTag.hidden = !step.optional;
    this.renderTemplate(this.hint, `onboarding.step.${id}.hint`, this.params());
    this.scienceText.textContent = t(`onboarding.step.${id}.science`, this.facts);
    this.nudgeSig = '';
    this.nudge.hidden = true;
    this.nudge.replaceChildren();
    delete this.root.dataset['nudge'];
    this.skipStepBtn.hidden = !step.optional;
    this.skipBtn.textContent = t(finale ? 'onboarding.close' : 'onboarding.skip');
    this.renderTemplate(this.restartHint, 'onboarding.restartHint', {});
    this.applyCollapsed();
  }

  private showFarewell(): void {
    this.shown = 'farewell';
    this.root.dataset['state'] = 'farewell';
    this.root.dataset['phase'] = 'complete';
    delete this.root.dataset['step'];
    this.eyebrow.textContent = t('onboarding.eyebrow');
    this.goalText.textContent = t('onboarding.skipped.title');
    this.goalDone.textContent = '';
    this.optionalTag.hidden = true;
    this.renderTemplate(this.hint, 'onboarding.skipped.body', {});
    this.nudge.hidden = true;
    this.root.dataset['collapsed'] = 'false';
    this.announce(t('onboarding.announce.skipped'));
    this.applyVisibility();
    this.clearFarewell();
    this.farewellTimer = setTimeout(() => {
      this.farewellTimer = 0;
      this.root.dataset['leaving'] = 'true';
      this.farewellTimer = setTimeout(
        () => {
          this.farewellTimer = 0;
          if (this.shown === 'farewell') this.shown = null;
          this.applyVisibility();
        },
        this.motionReduced() ? 0 : 400,
      );
    }, FAREWELL_MS);
  }

  private clearFarewell(): void {
    if (this.farewellTimer) clearTimeout(this.farewellTimer);
    this.farewellTimer = 0;
    delete this.root.dataset['leaving'];
    if (this.shown === 'farewell') this.shown = null;
  }

  /** Step-specific i18n params: the science numbers, plus drive names for the cruise hint. */
  private params(): Record<string, string> {
    return {
      ...this.facts,
      thrusters: t('hud.mode.thrusters'),
      impulse: t('hud.mode.impulse'),
      cruise: t('hud.mode.cruise'),
    };
  }

  /**
   * Renders a message whose {actionId} placeholders become keycaps with the current binding label. The translated
   * sentence keeps its own word order; nothing is concatenated.
   */
  private renderTemplate(target: HTMLElement, key: string, params: Readonly<Record<string, string>>): void {
    const parts = t(key, params).split(/\{(\w+)\}/);
    const nodes: Node[] = [];
    parts.forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) nodes.push(document.createTextNode(part));
      } else if (isActionId(part)) {
        const k = document.createElement('kbd');
        k.className = 'ks-onb-key';
        k.dataset['action'] = part;
        this.setKeyLabel(k, part);
        nodes.push(k);
      } else {
        nodes.push(document.createTextNode(`{${part}}`));
      }
    });
    target.replaceChildren(...nodes);
  }

  private setKeyLabel(k: HTMLElement, action: ActionId): void {
    const label = this.labelFor(action);
    if (k.textContent !== label) k.textContent = label;
    k.classList.toggle('is-unbound', label === t('input.unbound'));
  }

  private refreshLabels(): void {
    for (const k of this.root.querySelectorAll<HTMLElement>('kbd.ks-onb-key')) {
      const a = k.dataset['action'];
      if (a && isActionId(a)) this.setKeyLabel(k, a);
    }
  }

  /** Plain-text version of a template, with key labels in place of the placeholders (for announcements). */
  private plain(key: string, params: Readonly<Record<string, string>>): string {
    return t(key, params).replace(/\{(\w+)\}/g, (m, name: string) => (isActionId(name) ? this.labelFor(name) : m));
  }

  private updateNudge(s: OnboardingSnapshot): void {
    const step = this.tour.step;
    const n: Nudge | null = step && this.tour.phase === 'pending' && step.nudge ? step.nudge(s) : null;
    const sig = n ? `${n.key}|${JSON.stringify(n.params ?? {})}` : '';
    if (sig === this.nudgeSig) return;
    this.nudgeSig = sig;
    if (!n) {
      this.nudge.hidden = true;
      this.nudge.replaceChildren();
      delete this.root.dataset['nudge'];
      return;
    }
    const text = el('span', 'ks-onb-nudge-text');
    this.renderTemplate(text, n.key, { button: t('map.showStars'), ...n.params });
    this.nudge.replaceChildren(
      svg('0 0 16 16', '<path d="M8 2.2 14.6 13.6H1.4z"/><path d="M8 6.6v3.2M8 11.7h.01"/>', 'ks-onb-nudge-icon'),
      text,
    );
    this.nudge.hidden = false;
    this.root.dataset['nudge'] = 'true';
  }

  private renderProgress(): void {
    const p = this.tour.progress();
    const finale = this.tour.finale;
    const n = Math.min(p.index + 1, p.total);
    this.count.textContent = finale
      ? t('onboarding.count', { n: p.total, total: p.total })
      : t('onboarding.count', { n, total: p.total });
    this.bar.setAttribute('aria-valuemax', String(p.total));
    this.bar.setAttribute('aria-valuenow', String(p.done.filter(Boolean).length));
    this.bar.setAttribute(
      'aria-valuetext',
      finale ? t('onboarding.progress.done', { total: p.total }) : t('onboarding.progress', { n, total: p.total }),
    );
    this.bar.setAttribute('aria-label', t('onboarding.region'));
    if (this.bar.childElementCount !== p.total) this.bar.replaceChildren(...p.done.map(() => el('i', 'ks-onb-seg')));
    p.done.forEach((done, i) => {
      const seg = this.bar.children[i] as HTMLElement;
      seg.classList.toggle('is-done', done);
      seg.classList.toggle('is-current', !finale && i === p.index);
      seg.classList.toggle('is-optional', p.optional[i] === true);
    });
  }

  private announceStep(): void {
    const step = this.tour.step;
    if (!step) return;
    const p = this.tour.progress();
    const goal = t(`onboarding.step.${step.id}.goal`);
    const hint = this.plain(`onboarding.step.${step.id}.hint`, this.params());
    if (this.tour.finale) this.announce(t('onboarding.announce.done', { goal, hint }));
    else
      this.announce(
        t(step.optional ? 'onboarding.announce.optional' : 'onboarding.announce.step', {
          n: p.index + 1,
          total: p.total,
          goal,
          hint,
        }),
      );
  }

  private announceComplete(): void {
    this.announce(t('onboarding.announce.complete', { goal: this.goalText.textContent }));
  }

  private announce(text: string): void {
    // Clear first so repeating the same sentence is announced again.
    this.live.textContent = '';
    this.live.textContent = text;
  }

  private applyCollapsed(): void {
    const c = this.tour.collapsed && this.shown !== 'farewell';
    this.root.dataset['collapsed'] = String(c);
    this.collapseBtn.setAttribute('aria-expanded', String(!c));
    this.collapseBtn.setAttribute('aria-label', t(c ? 'onboarding.expand' : 'onboarding.collapse'));
    this.collapseBtn.title = this.collapseBtn.getAttribute('aria-label') ?? '';
  }

  private applyVisibility(): void {
    const showing = this.tour.active || this.shown === 'farewell';
    const hidden = !(showing && this.userVisible && !this.codexOpen);
    if (this.root.hidden !== hidden) this.root.hidden = hidden;
    const motion = this.motionReduced() ? 'reduced' : 'full';
    if (this.root.dataset['motion'] !== motion) this.root.dataset['motion'] = motion;
  }

  private motionReduced(): boolean {
    try {
      return this.reducedMotion?.() ?? false;
    } catch {
      return false;
    }
  }

  /** Restarts the entrance animation on an element (CSS turns it off under reduced motion). */
  private playEnter(target: HTMLElement): void {
    if (this.motionReduced()) return;
    target.classList.remove('is-entering');
    // Reading layout restarts the CSS animation when the class is added back.
    target.getBoundingClientRect();
    target.classList.add('is-entering');
  }

  /** A mouse click must not leave focus on a card button, or the game's own keys could press it. */
  private releaseFocus(e: MouseEvent): void {
    if (e.detail > 0 && e.currentTarget instanceof HTMLElement) e.currentTarget.blur();
  }
}
