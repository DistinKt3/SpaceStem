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
import { hasKey, t } from '../i18n';
import { factParams } from './facts';
import type { AxisHalf } from './snapshot';
import type { Nudge } from './steps';
import { TourMachine, type StepPhase, type TourTiming } from './tour';
import type { OnboardingSnapshot, OnboardingStorage } from './types';

export type { OnboardingSnapshot, OnboardingStorage, OnboardingMode, OnboardingHyperPhase } from './types';
export { LookTracker, isAligned, angleBetween, actionLabel, ALIGN_TOLERANCE_RAD, type AxisHalf } from './snapshot';
export { STEP_IDS, STEPS, MOON_ID, APPROACH_DISTANCE_M, type StepId } from './steps';
export { ONBOARDING_STORAGE_KEY, DEFAULT_TIMING, type TourTiming } from './tour';

/** A template placeholder: an action id, optionally with one direction of an axis ({thrust+}). */
const PLACEHOLDER = /\{(\w+)([+-]?)\}/;

export interface OnboardingOptions {
  /** Element the card is added to (document.body in the game). */
  parent: HTMLElement;
  /** Progress storage; defaults to localStorage when reachable, null keeps progress in memory. */
  storage?: OnboardingStorage | null;
  /**
   * Display label of an action's current binding (see actionLabel in snapshot.ts); with `half`, only that direction
   * of an axis action ("W" for thrust '+').
   */
  labelFor: (action: ActionId, half?: AxisHalf) => string;
  /**
   * The input device in use (input.activeDevice). With 'pad', hints use their gamepad wording where one exists
   * (key '<hint>.pad'): no "move the mouse", no keyboard-only actions.
   */
  device?: () => 'kbm' | 'pad';
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

const halfOf = (sign: string | undefined): AxisHalf | undefined => (sign === '+' || sign === '-' ? sign : undefined);

let instances = 0;

export class Onboarding {
  private readonly tour: TourMachine;
  private readonly labelFor: (action: ActionId, half?: AxisHalf) => string;
  private readonly device: (() => 'kbm' | 'pad') | undefined;
  /** Device the hint text was written for. */
  private hintDevice: 'kbm' | 'pad' = 'kbm';
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
    this.device = opts.device;
    this.reducedMotion = opts.reducedMotion;
    this.tour = new TourMachine({
      ...(opts.storage !== undefined ? { storage: opts.storage } : {}),
      ...(opts.timing ? { timing: opts.timing } : {}),
      ...(opts.onStepChange ? { onStepChange: opts.onStepChange } : {}),
    });

    // A full-viewport, click-through layer: the size container the card's layout queries (see onboarding.css).
    // Screenshot mode (src/game/share) leaves out elements marked like this.
    this.layer = el('div', 'ks-onb-layer');
    this.layer.setAttribute('data-ks-hide-in-screenshot', '');
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
    // The gap after the tag is only visual (a margin): screen readers get a separator, so the tag and the sentence
    // are not read as one word.
    const sep = el('span', 'ks-onb-sr', this.science);
    sep.textContent = t('onboarding.scienceTag.separator');
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

    // In short windows the card stops above the HUD's left panel and scrolls (onboarding.css): a fade at the bottom
    // shows there is more. Size changes and scrolling update it; nothing is measured per frame.
    root.addEventListener('scroll', () => this.updateMore(), { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => this.updateMore());
      for (const e of [root, head, this.body, this.foot]) this.resize.observe(e);
    }
  }

  private resize: ResizeObserver | null = null;

  private updateMore(): void {
    const r = this.root;
    const more = !r.hidden && r.scrollHeight - r.scrollTop - r.clientHeight > 2;
    if ((r.dataset['more'] === 'true') !== more) r.dataset['more'] = String(more);
  }

  /** True while the tour shows a step or its closing card. */
  get active(): boolean {
    return this.tour.active;
  }

  get stepId(): string | null {
    return this.tour.stepId;
  }

