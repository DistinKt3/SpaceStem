/**
 * "How do we know this?": a modal dialog listing, for one Codex entry, every value with its provenance tier,
 * uncertainty, method and citation, the entry's key claims, and a short explanation of the three tiers.
 *
 * Keyboard: focus is trapped inside; Esc closes and returns focus to whatever opened it. Gamepad: see nav.ts.
 */
import type { Provenance } from '../../core/provenance';
import { t } from '../i18n';
import { provenanceBadge } from '../ui/badge';
import '../ui/codex.css';
import type { CodexStore } from './codexStore';
import { citationView, focusables, h, icon, moveFocus, richText, showDialog, trapTab } from './dom';
import { formatFactValue, isTightUnit } from './format';
import { pushNavTarget, removeNavTarget, type CodexNavCommand, type CodexNavTarget } from './nav';
import type { CodexEntry, CodexFact } from './types';

export interface HowWeKnowOptions {
  /** Called by the "Read Codex entry" button (the button is hidden when not given). */
  onReadEntry?: (id: string) => void;
  parent?: HTMLElement;
}

let uid = 0;

/** "6,371.0084 ± 0.0001 km" with the uncertainty and unit styled separately. */
export function factValueView(f: CodexFact, cls = 'ks-cx-value'): HTMLElement {
  const p = formatFactValue(f);
  const unitSpace = p.unit && !isTightUnit(p.unit) ? ' ' : '';
  return h(
    'span',
    { class: cls },
    h('span', { class: 'v' }, p.value),
    p.uncertainty ? ' ' : null,
    p.asym
      ? h(
          'span',
          { class: 'unc asym' },
          h('span', { class: 'up' }, p.asym.plus),
          h('span', { class: 'dn' }, p.asym.minus),
        )
      : p.uncertainty
        ? h('span', { class: 'unc' }, p.uncertainty)
        : null,
    p.unit ? unitSpace : null,
    p.unit ? h('span', { class: 'unit' }, p.unit) : null,
  );
}

export class HowWeKnowPanel implements CodexNavTarget {
  readonly element: HTMLDialogElement;
  private readonly frame: HTMLDivElement;
  private readonly eyebrow: HTMLParagraphElement;
  private readonly title: HTMLHeadingElement;
  private readonly scroll: HTMLDivElement;
  private readonly readBtn: HTMLButtonElement;
  private current: CodexEntry | null = null;
  private returnFocus: HTMLElement | null = null;
  private openState = false;
  private escAt = -Infinity;
  private readonly closeCbs = new Set<() => void>();
  private readonly id = `ks-hwk-${++uid}`;
  /** Citations already shown in full in the current rendering. */
  private readonly cited = new Set<string>();

  constructor(
    private readonly store: CodexStore,
    private readonly opts: HowWeKnowOptions = {},
  ) {
    this.eyebrow = h('p', { class: 'ks-cx-eyebrow' });
    this.title = h('h2', { class: 'ks-hwk-title', id: `${this.id}-title`, tabindex: -1 }, t('codex.hwk.title'));
    const closeX = h(
      'button',
      { type: 'button', class: 'ks-cx-iconbtn', 'aria-label': t('codex.hwk.close'), title: t('codex.hwk.close') },
      icon('close'),
    );
    closeX.addEventListener('click', () => this.close());
    this.scroll = h('div', { class: 'ks-hwk-scroll' });
    this.readBtn = h('button', { type: 'button', class: 'ks-cx-btn ks-cx-btn--primary ks-hwk-read' });
    this.readBtn.addEventListener('click', () => {
      const e = this.current;
      if (!e || !this.store.discovered(e.id)) return;
      this.close(false);
      this.opts.onReadEntry?.(e.id);
    });
    const closeBtn = h('button', { type: 'button', class: 'ks-cx-btn' }, t('codex.hwk.close'));
    closeBtn.addEventListener('click', () => this.close());
    this.frame = h(
      'div',
      { class: 'ks-hwk-frame' },
      h('header', { class: 'ks-hwk-head' }, h('div', { class: 'ks-hwk-heading' }, this.eyebrow, this.title), closeX),
      this.scroll,
      h('footer', { class: 'ks-hwk-foot' }, this.opts.onReadEntry ? this.readBtn : null, closeBtn),
    );
    this.element = h(
      'dialog',
      {
        class: 'ks-hwk',
        'aria-labelledby': `${this.id}-title`,
        'aria-describedby': `${this.id}-intro`,
        'data-input': 'keyboard',
      },
      this.frame,
    );
    this.element.addEventListener('keydown', (e) => this.onKey(e));
    // Keys typed in the dialog belong to it, not to the game behind it.
    this.element.addEventListener('keyup', (e) => e.stopPropagation());
    this.element.addEventListener('cancel', (e) => {
      // Esc is handled on keydown; this covers other close requests (and ignores the one Esc may also raise).
      e.preventDefault();
      if (performance.now() - this.escAt > 100) this.close();
    });
    this.element.addEventListener('close', () => {
      if (!this.openState) return;
      this.openState = false;
      this.finishClose(true);
    });
    this.element.addEventListener('pointerdown', (e) => {
      this.element.dataset['input'] = 'pointer';
      if (e.target === this.element) this.close(); // A press on the backdrop.
    });
    (opts.parent ?? document.body).append(this.element);
  }

