/**
 * The Codex: a full-screen glass overlay with category tabs (Bodies, Stars, Exoplanets, Concepts, Discovery log),
 * search over discovered entries, a list of entries (locked ones shown as "Not yet discovered" with a hint), and an
 * entry view with summary, text, a facts table with provenance badges, related entries and numbered sources.
 *
 * Accessibility: a modal <dialog> labelled "Codex"; categories are an ARIA tablist (arrow keys, automatic
 * activation); entries are a single-select listbox using aria-activedescendant (arrows, Home/End, PageUp/PageDown,
 * Enter opens; selection follows focus). Tab is trapped in the dialog, Esc goes back (narrow layout) or closes, and
 * focus returns to whatever opened the Codex. "/" jumps to search. Gamepad: see nav.ts.
 */
import type { Provenance } from '../../core/provenance';
import { hasKey, t } from '../i18n';
import { provenanceBadge } from '../ui/badge';
import '../ui/codex.css';
import type { CodexStore } from './codexStore';
import { citationView, h, icon, moveFocus, prefersReducedMotion, richText, showDialog, srOnly, trapTab } from './dom';
import { entrySystem, kindLabel, lockedHint, relativeTime, tCount } from './format';
import { factValueView, type HowWeKnowPanel } from './howWeKnow';
import { pushNavTarget, removeNavTarget, type CodexNavCommand, type CodexNavTarget } from './nav';
import { CODEX_KINDS, PROVENANCES, type CodexEntry, type CodexKind } from './types';

export type CodexTab = CodexKind | 'log';
export const CODEX_TABS: readonly CodexTab[] = [...CODEX_KINDS, 'log'];

export interface CodexPanelOptions {
  /** Enables the "How do we know this?" button in entries. */
  howWeKnow?: HowWeKnowPanel;
  parent?: HTMLElement;
  /** KeyboardEvent.code values that also close the Codex (e.g. the key that opens it); ignored while typing. */
  closeKeys?: readonly string[];
  /** Clock for relative times (ms). */
  now?: () => number;
}

interface Item {
  readonly id: string;
  readonly el: HTMLElement;
  readonly locked: boolean;
}

let uid = 0;

export class CodexPanel implements CodexNavTarget {
  readonly element: HTMLDialogElement;
  private readonly frame: HTMLDivElement;
  private readonly tablist: HTMLDivElement;
  private readonly tabs = new Map<CodexTab, HTMLButtonElement>();
  private readonly progressText: HTMLSpanElement;
  private readonly progressFill: HTMLSpanElement;
  private readonly search: HTMLInputElement;
  private readonly listbox: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly listEmpty: HTMLParagraphElement;
  private readonly status: HTMLParagraphElement;
  private readonly main: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly article: HTMLElement;
  private readonly id = `ks-cx-${++uid}`;
  private readonly now: () => number;
  private readonly closeCbs = new Set<() => void>();

  private tab: CodexTab = 'body';
  private items: Item[] = [];
  private activeId: string | null = null;
  private selectedId: string | null = null;
  private renderedFor = '';
  private query = '';
  private openState = false;
  private returnFocus: HTMLElement | null = null;
  private timer = 0;
  private escAt = -Infinity;
  /** When the Codex was last closed (ms), to open on anything discovered since. */
  private closedAt = -Infinity;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: CodexStore,
    private readonly opts: CodexPanelOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    const id = (s: string): string => `${this.id}-${s}`;

    // Header: brand, category tabs, progress, close.
    const brand = h(
      'div',
      { class: 'ks-cx-brand' },
      icon('codex', 'ks-cx-icon ks-cx-brand-icon'),
      h(
        'div',
        {},
        h('h2', { class: 'ks-cx-title', id: id('title') }, t('codex.title')),
        h('p', { class: 'ks-cx-sub' }, t('codex.subtitle')),
      ),
    );
    this.tablist = h('div', { class: 'ks-cx-tabs', role: 'tablist', 'aria-label': t('codex.categories') });
    for (const tab of CODEX_TABS) {
      const b = h('button', {
        type: 'button',
        class: 'ks-cx-tab',
        role: 'tab',
        id: id(`tab-${tab}`),
        'aria-controls': id('panel'),
        'aria-selected': 'false',
        tabindex: -1,
        'data-tab': tab,
      });
      b.addEventListener('click', () => this.setTab(tab, { focus: 'tab' }));
      this.tabs.set(tab, b);
      this.tablist.append(b);
    }
    this.tablist.addEventListener('keydown', (e) => this.onTabKey(e));
    this.progressText = h('span', { class: 'ks-cx-progress-text' });
    this.progressFill = h('span', { class: 'ks-cx-progress-fill' });
    const progress = h(
      'div',
      { class: 'ks-cx-progress' },
      this.progressText,
      h('span', { class: 'ks-cx-progress-bar', 'aria-hidden': 'true' }, this.progressFill),
    );
    const closeBtn = h(
      'button',
      { type: 'button', class: 'ks-cx-iconbtn ks-cx-close', 'aria-label': t('codex.close'), title: t('codex.close') },
      icon('close'),
      h('kbd', { class: 'ks-cx-kbd', 'aria-hidden': 'true' }, t('codex.key.esc')),
    );
    closeBtn.addEventListener('click', () => this.close());
    const head = h('header', { class: 'ks-cx-head' }, brand, this.tablist, progress, closeBtn);