  /** True when start() would show the tour: it is new or in progress (not skipped or finished). */
  get willShow(): boolean {
    return this.tour.active || this.tour.status === 'new' || this.tour.status === 'active';
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

  /** Replays the tour from the first step (Settings > Restart guided tour): reset() then start(). */
  restart(): void {
    this.reset();
    this.start();
  }

  /** Hides or shows the card without touching the tour (HUD hidden, screenshot mode). */
  setVisible(v: boolean): void {
    this.userVisible = v;
    this.applyVisibility();
  }

  dispose(): void {
    this.disposed = true;
    this.resize?.disconnect();
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
    this.hintDevice = this.currentDevice();
    this.renderTemplate(this.hint, this.variant(`onboarding.step.${id}.hint`), this.params());
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
    this.clearFarewell();
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
    this.nudgeSig = '';
    delete this.root.dataset['nudge'];
    this.root.dataset['collapsed'] = 'false';
    this.announce(t('onboarding.announce.skipped'));
    this.applyVisibility();
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
    // split() with two capture groups yields [text, name, half, text, name, half, ..., text].
    const parts = t(key, params).split(new RegExp(PLACEHOLDER.source, 'g'));
    const nodes: Node[] = [];
    for (let i = 0; i < parts.length; i += 3) {
      const text = parts[i]!;
      if (text) nodes.push(document.createTextNode(text));
      const name = parts[i + 1];
      if (name === undefined) break;
      const half = halfOf(parts[i + 2]);
      if (isActionId(name)) {
        const k = document.createElement('kbd');
        k.className = 'ks-onb-key';
        k.dataset['action'] = name;
        if (half) k.dataset['half'] = half;
        this.setKeyLabel(k, name, half);
        nodes.push(k);
      } else {
        nodes.push(document.createTextNode(`{${name}${half ?? ''}}`));
      }
    }
    target.replaceChildren(...nodes);
  }

  private setKeyLabel(k: HTMLElement, action: ActionId, half: AxisHalf | undefined): void {
    const label = half ? this.labelFor(action, half) : this.labelFor(action);
    if (k.textContent !== label) k.textContent = label;
    k.classList.toggle('is-unbound', label === t('input.unbound'));
  }

  private refreshLabels(): void {
    // A device switch can change the wording, not just the labels.
    const step = this.tour.step;
    if (step && this.shown !== 'farewell' && this.currentDevice() !== this.hintDevice) {
      this.hintDevice = this.currentDevice();
      this.renderTemplate(this.hint, this.variant(`onboarding.step.${step.id}.hint`), this.params());
      this.nudgeSig = '';
    }
    for (const k of this.root.querySelectorAll<HTMLElement>('kbd.ks-onb-key')) {
      const a = k.dataset['action'];
      if (a && isActionId(a)) this.setKeyLabel(k, a, halfOf(k.dataset['half']));
    }
  }

  private currentDevice(): 'kbm' | 'pad' {
    try {
      return this.device?.() ?? 'kbm';
    } catch {
      return 'kbm';
    }
  }

  /** The gamepad wording of a message when a pad is in use and the locale has one. */
  private variant(key: string): string {
    return this.currentDevice() === 'pad' && hasKey(`${key}.pad`) ? `${key}.pad` : key;
  }

  /** Plain-text version of a template, with key labels in place of the placeholders (for announcements). */
  private plain(key: string, params: Readonly<Record<string, string>>): string {
    return t(key, params).replace(new RegExp(PLACEHOLDER.source, 'g'), (m, name: string, sign: string) => {
      if (!isActionId(name)) return m;
      const half = halfOf(sign);
      return half ? this.labelFor(name, half) : this.labelFor(name);
    });
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
    this.renderTemplate(text, this.variant(n.key), { button: t('map.showStars'), ...n.params });
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
    const hint = this.plain(this.variant(`onboarding.step.${step.id}.hint`), this.params());
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