  get isOpen(): boolean {
    return this.openState;
  }

  get entry(): CodexEntry | null {
    return this.current;
  }

  /** Opens the dialog for an entry. Focus returns to `opener` (default: the focused element) on close. */
  show(entry: CodexEntry, opener?: HTMLElement | null): void {
    this.current = entry;
    this.render(entry);
    if (!this.openState) {
      const active = opener ?? document.activeElement;
      this.returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
      this.openState = true;
      showDialog(this.element);
      pushNavTarget(this);
      window.addEventListener('resize', this.onResize);
    }
    this.updateCompact();
    this.scroller.scrollTop = 0;
    this.title.focus({ preventScroll: true });
  }

  /** The element that scrolls: the middle section, or the whole frame in compact mode. */
  private get scroller(): HTMLElement {
    return this.element.dataset['compact'] === 'true' ? this.frame : this.scroll;
  }

  /**
   * Compact mode for short windows or very large text (under 34 rem of height): the whole dialog scrolls and only the
   * footer stays, instead of a fixed header and footer squeezing the content.
   */
  private updateCompact(): void {
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    this.element.dataset['compact'] = String(window.innerHeight / rootPx < 34);
  }

  /** Opens the dialog for an entry id; false when the id is unknown. */
  showById(id: string, opener?: HTMLElement | null): boolean {
    const e = this.store.entry(id);
    if (!e) return false;
    this.show(e, opener);
    return true;
  }

  /** Opens the dialog for a world object by NAIF body id; false when it has no Codex entry. */
  showForBody(bodyId: string, opener?: HTMLElement | null): boolean {
    const e = this.store.byBodyId(bodyId);
    if (!e) return false;
    this.show(e, opener);
    return true;
  }

  close(restoreFocus = true): void {
    if (!this.openState) return;
    this.openState = false;
    // Close first: elements behind a modal dialog are inert and cannot take focus back.
    if (this.element.open) this.element.close();
    this.finishClose(restoreFocus);
  }

  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  dispose(): void {
    this.close(false);
    this.element.remove();
  }

  nav(cmd: CodexNavCommand): void {
    this.element.dataset['input'] = 'pad';
    switch (cmd) {
      case 'up':
      case 'left':
        if (!moveFocus(this.frame, -1)) this.scroller.scrollBy({ top: -96 });
        break;
      case 'down':
      case 'right':
        if (!moveFocus(this.frame, 1)) this.scroller.scrollBy({ top: 96 });
        break;
      case 'accept': {
        const a = document.activeElement;
        if (
          a instanceof HTMLElement &&
          this.element.contains(a) &&
          (a instanceof HTMLButtonElement || a instanceof HTMLAnchorElement)
        )
          a.click();
        else focusables(this.frame)[0]?.focus();
        break;
      }
      case 'back':
      case 'menu':
        this.close();
        break;
      case 'tabPrev':
      case 'tabNext':
        break;
    }
  }

  private readonly onResize = (): void => this.updateCompact();