    // Sidebar: search, entry list, tier legend.
    this.search = h('input', {
      type: 'search',
      class: 'ks-cx-search-input',
      id: id('search'),
      placeholder: t('codex.search.placeholder'),
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-controls': id('list'),
    });
    this.search.addEventListener('input', () => this.setQuery(this.search.value));
    this.search.addEventListener('keydown', (e) => this.onSearchKey(e));
    const searchBox = h(
      'div',
      { class: 'ks-cx-search' },
      h('label', { class: 'ks-cx-sr', for: id('search') }, t('codex.search.label')),
      icon('search'),
      this.search,
      h('kbd', { class: 'ks-cx-kbd', 'aria-hidden': 'true' }, t('codex.key.search')),
    );
    this.listbox = h('div', { class: 'ks-cx-list', role: 'listbox', id: id('list'), tabindex: 0 });
    this.listbox.addEventListener('keydown', (e) => this.onListKey(e));
    this.listbox.addEventListener('focus', () => {
      // Selection follows focus: arriving in the list shows its active entry.
      const it = this.activeItem();
      if (it && it.id !== this.selectedId) this.select(it.id);
    });
    this.listEmpty = h('p', { class: 'ks-cx-empty ks-cx-list-empty', hidden: true });
    // The list area is the tab panel of the selected category.
    this.panel = h('div', { class: 'ks-cx-listwrap', role: 'tabpanel', id: id('panel') }, this.listbox, this.listEmpty);
    this.status = h('p', { class: 'ks-cx-sr', role: 'status', 'aria-live': 'polite' });
    const legend = h(
      'div',
      { class: 'ks-cx-legend' },
      h('p', { class: 'ks-cx-eyebrow' }, t('codex.legend.title')),
      h('div', { class: 'ks-cx-legend-badges' }, ...PROVENANCES.map((p) => provenanceBadge(p))),
    );
    const side = h('div', { class: 'ks-cx-side' }, searchBox, this.panel, legend, this.status);

    // Main: entry view.
    this.backBtn = h('button', { type: 'button', class: 'ks-cx-back' }, icon('back'), t('codex.entry.back'));
    this.backBtn.addEventListener('click', () => this.showList());
    this.article = h('article', { class: 'ks-cx-entry', 'aria-labelledby': id('entry-title') });
    this.main = h('div', { class: 'ks-cx-main', tabindex: -1 }, this.backBtn, this.article);

    this.frame = h('div', { class: 'ks-cx-frame' }, head, h('div', { class: 'ks-cx-body' }, side, this.main));
    this.element = h(
      'dialog',
      { class: 'ks-cx', 'aria-labelledby': id('title'), 'data-input': 'keyboard', 'data-view': 'list' },
      this.frame,
    );
    this.element.addEventListener('keydown', (e) => this.onKey(e));
    this.element.addEventListener('keyup', (e) => e.stopPropagation());
    this.element.addEventListener('cancel', (e) => {
      // Esc is handled on keydown; this covers other close requests (and ignores the one Esc may also raise).
      e.preventDefault();
      if (performance.now() - this.escAt > 100) this.back();
    });
    this.element.addEventListener('close', () => {
      if (!this.openState) return;
      this.openState = false;
      this.finishClose();
    });
    this.element.addEventListener('pointerdown', (e) => {
      this.element.dataset['input'] = 'pointer';
      if (e.target === this.element) this.close();
    });
    (opts.parent ?? document.body).append(this.element);

