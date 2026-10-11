/**
 * "Codex entry unlocked" toasts. A polite live region announces each one; the card slides in from the edge unless
 * reduced motion is on (prefers-reduced-motion or the game's setting), in which case it only fades.
 *
 * While a modal dialog is open (the Codex itself, settings), toasts wait and appear once it closes, so they are
 * neither hidden behind the dialog nor lost.
 */
import { t } from '../i18n';
import '../ui/codex.css';
import { h, icon, modalOpen, prefersReducedMotion, srOnly } from './dom';
import { kindLabel } from './format';
import type { CodexEntry } from './types';

export interface CodexToastOptions {
  /** Shows a "View" button that opens the entry. */
  onView?: (id: string) => void;
  /** How long a toast stays (ms); hovering or focusing it pauses the countdown. */
  durationMs?: number;
  /** At most this many toasts on screen; further ones queue. */
  maxVisible?: number;
  parent?: HTMLElement;
}

type ToastEntry = Pick<CodexEntry, 'id' | 'title' | 'kind'>;

interface Live {
  readonly el: HTMLElement;
  remaining: number;
  started: number;
  timer: number;
}

export class CodexToast {
  readonly element: HTMLDivElement;
  private readonly queue: ToastEntry[] = [];
  private readonly live: Live[] = [];
  private readonly duration: number;
  private readonly max: number;
  private waitingForModal = false;

  constructor(private readonly opts: CodexToastOptions = {}) {
    this.duration = opts.durationMs ?? 6000;
    this.max = opts.maxVisible ?? 3;
    // The region exists before any toast so screen readers announce additions to it.
    this.element = h('div', { class: 'ks-cx-toasts', role: 'region', 'aria-label': t('codex.toast.region'), 'aria-live': 'polite', 'aria-relevant': 'additions' });
    (opts.parent ?? document.body).append(this.element);
  }

  /** Queues a toast for an entry; returns immediately. */
  show(entry: ToastEntry): void {
    this.queue.push({ id: entry.id, title: entry.title, kind: entry.kind });
    this.pump();
  }

  /** Number of toasts on screen. */
  get visibleCount(): number {
    return this.live.length;
  }

  dismissAll(): void {
    this.queue.length = 0;
    for (const l of [...this.live]) this.dismiss(l, true);
  }

  dispose(): void {
    this.dismissAll();
    this.element.remove();
  }

  private pump(): void {
    if (modalOpen()) {
      this.waitForModal();
      return;
    }
    while (this.queue.length > 0 && this.live.length < this.max) this.present(this.queue.shift()!);
  }

  private waitForModal(): void {
    if (this.waitingForModal) return;
    this.waitingForModal = true;
    const onClose = (): void => {
      // 'close' fires before focus settles; check on the next frame whether another modal is still open.
      requestAnimationFrame(() => {
        if (modalOpen()) return;
        document.removeEventListener('close', onClose, true);
        this.waitingForModal = false;
        this.pump();
      });
    };
    document.addEventListener('close', onClose, true);
  }

  private present(entry: ToastEntry): void {
    const still = prefersReducedMotion();
    const card = h(
      'div',
      { class: `ks-cx-toast${still ? ' is-still' : ''}`, 'data-entry': entry.id },
      h('span', { class: 'ks-cx-toast-icon', 'aria-hidden': 'true' }, icon('codex'), icon(entry.kind, 'ks-cx-icon ks-cx-toast-kind')),
      h(
        'div',
        { class: 'ks-cx-toast-text' },
        // One sentence for screen readers; the visual layout splits it into a label and the title.
        srOnly(t('codex.toast.unlocked', { title: entry.title })),
        h('p', { class: 'ks-cx-eyebrow', 'aria-hidden': 'true' }, t('codex.toast.eyebrow')),
        h('p', { class: 'ks-cx-toast-title', 'aria-hidden': 'true' }, entry.title),
        h('p', { class: 'ks-cx-toast-kind-label', 'aria-hidden': 'true' }, kindLabel(entry.kind)),
      ),
    );
    const actions = h('div', { class: 'ks-cx-toast-actions' });
    const live: Live = { el: card, remaining: this.duration, started: performance.now(), timer: 0 };
    if (this.opts.onView) {
      const view = h('button', { type: 'button', class: 'ks-cx-btn ks-cx-btn--primary ks-cx-toast-view', 'aria-label': t('codex.toast.viewLabel', { title: entry.title }) }, t('codex.toast.view'));
      view.addEventListener('click', () => {
        this.dismiss(live, true);
        this.opts.onView?.(entry.id);
      });
      actions.append(view);
    }
    const x = h('button', { type: 'button', class: 'ks-cx-iconbtn ks-cx-toast-x', 'aria-label': t('codex.toast.dismiss'), title: t('codex.toast.dismiss') }, icon('close'));
    x.addEventListener('click', () => this.dismiss(live, true));
    actions.append(x);
    card.append(actions);
    if (!still) card.append(h('span', { class: 'ks-cx-toast-timer', 'aria-hidden': 'true', style: `animation-duration: ${this.duration}ms` }));

    const pause = (): void => {
      if (!live.timer) return;
      window.clearTimeout(live.timer);
      live.timer = 0;
      live.remaining -= performance.now() - live.started;
      card.classList.add('is-paused');
    };
    const resume = (): void => {
      if (live.timer || !card.isConnected || card.matches(':hover, :focus-within')) return;
      live.started = performance.now();
      live.timer = window.setTimeout(() => this.dismiss(live, false), Math.max(1200, live.remaining));
      card.classList.remove('is-paused');
    };
    card.addEventListener('pointerenter', pause);
    card.addEventListener('focusin', pause);
    card.addEventListener('pointerleave', resume);
    card.addEventListener('focusout', () => requestAnimationFrame(resume));

    this.element.append(card);
    this.live.push(live);
    live.timer = window.setTimeout(() => this.dismiss(live, false), this.duration);
  }

  private dismiss(l: Live, immediate: boolean): void {
    const i = this.live.indexOf(l);
    if (i < 0) return;
    this.live.splice(i, 1);
    window.clearTimeout(l.timer);
    const done = (): void => {
      l.el.remove();
      this.pump();
    };
    if (immediate || prefersReducedMotion()) {
      done();
      return;
    }
    l.el.classList.add('is-leaving');
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      done();
    };
    l.el.addEventListener('animationend', (ev) => {
      if (ev.target === l.el) finish(); // Not the countdown bar's own animation.
    });
    window.setTimeout(finish, 400); // In case animations are disabled.
  }
}
