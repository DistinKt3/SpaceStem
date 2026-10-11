/**
 * Pause-menu settings dialog: Controls (rebinding for keyboard/mouse and gamepad), Accessibility, Audio, Graphics.
 *
 * Accessibility contract: a native modal <dialog> (role=dialog, aria-modal) with a focus trap that returns focus on
 * close; WAI-ARIA tabs (arrow keys, Home/End); every control is a labelled native input; a polite live region
 * announces rebinding prompts and results. Gamepad: D-pad / left stick move focus spatially, A selects, B closes,
 * X clears a binding, LB/RB switch tabs. Everything scales with the root font size (text scale) and follows the
 * colour-blind and reduced-motion settings through CSS tokens.
 */
import './ui.css';
import { formatNumber, t } from '../i18n';
import { ACTIONS, ACTION_CATEGORIES, PAD, actionDef, findConflicts, isFixedSlot, type ActionId } from '../input/actions';
import { inputsOf, type Binding, type InputContext } from '../input/bindings';
import type { InputManager, RebindStep } from '../input/inputManager';
import { bindingLabel, bindingParts, getPadStyle, inputLabel, loadKeyboardLayout } from '../input/labels';
import { GamepadMenuNav, pickSpatial, type NavCommand, type NavDirection } from '../input/menuNav';
import { CAPTION_SIZES, COLORBLIND_MODES, LIMITS, QUALITY_PRESETS, type Settings, type SettingsData, type SettingsKey } from '../settings/settings';

export type SettingsTab = 'controls' | 'accessibility' | 'audio' | 'graphics';

/** The guided tour's Settings entries (passed only where the tour can run). */
export interface TourActions {
  restart(): void;
  end(): void;
  /** End is offered only while the tour shows. */
  isActive(): boolean;
}
export const SETTINGS_TABS: readonly SettingsTab[] = ['controls', 'accessibility', 'audio', 'graphics'];

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const ICONS = {
  controls:
    '<path d="M7 9h3M8.5 7.5v3M15 9.2h.01M17.5 11h.01"/><path d="M6.8 5h10.4a4 4 0 0 1 3.9 3.2l1 5.3a2.6 2.6 0 0 1-4.6 2l-1.8-2H8.3l-1.8 2a2.6 2.6 0 0 1-4.6-2l1-5.3A4 4 0 0 1 6.8 5Z"/>',
  accessibility: '<circle cx="12" cy="4.5" r="1.8"/><path d="M4.5 8.5 12 10l7.5-1.5M12 10v4.5m0 0-3.5 6.5m3.5-6.5 3.5 6.5"/>',
  audio: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
  graphics: '<rect x="3" y="4.5" width="18" height="12" rx="1.8"/><path d="M9 20h6M12 16.5V20"/><path d="m7.5 13 3-3.5 2.2 2.2 1.8-1.7 2 3"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  warn: '<path d="M12 3.8 21.5 20h-19z"/><path d="M12 10v4.5M12 17.2h.01"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="1.6"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4.5v4.2h4.2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="1.8"/><path d="M6 9.5h.01M9 9.5h.01M12 9.5h.01M15 9.5h.01M18 9.5h.01M6 12.5h.01M18 12.5h.01M8.5 15h7"/>',
  gamepad:
    '<path d="M6.8 7h10.4a4 4 0 0 1 3.9 3.2l.8 4.3a2.4 2.4 0 0 1-4.2 1.9L16 14.6H8l-1.7 1.8a2.4 2.4 0 0 1-4.2-1.9l.8-4.3A4 4 0 0 1 6.8 7Z"/><path d="M7.5 10.2v2.6M6.2 11.5h2.6M15.5 10.8h.01M17.2 12.2h.01"/>',
  mouse: '<rect x="6.5" y="3" width="11" height="18" rx="5.5"/><path d="M12 3v6"/>',
} as const;

