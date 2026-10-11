/**
 * Subtitles and sound captions: a bottom-centre region that shows up to three lines. Honours the subtitles toggle,
 * caption size and text scale (sizes are rem-based), and reduced motion (no fades). The region is an aria-live
 * "log" so screen readers hear new lines without interrupting. A caption identical to one already on screen extends
 * that line (with a repeat count) instead of stacking a duplicate.
 *
 * show() accepts either an i18n key (resolved with t(key, params)) or already-translated text.
 */
import './ui.css';
import { hasKey, t } from '../i18n';
import type { Settings } from '../settings/settings';

export const MAX_CAPTION_LINES = 3;
const FADE_MS = 220;

interface Line {
  readonly text: string;
  readonly el: HTMLElement;
  readonly countEl: HTMLElement;
  count: number;
  until: number;
  timer: number;
}

export class Captions {
  readonly element: HTMLElement;
  private readonly lines: Line[] = [];
  private readonly unsub: () => void;

  constructor(
    private readonly settings: Settings,
    options: { parent?: HTMLElement } = {},
  ) {
    this.element = document.createElement('div');
    this.element.className = 'ks-captions';
    this.element.setAttribute('role', 'log');
    this.element.setAttribute('aria-live', 'polite');
    this.element.setAttribute('aria-relevant', 'additions');
    this.element.setAttribute('aria-label', t('settings.captions.region'));
    (options.parent ?? document.body).append(this.element);
    this.apply();
    this.unsub = settings.onChange((_, changed) => {
      if (changed.has('subtitles') || changed.has('captionSize')) this.apply();
    });
  }

  /** Lines currently on screen (oldest first). */
  get visible(): string[] {
    return this.lines.map((l) => l.text);
  }

  show(keyOrText: string, durationS: number, params: Record<string, string | number> = {}): void {
    if (!this.settings.data.subtitles) return;
    const text = hasKey(keyOrText) ? t(keyOrText, params) : keyOrText;
    if (text.trim().length === 0) return;
    const now = performance.now();
    const ms = Math.max(0.5, durationS) * 1000;
    const existing = this.lines.find((l) => l.text === text);
    if (existing) {
      existing.count += 1;
      existing.countEl.textContent = t('settings.captions.repeat', { count: existing.count });
      existing.countEl.hidden = false;
      this.schedule(existing, Math.max(existing.until, now + ms));
      return;
    }
    while (this.lines.length >= MAX_CAPTION_LINES) this.remove(this.lines[0]!, true);
    const el = document.createElement('p');
    el.className = 'ks-caption';
    const span = document.createElement('span');
    span.className = 'ks-caption-text';
    span.textContent = text;
    const countEl = document.createElement('span');
    countEl.className = 'ks-caption-count';
    countEl.hidden = true;
    // The count is visual only; repeating it to a screen reader would be noise.
    countEl.setAttribute('aria-hidden', 'true');
    el.append(span, countEl);
    this.element.append(el);
    const line: Line = { text, el, countEl, count: 1, until: 0, timer: 0 };
    this.lines.push(line);
    this.schedule(line, now + ms);
    this.element.classList.add('has-lines');
    requestAnimationFrame(() => el.classList.add('is-in'));
  }

  clear(): void {
    for (const l of [...this.lines]) this.remove(l, true);
  }

  dispose(): void {
    this.clear();
    this.unsub();
    this.element.remove();
  }

  private apply(): void {
    const d = this.settings.data;
    this.element.dataset['size'] = d.captionSize;
    this.element.hidden = !d.subtitles;
    if (!d.subtitles) this.clear();
  }

  private schedule(line: Line, until: number): void {
    line.until = until;
    clearTimeout(line.timer);
    line.timer = window.setTimeout(() => this.remove(line, false), Math.max(0, until - performance.now()));
  }

  private remove(line: Line, immediate: boolean): void {
    const i = this.lines.indexOf(line);
    if (i < 0) return;
    this.lines.splice(i, 1);
    clearTimeout(line.timer);
    const reduced = this.settings.data.reducedMotion;
    if (immediate || reduced) line.el.remove();
    else {
      line.el.classList.remove('is-in');
      line.el.classList.add('is-out');
      window.setTimeout(() => line.el.remove(), FADE_MS);
    }
    if (this.lines.length === 0) this.element.classList.remove('has-lines');
  }
}