    this.unsubscribe = this.store.onChange(() => {
      if (!this.openState) return;
      // Content that arrives while the Codex is open (slow load) gets a selection like a fresh open.
      const first = this.selectedId ? undefined : this.defaultEntry();
      if (first) this.goTo(first);
      else this.refresh();
    });
  }

  get isOpen(): boolean {
    return this.openState;
  }

  get currentTab(): CodexTab {
    return this.tab;
  }

  /** The entry shown in the entry view. */
  get selected(): string | null {
    return this.selectedId;
  }

  /** Opens the Codex, at an entry when an id is given. */
  open(entryId?: string): void {
    if (!this.openState) {
      const active = document.activeElement;
      this.returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
      this.openState = true;
      showDialog(this.element);
      pushNavTarget(this);
      this.timer = window.setInterval(() => this.refresh(), 30_000);
    }
    if (entryId && this.store.entry(entryId)) {
      this.showEntry(entryId);
      return;
    }
    // Open on anything discovered since the Codex was last closed, else where the player left it, else the start.
    const fresh = this.newestUnseen();
    const target =
      fresh && fresh.at > this.closedAt
        ? fresh.id
        : this.selectedId && this.store.entry(this.selectedId)
          ? null
          : this.defaultEntry();
    this.element.dataset['view'] = 'list';
    if (target) this.goTo(target);
    else {
      this.refresh();
      const it = this.activeItem();
      if (it) this.select(it.id);
    }
    this.listbox.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.opts.howWeKnow?.close(false);
    if (this.element.open) this.element.close();
    this.finishClose();
  }

  toggle(entryId?: string): void {
    if (this.openState) this.close();
    else this.open(entryId);
  }

  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  dispose(): void {
    this.close();
    this.unsubscribe();
    this.element.remove();
  }

  /** Shows an entry: switches to its category, selects it and moves focus to its title. */
  showEntry(entryId: string): void {
    const e = this.store.entry(entryId);
    if (!e) return;
    if (this.query) this.clearQuery();
    if (this.tab !== 'log' || !this.store.log().some((r) => r.id === entryId)) this.tab = e.kind;
    this.activeId = entryId;
    this.refresh();
    this.select(entryId);
    this.element.dataset['view'] = 'entry';
    this.main.scrollTop = 0;
    this.focusEntry();
  }

  /** Switches category. */
  setTab(tab: CodexTab, opts: { focus?: 'tab' | 'list' | 'none' } = {}): void {
    if (this.query) this.clearQuery();
    this.tab = tab;
    this.activeId = null;
    this.refresh();
    if (opts.focus === 'tab') this.tabs.get(tab)?.focus();
    else if (opts.focus === 'list') this.focusList();
  }

  // --- Gamepad --------------------------------------------------------------------------------------------------------

  nav(cmd: CodexNavCommand): void {
    this.element.dataset['input'] = 'pad';
    const a = document.activeElement;
    const zone =
      a === this.listbox
        ? 'list'
        : a instanceof Node && this.tablist.contains(a)
          ? 'tabs'
          : a === this.search
            ? 'search'
            : a instanceof Node && this.main.contains(a)
              ? 'main'
              : 'other';
    const tabIndex = CODEX_TABS.indexOf(this.tab);
    switch (cmd) {
      case 'up':
      case 'down': {
        const d = cmd === 'down' ? 1 : -1;
        if (zone === 'list') {
          const i = this.activeIndex();
          if (d < 0 && i <= 0) this.search.focus();
          else this.setActive(i + d);
        } else if (zone === 'main') {
          if (!moveFocus(this.main, d)) this.main.scrollBy({ top: d * 120 });
        } else if (zone === 'search' && d > 0) this.focusList();
        else if (zone === 'tabs' && d > 0) this.search.focus();
        else if (zone === 'other') this.focusList();
        break;
      }
      case 'left':
      case 'right': {
        const d = cmd === 'right' ? 1 : -1;
        if (zone === 'tabs')
          this.setTab(CODEX_TABS[(tabIndex + d + CODEX_TABS.length) % CODEX_TABS.length]!, { focus: 'tab' });
        else if (zone === 'list' && d > 0) this.openActive();
        else if (zone === 'main' && d < 0) this.showList();
        else if (zone === 'main') moveFocus(this.main, 1);
        break;
      }
      case 'accept':
        if (zone === 'list') this.openActive();
        else if (zone === 'tabs') this.focusList();
        else if (a instanceof HTMLButtonElement || a instanceof HTMLAnchorElement) a.click();
        else this.focusList();
        break;
      case 'back':
        if (zone === 'main' || (this.narrow() && this.element.dataset['view'] === 'entry')) this.showList();
        else if (zone === 'search' && this.query) this.clearQuery();
        else this.close();
        break;
      case 'tabPrev':
      case 'tabNext': {
        const d = cmd === 'tabNext' ? 1 : -1;
        this.setTab(CODEX_TABS[(tabIndex + d + CODEX_TABS.length) % CODEX_TABS.length]!, { focus: 'list' });
        break;
      }
      case 'menu':
        this.close();
        break;
    }
  }

  // --- Internals ------------------------------------------------------------------------------------------------------

  private finishClose(): void {
    removeNavTarget(this);
    window.clearInterval(this.timer);
    this.closedAt = this.now();
    const rf = this.returnFocus;
    this.returnFocus = null;
    if (rf?.isConnected) rf.focus({ preventScroll: true });
    for (const cb of [...this.closeCbs]) cb();
  }

  private newestUnseen(): { id: string; at: number } | undefined {
    return [...this.store.log()].reverse().find((r) => this.store.isNew(r.id));
  }

  /** The newest unseen discovery, else the first known entry, else the first entry. */
  private defaultEntry(): string | undefined {
    return (
      this.newestUnseen()?.id ??
      this.store.entries().find((e) => this.store.discovered(e.id))?.id ??
      this.store.entries()[0]?.id
    );
  }

  /** Selects an entry in its own category without moving focus. */
  private goTo(id: string): void {
    const e = this.store.entry(id);
    if (!e) return;
    if (this.query) this.clearQuery();
    this.tab = e.kind;
    this.activeId = id;
    this.refresh();
    this.select(id);
  }

  /** True in the single-pane layout (set by a container query in codex.css). */
  private narrow(): boolean {
    return (
      getComputedStyle(this.frame.lastElementChild ?? this.frame)
        .getPropertyValue('--ks-cx-narrow')
        .trim() === '1'
    );
  }

  /** Esc / B: back to the list in the narrow layout, else close. */
  private back(): void {
    if (this.element.dataset['view'] === 'entry' && this.narrow()) this.showList();
    else this.close();
  }

  private showList(): void {
    this.element.dataset['view'] = 'list';
    this.focusList();
  }

  /** Focuses the list; its active entry becomes the selected one (selection follows focus). */
  private focusList(): void {
    this.listbox.focus({ preventScroll: true });
    const it = this.activeItem();
    if (it && it.id !== this.selectedId) this.select(it.id);
    this.activeItem()?.el.scrollIntoView({ block: 'nearest' });
  }

  private focusEntry(): void {
    const title = this.article.querySelector<HTMLElement>('.ks-cx-entry-title');
    (title ?? this.main).focus({ preventScroll: true });
  }

  private activeIndex(): number {
    return this.items.findIndex((it) => it.id === this.activeId);
  }

  private activeItem(): Item | undefined {
    return this.items[Math.max(0, this.activeIndex())];
  }

  private setActive(i: number, select = true): void {
    if (this.items.length === 0) return;
    const idx = Math.min(this.items.length - 1, Math.max(0, i));
    const it = this.items[idx]!;
    this.activeId = it.id;
    this.markActive();
    it.el.scrollIntoView({ block: 'nearest' });
    if (select) this.select(it.id);
  }

  private markActive(): void {
    const i = Math.max(0, this.activeIndex());
    this.items.forEach((it, j) => it.el.classList.toggle('is-active', j === i));
    const it = this.items[i];
    if (it) this.listbox.setAttribute('aria-activedescendant', it.el.id);
    else this.listbox.removeAttribute('aria-activedescendant');
  }

  private select(id: string): void {
    this.selectedId = id;
    for (const it of this.items) it.el.setAttribute('aria-selected', String(it.id === id));
    this.renderEntry();
    // Opening an entry clears its "new" marker (this triggers a refresh of the list).
    this.store.markSeen(id);
  }

  private openActive(): void {
    const it = this.activeItem();
    if (!it) return;
    if (it.id !== this.selectedId) this.select(it.id);
    this.element.dataset['view'] = 'entry';
    this.main.scrollTop = 0;
    this.focusEntry();
  }

  private setQuery(q: string): void {
    this.query = q;
    this.activeId = null;
    this.refresh();
    const n = this.items.length;
    this.status.textContent = q.trim()
      ? n > 0
        ? tCount('codex.search.results', n)
        : t('codex.search.none', { q: q.trim() })
      : '';
  }

  private clearQuery(): void {
    this.search.value = '';
    this.query = '';
    this.status.textContent = '';
  }

  private onKey(e: KeyboardEvent): void {
    this.element.dataset['input'] = 'keyboard';
    e.stopPropagation(); // Keys typed in the Codex belong to it, not to the game behind it.
    const target = e.target as HTMLElement | null;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.escAt = performance.now();
      if (target === this.search && this.search.value) {
        this.clearQuery();
        this.setQuery('');
      } else this.back();
      return;
    }
    if (trapTab(e, this.frame)) return;
    if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === '/') {
      e.preventDefault();
      this.search.focus();
      this.search.select();
    } else if (this.opts.closeKeys?.includes(e.code)) {
      e.preventDefault();
      this.close();
    }
  }

  private onTabKey(e: KeyboardEvent): void {
    const i = CODEX_TABS.indexOf(this.tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % CODEX_TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + CODEX_TABS.length) % CODEX_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = CODEX_TABS.length - 1;
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.focusList();
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    this.setTab(CODEX_TABS[next]!, { focus: 'tab' });
  }

  private onSearchKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.focusList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.items.length > 0) {
        this.setActive(0, false);
        this.openActive();
      }
    }
  }

  private onListKey(e: KeyboardEvent): void {
    const i = this.activeIndex();
    const page = Math.max(
      1,
      Math.floor(this.listbox.clientHeight / Math.max(1, this.items[0]?.el.offsetHeight ?? 40)) - 1,
    );
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = i + 1;
        break;
      case 'ArrowUp':
        next = i - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = this.items.length - 1;
        break;
      case 'PageDown':
        next = i + page;
        break;
      case 'PageUp':
        next = i - page;
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.openActive();
        return;
      default:
        return;
    }
    e.preventDefault();
    this.setActive(next);
  }

  /** Rebuilds tabs, progress and the list from the store; re-renders the entry only if what it shows changed. */
  private refresh(): void {
    this.renderTabs();
    const p = this.store.progress();
    this.progressText.textContent = t('codex.progress', { n: String(p.discovered), total: String(p.total) });
    this.progressFill.style.width = `${p.total > 0 ? (100 * p.discovered) / p.total : 0}%`;
    this.renderList();
    const key = this.entryKey();
    if (key !== this.renderedFor) this.renderEntry();
    else this.updateTimes();
  }

  private renderTabs(): void {
    const searching = this.query.trim() !== '';
    this.tablist.classList.toggle('is-searching', searching);
    for (const [tab, b] of this.tabs) {
      const on = tab === this.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-active', on);
      // The visible parts are decoration for a single translated accessible name.
      const label = t(`codex.cat.${tab}`);
      const children: Node[] = [icon(tab === 'log' ? 'log' : tab), h('span', { class: 'ks-cx-tab-label' }, label)];
      const hasNew = this.store.newCount(tab === 'log' ? undefined : tab) > 0;
      let name: string;
      if (tab === 'log') {
        const n = this.store.log().length;
        if (n > 0) children.push(h('span', { class: 'ks-cx-tab-count' }, String(n)));
        name = t(hasNew ? 'codex.tab.logAriaNew' : 'codex.tab.logAria', { category: label });
      } else {
        const pr = this.store.progress(tab);
        const p = { category: label, n: String(pr.discovered), total: String(pr.total) };
        children.push(h('span', { class: 'ks-cx-tab-count' }, t('codex.tab.count', p)));
        name = t(hasNew ? 'codex.tab.ariaNew' : 'codex.tab.aria', p);
      }
      if (hasNew) children.push(h('span', { class: 'ks-cx-dot' }));
      b.setAttribute('aria-label', name);
      if (on) this.panel.setAttribute('aria-labelledby', b.id);
      b.title = label;
      b.replaceChildren(...children);
    }
  }

  private listEntries(): { entry: CodexEntry; at: number | null }[] {
    if (this.query.trim()) return this.store.search(this.query).map((entry) => ({ entry, at: null }));
    if (this.tab === 'log') {
      return [...this.store.log()]
        .reverse()
        .map((r) => ({ entry: this.store.entry(r.id), at: r.at }))
        .filter((x): x is { entry: CodexEntry; at: number } => x.entry !== undefined);
    }
    const tab = this.tab;
    return this.store.byKind(tab).map((entry) => ({ entry, at: null }));
  }

  private renderList(): void {
    const rows = this.listEntries();
    const searching = this.query.trim() !== '';
    const all = this.store.entries();
    const now = this.now();
    this.items = rows.map(({ entry: e, at }, i) => {
      const locked = !this.store.discovered(e.id);
      const isNew = !locked && this.store.isNew(e.id);
      const el = h('div', {
        class: 'ks-cx-opt',
        role: 'option',
        id: `${this.id}-opt-${i}`,
        'aria-selected': String(e.id === this.selectedId),
        'data-entry': e.id,
      });
      if (locked) {
        const hint = lockedHint(e, all);
        el.classList.add('is-locked');
        el.setAttribute('aria-label', t('codex.locked.optionLabel', { hint }));
        el.append(
          h('span', { class: 'ks-cx-opt-icon' }, icon('lock')),
          h(
            'span',
            { class: 'ks-cx-opt-text' },
            h('span', { class: 'ks-cx-opt-title' }, t('codex.locked.title')),
            h('span', { class: 'ks-cx-opt-sub' }, hint),
          ),
        );
      } else {
        let sub: HTMLElement;
        if (at !== null) {
          const p = { title: e.title, kind: kindLabel(e.kind), when: relativeTime(at, now) };
          sub = h('span', { class: 'ks-cx-opt-sub' }, t('codex.log.sub', p));
          el.setAttribute('aria-label', t(isNew ? 'codex.log.optionLabelNew' : 'codex.log.optionLabel', p));
        } else {
          const text = searching ? t('codex.search.sub', { kind: kindLabel(e.kind), summary: e.summary }) : e.summary;
          sub = h('span', { class: 'ks-cx-opt-sub' }, text);
          el.setAttribute('aria-label', isNew ? t('codex.newLabel', { title: e.title }) : e.title);
        }
        el.append(
          h('span', { class: 'ks-cx-opt-icon' }, icon(e.kind)),
          h('span', { class: 'ks-cx-opt-text' }, h('span', { class: 'ks-cx-opt-title' }, e.title), sub),
        );
        if (isNew) {
          el.classList.add('is-new');
          el.append(h('span', { class: 'ks-cx-new', 'aria-hidden': 'true' }, t('codex.new')));
        }
      }
      el.addEventListener('click', () => {
        this.activeId = e.id;
        this.markActive();
        this.listbox.focus({ preventScroll: true });
        this.openActiveFromPointer();
      });
      return { id: e.id, el, locked };
    });
    this.listbox.replaceChildren(...this.items.map((it) => it.el));
    if (searching) this.listbox.setAttribute('aria-label', t('codex.search.listLabel', { q: this.query.trim() }));
    else if (this.tab === 'log') this.listbox.setAttribute('aria-label', t('codex.log.label'));
    else this.listbox.setAttribute('aria-label', t('codex.list.label', { category: t(`codex.cat.${this.tab}`) }));
    if (this.items.length > 0 && !this.items.some((it) => it.id === this.activeId)) {
      this.activeId = this.items.find((it) => it.id === this.selectedId)?.id ?? this.items[0]!.id;
    }
    this.markActive();

    let empty = '';
    if (this.items.length === 0) {
      if (!this.store.loaded) empty = t('codex.loading');
      else if (this.store.error && this.store.entries().length === 0) empty = t('codex.errorShort');
      else if (searching) empty = t('codex.search.none', { q: this.query.trim() });
      else if (this.tab === 'log') empty = t('codex.log.empty');
      else empty = t('codex.list.empty');
    }
    this.listEmpty.textContent = empty;
    this.listEmpty.hidden = empty === '';
  }

  /** A click selects and, in the narrow layout, opens the entry pane (focus stays in the list in the wide one). */
  private openActiveFromPointer(): void {
    const it = this.activeItem();
    if (!it) return;
    if (it.id !== this.selectedId) this.select(it.id);
    if (this.narrow()) {
      this.element.dataset['view'] = 'entry';
      this.main.scrollTop = 0;
      this.focusEntry();
    }
  }

  private entryKey(): string {
    const id = this.selectedId;
    return id ? `${id}|${this.store.discovered(id)}|${this.store.loaded}` : `none|${this.store.loaded}`;
  }

  private updateTimes(): void {
    const now = this.now();
    for (const el of this.element.querySelectorAll<HTMLElement>('[data-ks-at]')) {
      el.textContent = relativeTime(Number(el.dataset['ksAt']), now);
    }
    const when = this.article.querySelector<HTMLElement>('[data-ks-discovered]');
    if (when)
      when.textContent = t('codex.entry.discovered', { when: relativeTime(Number(when.dataset['ksDiscovered']), now) });
  }

  private renderEntry(): void {
    this.renderedFor = this.entryKey();
    const titleId = `${this.id}-entry-title`;
    const e = this.selectedId ? this.store.entry(this.selectedId) : undefined;
    this.article.classList.remove('is-locked');
    if (!e) {
      if (this.store.error && this.store.entries().length === 0) {
        this.article.classList.add('is-locked');
        this.article.replaceChildren(
          h(
            'div',
            { class: 'ks-cx-lockcard ks-cx-errorcard', role: 'alert' },
            h('span', { class: 'ks-cx-lockcard-icon' }, icon('warn')),
            h('h2', { class: 'ks-cx-entry-title', id: titleId, tabindex: -1 }, t('codex.errorTitle')),
            h('p', { class: 'ks-cx-lockcard-note' }, t('codex.error')),
          ),
        );
      } else
        this.article.replaceChildren(
          h('p', { class: 'ks-cx-empty' }, this.store.loaded ? t('codex.list.empty') : t('codex.loading')),
        );
      return;
    }
    if (!this.store.discovered(e.id)) {
      this.article.classList.add('is-locked');
      this.article.replaceChildren(
        h(
          'div',
          { class: 'ks-cx-lockcard' },
          h('span', { class: 'ks-cx-lockcard-icon' }, icon('lock')),
          h('p', { class: 'ks-cx-eyebrow' }, kindLabel(e.kind)),
          h('h2', { class: 'ks-cx-entry-title', id: titleId, tabindex: -1 }, t('codex.locked.title')),
          h('p', { class: 'ks-cx-lead' }, lockedHint(e, this.store.entries())),
          h('p', { class: 'ks-cx-lockcard-note' }, t('codex.locked.body')),
        ),
      );
      return;
    }

    const where = systemLabel(e, this.store.entries());
    const eyebrow = h(
      'p',
      { class: 'ks-cx-eyebrow ks-cx-entry-eyebrow' },
      icon(e.kind),
      where ? t('codex.entry.eyebrow', { kind: kindLabel(e.kind), where }) : kindLabel(e.kind),
    );
    const title = h('h2', { class: 'ks-cx-entry-title', id: titleId, tabindex: -1 }, e.title);

    // Tally of value tiers, shape-coded like the badges.
    const counts = new Map<Provenance, number>();
    for (const f of e.facts) counts.set(f.provenance, (counts.get(f.provenance) ?? 0) + 1);
    const tally = h('ul', { class: 'ks-cx-tally', 'aria-label': t('codex.entry.tally'), role: 'list' });
    for (const p of PROVENANCES) {
      const n = counts.get(p);
      if (!n) continue;
      const badge = provenanceBadge(p, { compact: true });
      badge.setAttribute('aria-hidden', 'true');
      tally.append(
        h(
          'li',
          { class: `ks-cx-tally-item ks-cx-tally--${p}` },
          badge,
          h('span', { 'aria-hidden': 'true' }, String(n)),
          srOnly(tCount(`codex.tierCount.${p}`, n)),
        ),
      );
    }
    const at = this.store.discoveredAt(e.id);
    const when =
      at !== null
        ? h(
            'span',
            { class: 'ks-cx-when', 'data-ks-discovered': at },
            t('codex.entry.discovered', { when: relativeTime(at, this.now()) }),
          )
        : h('span', { class: 'ks-cx-when' }, t('codex.entry.knownFromStart'));
    const meta = h('div', { class: 'ks-cx-entry-meta' }, counts.size > 0 ? tally : null, when);
    const hwk = this.opts.howWeKnow;
    const actions = h('div', { class: 'ks-cx-entry-actions' });
    if (hwk && (e.facts.length > 0 || e.howWeKnow.length > 0)) {
      const b = h(
        'button',
        { type: 'button', class: 'ks-cx-btn ks-cx-btn--primary ks-cx-hwk-btn' },
        icon('question'),
        t('codex.entry.howWeKnow'),
      );
      b.addEventListener('click', () => hwk.show(e, b));
      actions.append(b);
    }

    // Numbered sources, in order of first use.
    const refs = new Map<string, number>();
    for (const k of [...e.facts.map((f) => f.citation), ...e.howWeKnow.map((c) => c.citation)])
      if (k && !refs.has(k)) refs.set(k, refs.size + 1);
    const srcId = (n: number): string => `${this.id}-src-${n}`;
    const refLink = (key: string): HTMLElement => {
      const n = refs.get(key);
      if (!n) return h('span', { class: 'ks-cx-dim' }, '—');
      const a = h(
        'a',
        { class: 'ks-cx-ref', href: `#${srcId(n)}`, 'aria-label': t('codex.entry.sourceRef', { n: String(n) }) },
        `[${n}]`,
      );
      a.addEventListener('click', (ev) => {
        // Scroll within the dialog without touching the page URL (the hash is used for share links).
        ev.preventDefault();
        const target = this.article.querySelector<HTMLElement>(`#${CSS.escape(srcId(n))}`);
        target?.scrollIntoView({ block: 'center' });
        target?.focus({ preventScroll: true });
      });
      return a;
    };

    const parts: (HTMLElement | null)[] = [
      h('header', { class: 'ks-cx-entry-head' }, eyebrow, title, meta, actions.childElementCount > 0 ? actions : null),
      e.summary ? h('p', { class: 'ks-cx-lead' }, richText(e.summary)) : null,
      e.body.length > 0 ? h('div', { class: 'ks-cx-prose' }, ...e.body.map((p) => h('p', {}, richText(p)))) : null,
    ];

    if (e.facts.length > 0) {
      const tbody = h('tbody', {});
      for (const f of e.facts) {
        const badge = provenanceBadge(f.provenance, { compact: true });
        tbody.append(
          h(
            'tr',
            { class: `ks-cx-fact ks-cx-fact--${f.provenance}` },
            h('td', { class: 'ks-cx-fact-tier' }, badge),
            h(
              'th',
              { scope: 'row', class: 'ks-cx-fact-label' },
              h('span', { class: 'ks-cx-fact-name' }, f.label),
              f.method ? h('span', { class: 'ks-cx-fact-method' }, f.method) : null,
            ),
            h('td', { class: 'ks-cx-fact-value' }, factValueView(f)),
            h('td', { class: 'ks-cx-fact-src' }, refLink(f.citation)),
          ),
        );
      }
      const table = h(
        'table',
        { class: 'ks-cx-table' },
        h('caption', { class: 'ks-cx-sr' }, t('codex.entry.factsCaption', { title: e.title })),
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col', class: 'ks-cx-fact-tier' }, t('codex.entry.col.tier')),
            h('th', { scope: 'col' }, t('codex.entry.col.quantity')),
            h('th', { scope: 'col', class: 'ks-cx-fact-value' }, t('codex.entry.col.value')),
            h('th', { scope: 'col', class: 'ks-cx-fact-src' }, t('codex.entry.col.source')),
          ),
        ),
        tbody,
      );
      parts.push(
        h('section', { class: 'ks-cx-section' }, h('h3', { class: 'ks-cx-h3' }, t('codex.entry.facts')), table),
      );
    }

    if (e.related.length > 0) {
      const list = h('ul', { class: 'ks-cx-chips', role: 'list' });
      for (const rid of e.related) {
        const r = this.store.entry(rid);
        if (!r) continue;
        if (this.store.discovered(rid)) {
          const b = h('button', { type: 'button', class: 'ks-cx-chip' }, icon(r.kind), r.title);
          b.addEventListener('click', () => this.showEntry(rid));
          list.append(h('li', {}, b));
        } else {
          list.append(
            h(
              'li',
              {},
              h(
                'span',
                { class: 'ks-cx-chip is-locked', title: lockedHint(r, this.store.entries()) },
                icon('lock'),
                t('codex.locked.title'),
              ),
            ),
          );
        }
      }
      if (list.childElementCount > 0)
        parts.push(
          h('section', { class: 'ks-cx-section' }, h('h3', { class: 'ks-cx-h3' }, t('codex.entry.related')), list),
        );
    }

    if (refs.size > 0) {
      const ol = h('ol', { class: 'ks-cx-sources' });
      for (const [key, n] of refs) {
        ol.append(
          h(
            'li',
            { id: srcId(n), tabindex: -1 },
            h('span', { class: 'ks-cx-src-n', 'aria-hidden': 'true' }, `[${n}]`),
            citationView(key, this.store.citation(key)),
          ),
        );
      }
      parts.push(
        h('section', { class: 'ks-cx-section' }, h('h3', { class: 'ks-cx-h3' }, t('codex.entry.sources')), ol),
      );
    }

    this.article.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
    // A short fade marks the new entry (skipped under reduced motion).
    if (!prefersReducedMotion() && typeof this.article.animate === 'function') {
      this.article.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    }
    this.main.scrollTop = 0;
  }
}

/** Short location label for the entry eyebrow: "Solar System", "TRAPPIST-1 system". */
function systemLabel(e: CodexEntry, entries: readonly CodexEntry[]): string | null {
  const sys = entrySystem(e);
  if (!sys) return null;
  const key = `codex.systemLabel.${sys}`;
  if (hasKey(key)) return t(key);
  const star = e.starName ?? entries.find((x) => x.kind === 'star' && x.systemId === sys && x.starName)?.starName;
  return star ? t('codex.systemLabel.named', { star }) : null;
}