  private finishClose(restoreFocus: boolean): void {
    removeNavTarget(this);
    window.removeEventListener('resize', this.onResize);
    const rf = this.returnFocus;
    this.returnFocus = null;
    if (restoreFocus && rf?.isConnected) rf.focus({ preventScroll: true });
    for (const cb of [...this.closeCbs]) cb();
  }

  private onKey(e: KeyboardEvent): void {
    this.element.dataset['input'] = 'keyboard';
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.escAt = performance.now();
      this.close();
      return;
    }
    trapTab(e, this.frame);
  }

  private render(e: CodexEntry): void {
    this.eyebrow.textContent = t('codex.hwk.eyebrow', { title: e.title });
    const discovered = this.store.discovered(e.id);
    this.readBtn.replaceChildren(
      discovered ? t('codex.hwk.read') : t('codex.hwk.readLocked'),
      discovered ? icon('forward') : icon('lock'),
    );
    this.readBtn.disabled = !discovered;

    this.cited.clear();
    const parts: HTMLElement[] = [h('p', { class: 'ks-hwk-intro', id: `${this.id}-intro` }, t('codex.hwk.intro'))];

    if (e.facts.length > 0) {
      const list = h('ul', { class: 'ks-hwk-list', role: 'list' });
      for (const f of e.facts) {
        list.append(
          this.item(
            f.provenance,
            h(
              'div',
              { class: 'ks-hwk-fact-top' },
              h('span', { class: 'ks-hwk-label' }, f.label),
              factValueView(f, 'ks-cx-value ks-hwk-value'),
            ),
            f.method,
            f.citation,
          ),
        );
      }
      parts.push(
        h(
          'section',
          { class: 'ks-hwk-section', 'aria-labelledby': `${this.id}-values` },
          h('h3', { class: 'ks-cx-h3', id: `${this.id}-values` }, t('codex.hwk.values')),
          list,
        ),
      );
    }

    if (e.howWeKnow.length > 0) {
      const list = h('ul', { class: 'ks-hwk-list', role: 'list' });
      for (const c of e.howWeKnow)
        list.append(
          this.item(c.provenance, h('p', { class: 'ks-hwk-claim' }, richText(c.claim)), c.method, c.citation),
        );
      parts.push(
        h(
          'section',
          { class: 'ks-hwk-section', 'aria-labelledby': `${this.id}-claims` },
          h('h3', { class: 'ks-cx-h3', id: `${this.id}-claims` }, t('codex.hwk.claims')),
          list,
        ),
      );
    }

    if (e.facts.length === 0 && e.howWeKnow.length === 0)
      parts.push(h('p', { class: 'ks-cx-empty' }, t('codex.hwk.none')));

    const tiers = h('ul', { class: 'ks-hwk-tiers', role: 'list' });
    for (const p of ['measured', 'inferred', 'generated'] as const) {
      tiers.append(
        h(
          'li',
          { class: `ks-hwk-tier ks-hwk-tier--${p}` },
          provenanceBadge(p),
          h('p', {}, t(`codex.tier.${p}.explain`)),
        ),
      );
    }
    parts.push(
      h(
        'section',
        { class: 'ks-hwk-section', 'aria-labelledby': `${this.id}-tiers` },
        h('h3', { class: 'ks-cx-h3', id: `${this.id}-tiers` }, t('codex.hwk.tiers')),
        tiers,
      ),
    );

    this.scroll.replaceChildren(...parts);
  }

  private item(p: Provenance, top: HTMLElement, method: string, citation: string): HTMLLIElement {
    const meta = h('dl', { class: 'ks-hwk-meta' });
    if (method) meta.append(h('dt', {}, t('codex.hwk.method')), h('dd', {}, method));
    const repeat = citation !== '' && this.cited.has(citation);
    this.cited.add(citation);
    meta.append(
      h('dt', {}, t('codex.hwk.source')),
      h(
        'dd',
        {},
        citationView(citation, citation ? this.store.citation(citation) : undefined, {
          accessed: 'always',
          short: repeat,
        }),
      ),
    );
    return h(
      'li',
      { class: `ks-hwk-item ks-hwk-item--${p}` },
      h('div', { class: 'ks-hwk-top' }, provenanceBadge(p), top),
      meta,
    );
  }
}
