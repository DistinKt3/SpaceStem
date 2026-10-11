/**
 * A small notification ("Link copied", "Screenshot saved"). One toast at a time: a new one replaces the current one.
 * The container is a polite, atomic live region that exists from construction, so screen readers announce every
 * message (including a repeat of the same text). Toasts are not interactive; hovering pauses the timer. Motion is a
 * short slide and fade, removed under reduced motion (the Settings value, html[data-reduced-motion] or the OS
 * preference).
 */
import '../ui/ui.css';
import './share.css';

export type ToastKind = 'info' | 'ok' | 'warn' | 'error';
export type ToastIcon = 'link' | 'camera' | 'check' | 'warn' | 'pin';

export interface ToastOptions {
  kind?: ToastKind;
  icon?: ToastIcon;
  /** Second line, smaller. */
  detail?: string;
  /** Override the reading-time based duration (ms). */
  durationMs?: number;
}

const ICONS: Record<ToastIcon, string> = {
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12 5.6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  camera:
    '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.4-2h5.8l1.4 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.8" r="3.4"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.4"/>',
  warn: '<path d="M12 4.2 20.5 19H3.5z"/><path d="M12 10v4.2"/><path d="M12 16.6v.2"/>',
  pin: '<path d="M12 21s-6-5.4-6-10.2a6 6 0 0 1 12 0C18 15.6 12 21 12 21z"/><circle cx="12" cy="10.8" r="2.2"/>',
};

const DEFAULT_ICON: Record<ToastKind, ToastIcon> = { info: 'check', ok: 'check', warn: 'warn', error: 'warn' };

/** Reading time: 4 s minimum, +55 ms per character, 12 s maximum. */
export function toastDuration(message: string, detail = ''): number {
  return Math.min(12_000, Math.max(4_000, 1_800 + 55 * (message.length + detail.length)));
}

export function iconSvg(icon: ToastIcon, cls = 'ks-ico'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[icon]}</svg>`;
}

export class Toast {
  /** The live region (role=status). */
  readonly element: HTMLElement;
  private card: HTMLElement | null = null;
  private timer = 0;
  private remaining = 0;
  private startedAt = 0;
  private message: string | null = null;

  constructor(private readonly opts: { parent?: HTMLElement; reducedMotion?: () => boolean; label?: string } = {}) {
    this.element = document.createElement('div');
    this.element.className = 'ks-toasts';
    this.element.setAttribute('role', 'status');
    this.element.setAttribute('aria-live', 'polite');
    this.element.setAttribute('aria-atomic', 'true');
    if (opts.label) this.element.setAttribute('aria-label', opts.label);
    (opts.parent ?? document.body).append(this.element);
  }

  /** Text of the toast on screen, or null. */
  get current(): string | null {
    return this.message;
  }

  show(message: string, opts: ToastOptions = {}): void {
    const kind = opts.kind ?? 'info';
    this.clearTimer();
    this.card?.remove();
    const card = document.createElement('div');
    card.className = 'ks-toast';
    card.dataset['kind'] = kind;
    if (this.still()) card.classList.add('is-still');
    const icon = document.createElement('span');
    icon.className = 'ks-toast-icon';
    icon.innerHTML = iconSvg(opts.icon ?? DEFAULT_ICON[kind]);
    const body = document.createElement('span');
    body.className = 'ks-toast-body';
    const msg = document.createElement('span');
    msg.className = 'ks-toast-msg';
    msg.textContent = message;
    body.append(msg);
    if (opts.detail) {
      const d = document.createElement('span');
      d.className = 'ks-toast-detail';
      d.textContent = opts.detail;
      body.append(d);
    }
    card.append(icon, body);
    card.addEventListener('pointerenter', () => this.pause());
    card.addEventListener('pointerleave', () => this.resume());
    this.element.append(card);
    this.card = card;
    this.message = message;
    // Next frame: lets the entry transition run from its start state.
    requestAnimationFrame(() => card.classList.add('is-in'));
    this.remaining = opts.durationMs ?? toastDuration(message, opts.detail);
    this.resume();
  }

  hide(): void {
    this.clearTimer();
    const card = this.card;
    this.card = null;
    this.message = null;
    if (!card) return;
    if (this.still()) {
      card.remove();
      return;
    }
    card.classList.remove('is-in');
    card.classList.add('is-out');
    const done = (): void => card.remove();
    card.addEventListener('transitionend', done, { once: true });
    window.setTimeout(done, 400);
  }

  dispose(): void {
    this.clearTimer();
    this.element.remove();
  }

  private still(): boolean {
    if (this.opts.reducedMotion?.()) return true;
    if (document.documentElement.dataset['reducedMotion'] === 'true') return true;
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private pause(): void {
    if (!this.timer) return;
    this.clearTimer();
    this.remaining -= performance.now() - this.startedAt;
  }

  private resume(): void {
    if (this.timer || !this.card) return;
    this.startedAt = performance.now();
    this.timer = window.setTimeout(() => this.hide(), Math.max(1_000, this.remaining));
  }

  private clearTimer(): void {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = 0;
  }
}