function icon(name: keyof typeof ICONS, cls = 'ks-ico'): HTMLSpanElement {
  const s = h('span', { class: cls, 'aria-hidden': 'true' });
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

let instances = 0;

interface Slider {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  set(v: number): void;
}

interface Toggle {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  set(v: boolean): void;
}

interface Choice<T extends string> {
  readonly root: HTMLElement;
  set(v: T): void;
}

export class SettingsPanel {
  readonly element: HTMLDialogElement;
  private readonly uid = `ks-set-${++instances}`;
  private tab: SettingsTab = 'controls';
  private device: InputContext;
  private returnFocus: HTMLElement | null = null;
  private prevInputEnabled = true;
  private readonly closeCbs = new Set<() => void>();
  private readonly nav: GamepadMenuNav;
  private navRaf = 0;
  private listening: { id: ActionId; slot: 0 | 1; step: RebindStep } | null = null;
  private resetArmedUntil = 0;
  private resetTimer = 0;
  private sections = 0;
  private openState = false;
  private readonly unsub: () => void;

  private readonly tabs = new Map<SettingsTab, HTMLButtonElement>();
  private readonly panes = new Map<SettingsTab, HTMLElement>();
  private readonly paneTitle: HTMLElement;
  private readonly hints: HTMLElement;
  private readonly live: HTMLElement;
  private readonly binds: HTMLElement;
  private readonly conflictBanner: HTMLElement;
  private readonly resetBtn: HTMLButtonElement;
  private readonly deviceChoice: Choice<InputContext>;
  private readonly sensitivity: Slider;
  private readonly invertY: Toggle;
  private readonly textScale: Slider;
  private readonly preview: HTMLElement;
  private readonly colorblind: Choice<SettingsData['colorblind']>;
  private readonly reducedMotion: Toggle;
  private readonly subtitles: Toggle;
  private readonly captionSize: Choice<SettingsData['captionSize']>;
  private readonly captionSample: HTMLElement;
  private readonly volumes: Record<keyof SettingsData['volumes'], Slider>;
  private readonly quality: Choice<SettingsData['quality']>;
  private readonly fov: Slider;
  private readonly showFps: Toggle;

  constructor(
    private readonly settings: Settings,
    private readonly input: InputManager,
    options: { parent?: HTMLElement; tour?: TourActions } = {},
  ) {
    this.device = input.activeDevice;
    this.nav = new GamepadMenuNav(() => {
      try {
        return navigator.getGamepads();
      } catch {
        return [];
      }
    });
    const id = (s: string): string => `${this.uid}-${s}`;

    // Shell.
    this.live = h('p', { class: 'ks-sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    this.paneTitle = h('p', { class: 'ks-set-panetitle', 'aria-hidden': 'true' });
    const tablist = h('div', { class: 'ks-set-tabs', role: 'tablist', 'aria-label': t('settings.tabs.label') });
    for (const tab of SETTINGS_TABS) {
      const b = h(
        'button',
        { type: 'button', class: 'ks-tab', role: 'tab', id: id(`tab-${tab}`), 'aria-controls': id(`pane-${tab}`), 'aria-selected': 'false', tabindex: -1, 'data-tab': tab },
        icon(tab),
        h('span', { class: 'ks-tab-label' }, t(`settings.tab.${tab}`)),
      );
      b.addEventListener('click', () => this.selectTab(tab, true));
      this.tabs.set(tab, b);
      tablist.append(b);
    }
    tablist.addEventListener('keydown', (e) => this.onTabKey(e));

    const closeBtn = h('button', { type: 'button', class: 'ks-btn ks-set-close', 'aria-label': t('settings.close.aria') }, icon('close'), h('span', {}, t('settings.close')));
    closeBtn.addEventListener('click', () => this.close());

    // --- Controls pane ---
    this.deviceChoice = this.choice<InputContext>(
      'device',
      t('settings.controls.device'),
      [
        { value: 'kbm', label: t('settings.controls.device.kbm'), icon: 'keyboard' },
        { value: 'pad', label: t('settings.controls.device.pad'), icon: 'gamepad' },
      ],
      this.device,
      (v) => {
        this.input.cancelRebind();
        this.device = v;
        this.renderControls();
      },
      'ks-seg',
    );
    this.resetBtn = h('button', { type: 'button', class: 'ks-btn ks-btn-quiet ks-reset' }, icon('reset'), h('span', {}, t('settings.controls.reset')));
    this.resetBtn.addEventListener('click', () => this.onReset());
    this.sensitivity = this.slider({
      key: 'sens',
      label: t('settings.controls.sensitivity'),
      min: 0,
      max: 100,
      step: 1,
      toUi: (v) => Math.round((Math.log(v / LIMITS.mouseSensitivity.min) / Math.log(LIMITS.mouseSensitivity.max / LIMITS.mouseSensitivity.min)) * 100),
      fromUi: (u) => Number((LIMITS.mouseSensitivity.min * (LIMITS.mouseSensitivity.max / LIMITS.mouseSensitivity.min) ** (u / 100)).toFixed(2)),
      format: (v) => t('settings.value.multiplier', { v: formatNumber(v, 2, 2) }),
      value: settings.data.mouseSensitivity,
      commit: (v) => this.settings.set({ mouseSensitivity: v }),
    });
    this.invertY = this.toggle('invertY', t('settings.controls.invertY'), t('settings.controls.invertY.hint'), settings.data.invertY, (v) =>
      this.settings.set({ invertY: v }),
    );
    this.conflictBanner = h('div', { class: 'ks-banner ks-banner-warn', role: 'status', hidden: true });
    this.binds = h('div', { class: 'ks-binds' });
    const controls = this.pane(
      'controls',
      h('div', { class: 'ks-ctl-bar' }, this.deviceChoice.root, this.resetBtn),
      h('div', { class: 'ks-ctl-tuning' }, this.sensitivity.root, this.invertY.root),
      this.conflictBanner,
      h(
        'div',
        { class: 'ks-binds-head', 'aria-hidden': 'true' },
        h('span', {}, t('settings.controls.col.action')),
        h('span', {}, t('settings.controls.col.primary')),
        h('span', {}, t('settings.controls.col.secondary')),
      ),
      this.binds,
      h('p', { class: 'ks-note', id: id('slot-hint') }, t('settings.controls.hint')),
    );

    // --- Accessibility pane ---
    this.preview = this.buildPreview();
    this.textScale = this.slider({
      key: 'text',
      label: t('settings.a11y.textScale'),
      hint: t('settings.a11y.textScale.hint'),
      min: LIMITS.textScale.min * 100,
      max: LIMITS.textScale.max * 100,
      step: LIMITS.textScale.step * 100,
      toUi: (v) => Math.round(v * 100),
      fromUi: (u) => u / 100,
      format: (v) => t('settings.value.percent', { v: Math.round(v * 100) }),
      value: settings.data.textScale,
      // Dragging previews in the sample only; the whole UI rescales on release (so the slider never jumps under the
      // pointer). Keyboard steps commit immediately.
      preview: (v) => this.preview.style.setProperty('--ks-preview-scale', String(v / this.settings.data.textScale)),
      commit: (v) => {
        this.settings.set({ textScale: v });
        this.preview.style.setProperty('--ks-preview-scale', '1');
      },
    });
    this.colorblind = this.choice(
      'colorblind',
      t('settings.a11y.colorblind'),
      COLORBLIND_MODES.map((m) => ({ value: m, label: t(`settings.colorblind.${m}`), desc: t(`settings.colorblind.${m}.desc`), extra: this.swatches(m), palette: m })),
      settings.data.colorblind,
      (v) => this.settings.set({ colorblind: v }),
      'ks-cards',
      t('settings.a11y.colorblind.hint'),
    );
    this.reducedMotion = this.toggle('motion', t('settings.a11y.reducedMotion'), this.motionHint(), settings.data.reducedMotion, (v) =>
      this.settings.set({ reducedMotion: v }),
    );
    this.subtitles = this.toggle('subs', t('settings.a11y.subtitles'), t('settings.a11y.subtitles.hint'), settings.data.subtitles, (v) =>
      this.settings.set({ subtitles: v }),
    );
    this.captionSample = h('p', { class: 'ks-caption-sample', 'aria-hidden': 'true' }, h('span', {}, t('settings.captions.sample')));
    this.captionSize = this.choice(
      'captions',
      t('settings.a11y.captionSize'),
      CAPTION_SIZES.map((s) => ({ value: s, label: t(`settings.captionSize.${s}`) })),
      settings.data.captionSize,
      (v) => this.settings.set({ captionSize: v }),
      'ks-seg',
    );
    const a11y = this.pane(
      'accessibility',
      this.section(t('settings.a11y.section.text'), this.preview, this.textScale.root),
      this.section(t('settings.a11y.section.colour'), this.colorblind.root),
      this.section(t('settings.a11y.section.motion'), this.reducedMotion.root),
      this.section(t('settings.a11y.section.captions'), this.subtitles.root, this.captionSize.root, this.captionSample),
      options.tour ? this.tourSection(options.tour) : null,
    );

    // --- Audio pane ---
    const vol = (k: keyof SettingsData['volumes']): Slider =>
      this.slider({
        key: `vol-${k}`,
        label: t(`settings.audio.${k}`),
        min: 0,
        max: 100,
        step: 1,
        toUi: (v) => Math.round(v * 100),
        fromUi: (u) => u / 100,
        format: (v) => t('settings.value.percent', { v: Math.round(v * 100) }),
        value: settings.data.volumes[k],
        commit: (v) => this.settings.set({ volumes: { [k]: v } }),
        live: true,
      });
    this.volumes = { master: vol('master'), music: vol('music'), sfx: vol('sfx') };
    const audio = this.pane(
      'audio',
      this.section(t('settings.audio.section'), this.volumes.master.root, this.volumes.music.root, this.volumes.sfx.root),
      h('p', { class: 'ks-note' }, t('settings.audio.note')),
    );

    // --- Graphics pane ---
    this.quality = this.choice(
      'quality',
      t('settings.graphics.quality'),
      QUALITY_PRESETS.map((q) => ({ value: q, label: t(`settings.quality.${q}`), desc: t(`settings.quality.${q}.desc`) })),
      settings.data.quality,
      (v) => this.settings.set({ quality: v }),
      'ks-cards ks-cards-compact',
    );
    this.fov = this.slider({
      key: 'fov',
      label: t('settings.graphics.fov'),
      hint: t('settings.graphics.fov.hint'),
      min: LIMITS.fovDeg.min,
      max: LIMITS.fovDeg.max,
      step: LIMITS.fovDeg.step,
      toUi: (v) => v,
      fromUi: (u) => u,
      format: (v) => t('settings.value.degrees', { v: Math.round(v) }),
      value: settings.data.fovDeg,
      commit: (v) => this.settings.set({ fovDeg: v }),
      live: true,
    });
    this.showFps = this.toggle('fps', t('settings.graphics.showFps'), t('settings.graphics.showFps.hint'), settings.data.showFps, (v) =>
      this.settings.set({ showFps: v }),
    );
    const graphics = this.pane('graphics', this.section(t('settings.graphics.section.quality'), this.quality.root), this.section(t('settings.graphics.section.view'), this.fov.root, this.showFps.root));

    this.hints = h('div', { class: 'ks-set-hints', 'aria-hidden': 'true' });
    this.renderHints();

    const frame = h(
      'div',
      { class: 'ks-set-frame' },
      h('div', { class: 'ks-set-brand' }, h('p', { class: 'ks-set-eyebrow' }, t('settings.eyebrow')), h('h2', { class: 'ks-set-title', id: id('title') }, t('settings.title'))),
      h('div', { class: 'ks-set-head' }, this.paneTitle, closeBtn),
      tablist,
      h('div', { class: 'ks-set-body' }, controls, a11y, audio, graphics),
      this.hints,
      this.live,
    );
    this.element = h('dialog', { class: 'ks-settings', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id('title'), 'data-input': 'keyboard' }, frame);
    this.element.addEventListener('keydown', (e) => this.onKey(e));
    this.element.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.close();
    });
    this.element.addEventListener('close', () => {
      if (this.openState) this.finishClose();
    });
    this.element.addEventListener('pointerdown', (e) => {
      this.element.dataset['input'] = 'pointer';
      // A press on the backdrop (outside the frame) resumes, like most game menus.
      if (e.target === this.element) this.close();
    });
    (options.parent ?? document.body).append(this.element);

    this.unsub = settings.onChange((d, changed) => this.sync(d, changed));
    this.selectTab('controls', false);
    this.renderControls();
  }

  get isOpen(): boolean {
    return this.openState;
  }

  /** Opens the dialog (on the given tab, else the last one) and disables game input until it closes. */
  open(tab?: SettingsTab): void {
    if (tab) this.selectTab(tab, false);
    if (this.openState) {
      this.tabs.get(this.tab)?.focus();
      return;
    }
    this.openState = true;
    const active = document.activeElement;
    this.returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    this.prevInputEnabled = this.input.enabled;
    this.input.releasePointerLock();
    this.input.enabled = false;
    if (this.input.activeDevice !== this.device) {
      this.device = this.input.activeDevice;
      this.deviceChoice.set(this.device);
    }
    this.element.dataset['input'] = this.input.activeDevice === 'pad' ? 'pad' : 'keyboard';
    if (this.tourEnd) this.tourEnd.hidden = !this.tourActive();
    this.sync(this.settings.data, new Set(Object.keys(this.settings.data) as SettingsKey[]));
    this.renderControls();
    this.renderHints();
    void loadKeyboardLayout().then((ok) => {
      if (ok && this.openState) this.renderControls();
    });
    try {
      this.element.showModal();
    } catch {
      this.element.show();
    }
    this.tabs.get(this.tab)?.focus();
    this.nav.reset();
    const loop = (): void => {
      if (!this.openState) return;
      this.pollNav();
      this.navRaf = requestAnimationFrame(loop);
    };
    this.navRaf = requestAnimationFrame(loop);
  }

  close(): void {
    if (!this.openState) return;
    if (this.element.open) this.element.close();
    this.finishClose();
  }

  /** Subscribes to close events; returns the unsubscribe function. */
  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  dispose(): void {
    this.close();
    this.unsub();
    this.element.remove();
  }

  private finishClose(): void {
    this.openState = false;
    this.input.cancelRebind();
    this.listening = null;
    cancelAnimationFrame(this.navRaf);
    this.input.enabled = this.prevInputEnabled;
    const rf = this.returnFocus;
    this.returnFocus = null;
    if (rf?.isConnected) rf.focus({ preventScroll: true });
    for (const cb of [...this.closeCbs]) cb();
  }

  // --- Tabs ---------------------------------------------------------------------------------------------------------

  private selectTab(tab: SettingsTab, focus: boolean): void {
    if (this.tab !== tab) this.input.cancelRebind();
    this.tab = tab;
    for (const [k, b] of this.tabs) {
      const on = k === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-active', on);
    }
    for (const [k, p] of this.panes) p.hidden = k !== tab;
    this.paneTitle.textContent = t(`settings.tab.${tab}`);
    this.panes.get(tab)?.scrollTo?.({ top: 0 });
    if (focus) this.tabs.get(tab)?.focus();
  }

  private onTabKey(e: KeyboardEvent): void {
    const i = SETTINGS_TABS.indexOf(this.tab);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % SETTINGS_TABS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = SETTINGS_TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    this.selectTab(SETTINGS_TABS[next]!, true);
  }

  // --- Keyboard: focus trap, Escape, slot shortcuts ------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    this.element.dataset['input'] = 'keyboard';
    if (e.key === 'Escape') {
      // Rebind capture swallows its own Escape before this runs; reaching here means "resume".
      e.preventDefault();
      e.stopPropagation(); // The game's input must not see this Escape and reopen the menu.
      this.close();
      return;
    }
    if (e.key === 'Tab') {
      const items = this.focusables(true);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !this.element.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !this.element.contains(active))) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    const slot = (e.target as HTMLElement | null)?.closest?.('.ks-slot');
    if (slot instanceof HTMLButtonElement && (e.key === 'Delete' || e.key === 'Backspace') && !this.listening) {
      e.preventDefault();
      this.clearSlot(slot);
    }
    if ((e.key === 'PageDown' || e.key === 'PageUp') && e.ctrlKey) {
      e.preventDefault();
      this.stepTab(e.key === 'PageDown' ? 1 : -1);
    }
  }

  private stepTab(d: number): void {
    const i = SETTINGS_TABS.indexOf(this.tab);
    this.selectTab(SETTINGS_TABS[(i + d + SETTINGS_TABS.length) % SETTINGS_TABS.length]!, true);
  }

  /** Focusable elements in the dialog; `tabbable` limits to the Tab order. */
  private focusables(tabbable: boolean): HTMLElement[] {
    return [...this.element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
      if ((el as HTMLButtonElement).disabled || !isVisible(el)) return false;
      if (el.closest('[hidden]')) return false;
      if (tabbable) {
        if (el.tabIndex < 0) return false;
        // Only the checked radio of a group is in the Tab order.
        if (el instanceof HTMLInputElement && el.type === 'radio' && !el.checked) {
          const group = this.element.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${el.name}"]`);
          if ([...group].some((r) => r.checked)) return false;
        }
      }
      return true;
    });
  }

  // --- Gamepad navigation -------------------------------------------------------------------------------------------

  private pollNav(): void {
    const cmds = this.nav.poll(performance.now() / 1000);
    if (cmds.length === 0) return;
    this.element.dataset['input'] = 'pad';
    for (const c of cmds) this.navCommand(c);
  }

  private navCommand(c: NavCommand): void {
    if (this.listening) return; // The capture owns the pad (Menu cancels it).
    const active = document.activeElement instanceof HTMLElement && this.element.contains(document.activeElement) ? document.activeElement : null;
    switch (c) {
      case 'menu':
      case 'back':
        this.close();
        return;
      case 'tabPrev':
      case 'tabNext':
        this.stepTab(c === 'tabNext' ? 1 : -1);
        return;
      case 'accept':
        if (active instanceof HTMLInputElement && (active.type === 'radio' || active.type === 'checkbox')) active.click();
        else if (active instanceof HTMLButtonElement) active.click();
        return;
      case 'clear':
        if (active instanceof HTMLButtonElement && active.classList.contains('ks-slot')) this.clearSlot(active);
        return;
      default:
        this.navMove(c, active);
    }
  }

  private navMove(dir: NavDirection, active: HTMLElement | null): void {
    if (active instanceof HTMLInputElement && active.type === 'range' && (dir === 'left' || dir === 'right')) {
      if (dir === 'right') active.stepUp();
      else active.stepDown();
      active.dispatchEvent(new Event('input', { bubbles: true }));
      active.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    // Containers are focusable for scrolling but are not navigation stops.
    const items = this.focusables(false).filter((el) => el !== active && !el.classList.contains('ks-pane'));
    if (!active) {
      items[0]?.focus({ focusVisible: true });
      return;
    }
    // Visually hidden radios and switches navigate by their visible card or track.
    const rectOf = (el: HTMLElement): DOMRect => (el.closest('.ks-choice, .ks-switch') ?? el).getBoundingClientRect();
    const i = pickSpatial(rectOf(active), items.map(rectOf), dir);
    const target = items[i];
    if (!target) return;
    target.focus({ focusVisible: true });
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Tabs activate on focus, as they do with the arrow keys.
    const tab = target.dataset['tab'] as SettingsTab | undefined;
    if (target.getAttribute('role') === 'tab' && tab) this.selectTab(tab, false);
  }

  // --- Controls -----------------------------------------------------------------------------------------------------

  private renderControls(): void {
    const ctx = this.device;
    const map = ctx === 'kbm' ? this.settings.data.bindings : this.settings.data.padBindings;
    const conflicts = findConflicts(map, ctx);
    const otherConflicts = findConflicts(ctx === 'kbm' ? this.settings.data.padBindings : this.settings.data.bindings, ctx === 'kbm' ? 'pad' : 'kbm');
    this.element.dataset['device'] = ctx;
    this.sensitivity.root.hidden = ctx !== 'kbm';
    this.element.querySelectorAll<HTMLElement>('.ks-seg-device .ks-opt-alert').forEach((el) => {
      const v = el.dataset['for'];
      el.hidden = !(v === ctx ? conflicts.length > 0 : otherConflicts.length > 0);
    });

    // Remember focus so re-rendering after a rebind keeps the player's place.
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusKey = focused && this.binds.contains(focused) ? `${focused.dataset['action'] ?? ''}:${focused.dataset['slot'] ?? ''}` : null;

    const sharedWith = (id: ActionId, b: Binding | null): ActionId[] => {
      if (!b) return [];
      const ins = new Set(inputsOf(b));
      const out = new Set<ActionId>();
      for (const c of conflicts) if (ins.has(c.binding) && c.actions.includes(id)) for (const a of c.actions) if (a !== id) out.add(a);
      return [...out];
    };

    const frag = document.createDocumentFragment();
    for (const cat of ACTION_CATEGORIES) {
      const catId = `${this.uid}-cat-${cat}`;
      const list = h('ul', { class: 'ks-bind-list', 'aria-labelledby': catId });
      for (const a of ACTIONS.filter((x) => x.category === cat)) {
        const nameId = `${this.uid}-act-${a.id}`;
        const warnId = `${this.uid}-warn-${a.id}`;
        const slots = map[a.id] ?? [null, null];
        const clash = new Set<ActionId>([...sharedWith(a.id, slots[0]), ...sharedWith(a.id, slots[1])]);
        const row = h(
          'li',
          { class: `ks-bind${clash.size > 0 ? ' is-conflict' : ''}`, 'data-action': a.id },
          h(
            'span',
            { class: 'ks-bind-name', id: nameId },
            t(a.label),
            a.kind === 'axis' ? h('span', { class: 'ks-bind-axis' }, t('settings.controls.axisDirs', { neg: t(a.neg!), pos: t(a.pos!) })) : null,
          ),
          this.slotButton(a.id, 0, slots[0], sharedWith(a.id, slots[0]).length > 0, warnId),
          this.slotButton(a.id, 1, slots[1], sharedWith(a.id, slots[1]).length > 0, warnId),
        );
        if (clash.size > 0) {
          row.append(
            h(
              'p',
              { class: 'ks-bind-warn', id: warnId },
              icon('warn'),
              h('span', {}, t('settings.controls.conflictWith', { actions: listFormat([...clash].map((x) => t(actionDef(x).label))) })),
            ),
          );
        }
        list.append(row);
      }
      frag.append(h('section', { class: 'ks-bind-cat' }, h('h4', { class: 'ks-bind-cat-title', id: catId }, t(`input.category.${cat}`)), list));
    }
    this.binds.replaceChildren(frag);

    if (conflicts.length > 0) {
      this.conflictBanner.hidden = false;
      this.conflictBanner.replaceChildren(icon('warn'), h('span', {}, plural('settings.controls.conflicts', conflicts.length)));
    } else this.conflictBanner.hidden = true;

    if (focusKey) {
      const [action, slot] = focusKey.split(':');
      this.binds.querySelector<HTMLElement>(`.ks-slot[data-action="${action}"][data-slot="${slot}"]`)?.focus({ preventScroll: true });
    }
  }

  private slotButton(id: ActionId, slot: 0 | 1, b: Binding | null, conflict: boolean, warnId: string): HTMLElement {
    const fixed = isFixedSlot(this.device, id, slot);
    const btn = h('button', { type: 'button', 'data-action': id, 'data-slot': slot });
    this.fillSlot(btn, id, slot, b, conflict, warnId);
    btn.addEventListener('click', () => {
      if (fixed) {
        this.announce(t('settings.controls.fixed'));
        return;
      }
      void this.startCapture(id, slot, btn);
    });
    return btn;
  }

  /** (Re)draws one slot button in place, so a capture in progress keeps the same element under the pointer. */
  private fillSlot(btn: HTMLElement, id: ActionId, slot: 0 | 1, b: Binding | null, conflict: boolean, warnId: string | null): void {
    const fixed = isFixedSlot(this.device, id, slot);
    const listening = this.listening?.id === id && this.listening.slot === slot ? this.listening : null;
    const slotName = t(slot === 0 ? 'settings.controls.col.primary' : 'settings.controls.col.secondary');
    const action = t(actionDef(id).label);
    btn.className = `ks-slot${conflict ? ' is-conflict' : ''}${fixed ? ' is-fixed' : ''}${listening ? ' is-listening' : ''}${b ? '' : ' is-empty'}`;
    btn.setAttribute(
      'aria-label',
      listening
        ? this.promptText(id, listening.step)
        : t(fixed ? 'settings.controls.slotFixedAria' : 'settings.controls.slotAria', { action, slot: slotName, binding: bindingLabel(b, 'long') }),
    );
    const described = [conflict ? warnId : null, fixed ? null : `${this.uid}-slot-hint`].filter(Boolean).join(' ');
    if (described) btn.setAttribute('aria-describedby', described);
    else btn.removeAttribute('aria-describedby');
    if (fixed) {
      btn.setAttribute('aria-disabled', 'true');
      btn.title = t('settings.controls.fixed');
    }
    btn.replaceChildren();
    if (listening) {
      btn.append(h('span', { class: 'ks-listen' }, h('span', { class: 'ks-listen-dot', 'aria-hidden': 'true' }), this.promptShort(id, listening.step)));
    } else if (b) {
      const parts = bindingParts(b);
      const cls = b.type.startsWith('pad') ? `ks-kbd ks-kbd-pad ks-pad-${getPadStyle()}` : b.type === 'mouseButton' || b.type === 'wheel' ? 'ks-kbd ks-kbd-mouse' : 'ks-kbd';
      const keys = h('span', { class: 'ks-keys', 'aria-hidden': 'true' });
      parts.forEach((p, i) => {
        if (i > 0) keys.append(h('span', { class: 'ks-keys-sep' }, t('input.binding.sep')));
        keys.append(h('kbd', { class: `${cls}${p.length > 3 ? ' is-wide' : ''}` }, b.type === 'mouseButton' ? icon('mouse', 'ks-ico ks-ico-inline') : null, p));
      });
      btn.append(keys);
      if (fixed) btn.append(icon('lock', 'ks-ico ks-slot-lock'));
    } else {
      btn.append(h('span', { class: 'ks-unbound', 'aria-hidden': 'true' }, t('input.unbound.short')));
    }
  }

  private promptShort(id: ActionId, step: RebindStep): string {
    const def = actionDef(id);
    if (step === 'any') return t(this.device === 'pad' ? 'settings.controls.listen.pad' : 'settings.controls.listen.kbm');
    if (step === 'neg') return t(this.device === 'pad' ? 'settings.controls.listen.axisPad' : 'settings.controls.listen.neg', { dir: t(def.neg!), pos: t(def.pos!) });
    return t('settings.controls.listen.pos', { dir: t(def.pos!) });
  }

  private promptText(id: ActionId, step: RebindStep): string {
    return t('settings.controls.listen.aria', { action: t(actionDef(id).label), prompt: this.promptShort(id, step) });
  }

  private async startCapture(id: ActionId, slot: 0 | 1, btn: HTMLElement): Promise<void> {
    const step: RebindStep = actionDef(id).kind === 'axis' ? 'neg' : 'any';
    const redraw = (): void => {
      const map = this.device === 'kbm' ? this.settings.data.bindings : this.settings.data.padBindings;
      this.fillSlot(btn, id, slot, map[id]?.[slot] ?? null, false, null);
    };
    this.listening = { id, slot, step };
    redraw();
    btn.focus({ preventScroll: true });
    this.announce(this.promptText(id, step));
    const result = await this.input.beginRebind(id, slot, {
      context: this.device,
      mouseTarget: btn,
      onStep: (s) => {
        if (this.listening?.id !== id || this.listening.slot !== slot) return;
        this.listening = { id, slot, step: s };
        redraw();
        this.announce(this.promptText(id, s));
      },
    });
    if (this.listening?.id !== id || this.listening.slot !== slot) return; // Superseded by another capture.
    this.listening = null;
    this.renderControls();
    if (this.openState) this.focusSlot(id, slot);
    const action = t(actionDef(id).label);
    if (!result) {
      this.announce(t('settings.controls.cancelled', { action }));
      return;
    }
    const clash = findConflicts(this.device === 'kbm' ? this.settings.data.bindings : this.settings.data.padBindings, this.device).filter((c) => c.actions.includes(id));
    const others = [...new Set(clash.flatMap((c) => c.actions.filter((a) => a !== id)))].map((a) => t(actionDef(a).label));
    this.announce(
      others.length > 0
        ? t('settings.controls.boundConflict', { action, binding: bindingLabel(result, 'long'), actions: listFormat(others) })
        : t('settings.controls.bound', { action, binding: bindingLabel(result, 'long') }),
    );
  }

  private focusSlot(id: ActionId, slot: 0 | 1): void {
    this.binds.querySelector<HTMLElement>(`.ks-slot[data-action="${id}"][data-slot="${slot}"]`)?.focus({ preventScroll: false });
  }

  private clearSlot(btn: HTMLButtonElement): void {
    const id = btn.dataset['action'] as ActionId | undefined;
    const slot = Number(btn.dataset['slot']) as 0 | 1;
    if (!id || isFixedSlot(this.device, id, slot)) return;
    if (this.input.setBinding(id, slot, null, this.device)) {
      this.focusSlot(id, slot);
      this.announce(t('settings.controls.cleared', { action: t(actionDef(id).label) }));
    }
  }

  private onReset(): void {
    const now = performance.now();
    if (now > this.resetArmedUntil) {
      // Two-step confirm: a stray press must not wipe a custom layout.
      this.resetArmedUntil = now + 4000;
      this.resetBtn.classList.add('is-armed');
      this.resetBtn.querySelector('span:last-child')!.textContent = t('settings.controls.resetConfirm');
      this.announce(t('settings.controls.resetConfirm'));
      clearTimeout(this.resetTimer);
      this.resetTimer = window.setTimeout(() => this.disarmReset(), 4000);
      return;
    }
    this.disarmReset();
    this.input.cancelRebind();
    this.input.resetDefaults(this.device);
    this.announce(t('settings.controls.resetDone'));
  }

  private disarmReset(): void {
    this.resetArmedUntil = 0;
    this.resetBtn.classList.remove('is-armed');
    this.resetBtn.querySelector('span:last-child')!.textContent = t('settings.controls.reset');
  }

  // --- Accessibility helpers ----------------------------------------------------------------------------------------

  private buildPreview(): HTMLElement {
    const badge = (p: 'measured' | 'inferred' | 'generated'): HTMLElement =>
      h('span', { class: `ks-prov ks-prov-${p}` }, h('span', { class: 'ks-prov-mark', 'aria-hidden': 'true' }), t(`settings.preview.${p}`));
    return h(
      'div',
      { class: 'ks-preview', 'aria-hidden': 'true' },
      h('div', { class: 'ks-preview-inner' },
        h('p', { class: 'ks-preview-k' }, t('settings.preview.label')),
        h('p', { class: 'ks-preview-v' }, t('settings.preview.value'), badge('measured')),
        h('p', { class: 'ks-preview-t' }, t('settings.preview.text')),
        h('p', { class: 'ks-preview-badges' }, badge('inferred'), badge('generated')),
      ),
    );
  }

  private swatches(mode: SettingsData['colorblind']): HTMLElement {
    const chip = (p: 'measured' | 'inferred' | 'generated'): HTMLElement =>
      h('span', { class: `ks-chip ks-chip-${p}` }, t(`settings.palette.${p}`));
    return h(
      'span',
      { class: 'ks-swatches ks-palette', 'data-colorblind': mode, 'aria-hidden': 'true' },
      chip('measured'),
      chip('inferred'),
      chip('generated'),
      h('span', { class: 'ks-dots' }, h('span', { class: 'ks-dot ks-dot-ok' }), h('span', { class: 'ks-dot ks-dot-warn' }), h('span', { class: 'ks-dot ks-dot-danger' })),
    );
  }

  private motionHint(): string {
    let system: boolean;
    try {
      system = matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      system = false;
    }
    return t(system ? 'settings.a11y.reducedMotion.hintSystem' : 'settings.a11y.reducedMotion.hint');
  }


  // --- Sync from settings -------------------------------------------------------------------------------------------

  private sync(d: Readonly<SettingsData>, changed: ReadonlySet<SettingsKey>): void {
    if (changed.has('mouseSensitivity')) this.sensitivity.set(d.mouseSensitivity);
    if (changed.has('invertY')) this.invertY.set(d.invertY);
    if (changed.has('textScale')) this.textScale.set(d.textScale);
    if (changed.has('colorblind')) this.colorblind.set(d.colorblind);
    if (changed.has('reducedMotion')) this.reducedMotion.set(d.reducedMotion);
    if (changed.has('subtitles')) {
      this.subtitles.set(d.subtitles);
      this.captionSize.root.classList.toggle('is-muted', !d.subtitles);
      this.captionSample.classList.toggle('is-muted', !d.subtitles);
    }
    if (changed.has('captionSize')) {
      this.captionSize.set(d.captionSize);
      this.captionSample.dataset['size'] = d.captionSize;
    }
    if (changed.has('volumes')) for (const k of ['master', 'music', 'sfx'] as const) this.volumes[k].set(d.volumes[k]);
    if (changed.has('quality')) this.quality.set(d.quality);
    if (changed.has('fovDeg')) this.fov.set(d.fovDeg);
    if (changed.has('showFps')) this.showFps.set(d.showFps);
    if ((changed.has('bindings') || changed.has('padBindings')) && !this.listening) this.renderControls();
  }

  private announce(text: string): void {
    this.live.textContent = '';
    requestAnimationFrame(() => (this.live.textContent = text));
  }

  private tourEnd: HTMLButtonElement | null = null;
  private tourActive: () => boolean = () => false;

  /**
   * Accessibility > Guided tour (docs/ONBOARDING.md): the keyboard and gamepad way to replay or end the tour (Tab is a
   * game binding, so the card's own buttons are for the mouse). The dialog closes first, so the tour card's live
   * region is no longer inert when it announces the change.
   */
  private tourSection(tour: TourActions): HTMLElement {
    const restart = h('button', { type: 'button', class: 'ks-btn' }, icon('reset'), h('span', {}, t('onboarding.settings.restart')));
    restart.addEventListener('click', () => {
      this.close();
      tour.restart();
    });
    const end = h('button', { type: 'button', class: 'ks-btn ks-btn-quiet' }, h('span', {}, t('onboarding.settings.end')));
    end.addEventListener('click', () => {
      this.close();
      tour.end();
    });
    this.tourEnd = end;
    this.tourActive = () => tour.isActive();
    return this.section(
      t('onboarding.settings.section'),
      h('p', { class: 'ks-note' }, t('onboarding.settings.restart.hint')),
      h('div', { class: 'ks-tour-actions' }, restart, end),
    );
  }

  // --- Widget builders ----------------------------------------------------------------------------------------------

  private pane(tab: SettingsTab, ...children: Child[]): HTMLElement {
    const p = h('section', {
      class: `ks-pane ks-pane-${tab}`,
      role: 'tabpanel',
      id: `${this.uid}-pane-${tab}`,
      'aria-labelledby': `${this.uid}-tab-${tab}`,
      tabindex: 0,
      hidden: true,
    }, ...children);
    this.panes.set(tab, p);
    return p;
  }

  private section(title: string, ...children: Child[]): HTMLElement {
    const sid = `${this.uid}-sec-${++this.sections}`;
    return h('section', { class: 'ks-section', 'aria-labelledby': sid }, h('h3', { class: 'ks-section-title', id: sid }, title), ...children);
  }

  /** Key and button hints; rebuilt on open so they name the connected pad family. */
  private renderHints(): void {
    this.hints.replaceChildren(
      h(
        'p',
        { class: 'ks-hint-kbd' },
        this.hint(['key:Tab'], t('settings.hint.move')),
        this.hint(['key:Enter'], t('settings.hint.select')),
        this.hint(['key:Escape'], t('settings.hint.resume')),
      ),
      h(
        'p',
        { class: 'ks-hint-pad' },
        this.hint([`pad:b${PAD.A}`], t('settings.hint.select')),
        this.hint([`pad:b${PAD.B}`], t('settings.hint.resume')),
        this.hint([`pad:b${PAD.LB}`, `pad:b${PAD.RB}`], t('settings.hint.tabs')),
      ),
    );
  }

  private hint(inputs: string[], label: string): HTMLElement {
    return h(
      'span',
      { class: 'ks-hint' },
      ...inputs.map((i) => h('kbd', { class: i.startsWith('pad:') ? 'ks-kbd ks-kbd-pad' : 'ks-kbd' }, inputLabel(i))),
      h('span', {}, label),
    );
  }


  private slider(o: {
    key: string;
    label: string;
    hint?: string;
    min: number;
    max: number;
    step: number;
    value: number;
    toUi: (v: number) => number;
    fromUi: (u: number) => number;
    format: (v: number) => string;
    commit: (v: number) => void;
    preview?: (v: number) => void;
    /** Commit on every input event (cheap settings such as volume). */
    live?: boolean;
  }): Slider {
    const iid = `${this.uid}-${o.key}`;
    const input = h('input', { type: 'range', id: iid, class: 'ks-range', min: o.min, max: o.max, step: o.step });
    const out = h('output', { class: 'ks-range-value', for: iid, 'aria-hidden': 'true' });
    const hintId = o.hint ? `${iid}-hint` : null;
    if (hintId) input.setAttribute('aria-describedby', hintId);
    const show = (v: number): void => {
      const text = o.format(v);
      out.textContent = text;
      input.setAttribute('aria-valuetext', text);
      input.style.setProperty('--ks-fill', `${((Number(input.value) - o.min) / (o.max - o.min)) * 100}%`);
    };
    const set = (v: number): void => {
      input.value = String(o.toUi(v));
      show(v);
    };
    input.addEventListener('input', () => {
      const v = o.fromUi(Number(input.value));
      show(v);
      if (o.live) o.commit(v);
      else o.preview?.(v);
    });
    input.addEventListener('change', () => o.commit(o.fromUi(Number(input.value))));
    set(o.value);
    const root = h(
      'div',
      { class: 'ks-field ks-field-range' },
      h('div', { class: 'ks-field-text' }, h('label', { class: 'ks-field-label', for: iid }, o.label), hintId ? h('p', { class: 'ks-field-hint', id: hintId }, o.hint) : null),
      h('div', { class: 'ks-field-ctl' }, input, out),
    );
    return { root, input, set };
  }

  private toggle(key: string, label: string, hint: string, value: boolean, onChange: (v: boolean) => void): Toggle {
    const iid = `${this.uid}-${key}`;
    const input = h('input', { type: 'checkbox', role: 'switch', id: iid, class: 'ks-switch-input', 'aria-describedby': `${iid}-hint` });
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));
    const root = h(
      'div',
      { class: 'ks-field ks-field-switch' },
      h('div', { class: 'ks-field-text' }, h('label', { class: 'ks-field-label', for: iid }, label), h('p', { class: 'ks-field-hint', id: `${iid}-hint` }, hint)),
      h('div', { class: 'ks-field-ctl' }, h('label', { class: 'ks-switch', for: iid }, input, h('span', { class: 'ks-switch-track', 'aria-hidden': 'true' }, h('span', { class: 'ks-switch-thumb' })))),
    );
    return { root, input, set: (v) => (input.checked = v) };
  }

  private choice<T extends string>(
    key: string,
    label: string,
    options: { value: T; label: string; desc?: string; extra?: Node; icon?: keyof typeof ICONS; palette?: string }[],
    value: T,
    onChange: (v: T) => void,
    cls: string,
    hint?: string,
  ): Choice<T> {
    const gid = `${this.uid}-${key}`;
    const radios: HTMLInputElement[] = [];
    const group = h('div', { class: `ks-choices ${cls} ks-seg-${key}`, role: 'radiogroup', 'aria-labelledby': `${gid}-label`, 'aria-describedby': hint ? `${gid}-hint` : null });
    for (const o of options) {
      const r = h('input', { type: 'radio', name: gid, value: o.value, class: 'ks-choice-input', id: `${gid}-${o.value}` });
      r.checked = o.value === value;
      r.addEventListener('change', () => {
        if (r.checked) onChange(o.value);
      });
      radios.push(r);
      group.append(
        h(
          'label',
          { class: 'ks-choice', for: r.id, 'data-value': o.value },
          r,
          h(
            'span',
            { class: 'ks-choice-body' },
            o.icon ? icon(o.icon) : null,
            h('span', { class: 'ks-choice-text' }, h('span', { class: 'ks-choice-label' }, o.label), o.desc ? h('span', { class: 'ks-choice-desc' }, o.desc) : null),
            o.extra ?? null,
            key === 'device' ? h('span', { class: 'ks-opt-alert', 'data-for': o.value, hidden: true }, icon('warn'), h('span', { class: 'ks-sr-only' }, t('settings.controls.deviceConflict'))) : null,
          ),
        ),
      );
    }
    const root = h(
      'div',
      { class: `ks-field ks-field-choice ks-field-${key}` },
      h('div', { class: 'ks-field-text' }, h('span', { class: 'ks-field-label', id: `${gid}-label` }, label), hint ? h('p', { class: 'ks-field-hint', id: `${gid}-hint` }, hint) : null),
      group,
    );
    return {
      root,
      set: (v) => {
        for (const r of radios) r.checked = r.value === v;
      },
    };
  }
}

function listFormat(items: string[]): string {
  try {
    return new Intl.ListFormat(document.documentElement.lang || 'en', { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

function plural(key: string, n: number): string {
  const form = new Intl.PluralRules(document.documentElement.lang || 'en').select(n);
  return t(`${key}.${form === 'one' ? 'one' : 'other'}`, { count: n });
}
