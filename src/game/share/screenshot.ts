/**
 * Screenshot mode: hides the HUD and cockpit (body class `ks-screenshot`, styled in share.css), shows a minimal
 * overlay (capture button, caption switch, exit) with viewfinder corners and a live preview of the caption, and
 * composites the rendered frame plus the optional caption bar into a PNG at the canvas's native resolution.
 *
 * Keyboard: the overlay is a group of native buttons. While the mode is active, Tab (and Shift+Tab) from the game view
 * moves focus into the toolbar, even though Tab is a flight binding (target next); from there the browser moves focus
 * as usual, and the game's InputManager leaves Tab, Enter and Space to a focused button. Every other key, and every
 * key release, still reaches the game, so the ship never keeps turning on a key released over the toolbar. Global keys
 * (capture, exit) belong to the game's input bindings; the integrator calls capture()/exit() from its action handler
 * and passes the bound key labels through `keyHints`, so hints always name the player's own bindings.
 *
 * Layout: the toolbar's bottom edge (`--ks-shot-bar-bottom`) and the caption's height (`--ks-shot-caption-h`, with the
 * body class `ks-shot-captioned` while the caption is on) are published on <body>, so other overlays can stay clear
 * of them (share.css: Codex toasts, sound captions, viewfinder corners).
 *
 * Reduced motion: no capture flash, no fades (the Settings value via `reducedMotion`, html[data-reduced-motion] or
 * the OS preference).
 */
import '../ui/ui.css';
import './share.css';
import { t } from '../i18n';
import { captionStyleFromDocument, drawCaption, type CaptionText } from './caption';
import { addPngText } from './pngText';
import { iconSvg } from './toast';

export type { CaptionText } from './caption';

export interface ScreenshotModeOptions {
  /** Where the overlay is attached (usually document.body). */
  parent: HTMLElement;
  /** Renders a frame and returns renderer.domElement.toDataURL() (PNG). */
  getCanvasDataUrl: () => string;
  /** Caption for the current view, read at the moment of capture. */
  captionText: () => CaptionText;
  /** Labels of the inputs bound to capture and exit, from the player's bindings; null when unbound. */
  keyHints?: () => { capture: string | null; exit: string | null };
  /** KeyboardEvent.code values bound to capture and exit: when the player binds Tab to one, Tab does that instead. */
  reservedKeys?: () => readonly string[];
  /** A share link embedded in the PNG (iTXt Comment), so the image leads back to the place. */
  link?: () => string | null;
  /** Called after enter() and exit() (hide the cockpit, release pointer lock, ...). */
  onChange?: (active: boolean) => void;
  /** What the overlay's capture button does with the image (default: download it). */
  onCapture?: (blob: Blob) => void;
  /** Called when a capture from the overlay fails. */
  onError?: (err: unknown) => void;
  /** The player's reduced-motion setting. */
  reducedMotion?: () => boolean;
  /** Seconds without input before the overlay fades out (default 3). */
  idleSeconds?: number;
}

/** knownsky-YYYYMMDD-HHMMSS.png in the player's local time (the moment of capture, like a camera's file name). */
export function screenshotFilename(d: Date = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `knownsky-${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

/** Largest scene target for a supersampled capture, in pixels: twice 1280 × 720 in each direction. */
export const SUPERSAMPLE_MAX_PIXELS = 2560 * 1440;

/**
 * Render scale for a screenshot of a w × h canvas: up to 2 (four samples per pixel), less on large canvases so the
 * scene target stays within SUPERSAMPLE_MAX_PIXELS, and never below the scale already in use.
 */
export function supersampleScale(w: number, h: number, current = 1): number {
  const s = Math.min(2, Math.sqrt(SUPERSAMPLE_MAX_PIXELS / Math.max(1, w * h)));
  return s > current * 1.05 ? s : current;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (!url.startsWith('data:image/')) {
      reject(new Error('The canvas returned no image (is it zero-sized?)'));
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The canvas image could not be decoded'));
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

let instances = 0;

/** True when focus is on nothing the player can operate: the page, the game view, or an element hidden meanwhile. */
function focusIsFree(el: Element | null): boolean {
  if (!el || el === document.body || el === document.documentElement || el instanceof HTMLCanvasElement) return true;
  return el.getClientRects().length === 0;
}

export class ScreenshotMode {
  /** Caption switch state (used when capture() is called without an explicit caption option). */
  caption = true;
  /** The overlay root (hidden while inactive). */
  readonly root: HTMLElement;
  /** The toolbar (Capture, Caption, Exit). */
  readonly bar: HTMLElement;
  private _active = false;
  private busy = false;
  private readonly preview: HTMLCanvasElement;
  private readonly flash: HTMLElement;
  private readonly captureBtn: HTMLButtonElement;
  private readonly captureLabel: HTMLElement;
  private readonly captureKbd: HTMLElement;
  private readonly exitKbd: HTMLElement;
  private readonly captionBtn: HTMLButtonElement;
  private readonly announcer: HTMLElement;
  private idleTimer = 0;
  private previewTimer = 0;
  private restoreFocus: HTMLElement | null = null;
  private readonly onActivity = (): void => this.wake();
  private readonly onResize = (): void => {
    this.drawPreview();
    this.publishBar();
  };
  private readonly barObserver: ResizeObserver | null = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.publishBar()) : null;
  /**
   * Window capture phase, so it runs before the game's input: Tab from the game view goes to the toolbar instead of
   * cycling targets. Within the toolbar (or any other control) the browser's own focus order applies.
   */
  private readonly onTab = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (this.opts.reservedKeys?.().includes(e.code)) return;
    if (!focusIsFree(document.activeElement)) return;
    const stops = [...this.bar.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.getClientRects().length > 0);
    const to = e.shiftKey ? stops[stops.length - 1] : stops[0];
    if (!to) return;
    e.preventDefault();
    e.stopPropagation();
    this.wake();
    to.focus({ preventScroll: true });
  };

  constructor(private readonly opts: ScreenshotModeOptions) {
    const root = document.createElement('div');
    root.className = 'ks-shot';
    root.hidden = true;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', t('share.shot.region'));
    const hintId = `ks-shot-hint-${++instances}`;
    root.innerHTML = `
      <canvas class="ks-shot-preview" aria-hidden="true"></canvas>
      <div class="ks-shot-frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="ks-shot-flash" aria-hidden="true"></div>
      <div class="ks-shot-bar" role="group">
        <span class="ks-shot-badge" aria-hidden="true"><span class="ks-shot-rec"></span><span></span></span>
        <button type="button" class="ks-shot-btn ks-shot-capture">${iconSvg('camera')}<span class="ks-shot-label"></span><kbd class="ks-kbd" aria-hidden="true"></kbd></button>
        <button type="button" class="ks-shot-btn ks-shot-switch" role="switch" aria-describedby="${hintId}"><span class="ks-shot-track" aria-hidden="true"><span class="ks-shot-thumb"></span></span><span class="ks-shot-label"></span></button>
        <span class="ks-sr-only" id="${hintId}"></span>
        <span class="ks-shot-sep" aria-hidden="true"></span>
        <button type="button" class="ks-shot-btn ks-shot-exit"><span class="ks-shot-label"></span><kbd class="ks-kbd" aria-hidden="true"></kbd></button>
      </div>`;
    const q = (sel: string): HTMLElement => root.querySelector<HTMLElement>(sel)!;
    this.root = root;
    this.preview = q('.ks-shot-preview') as HTMLCanvasElement;
    // The preview canvas joins the page only while the mode is on: the game's canvas stays the page's only canvas.
    this.preview.remove();
    this.flash = q('.ks-shot-flash');
    this.captureBtn = q('.ks-shot-capture') as HTMLButtonElement;
    this.captureLabel = q('.ks-shot-capture .ks-shot-label');
    this.captureKbd = q('.ks-shot-capture kbd');
    this.captionBtn = q('.ks-shot-switch') as HTMLButtonElement;
    this.exitKbd = q('.ks-shot-exit kbd');
    // Announcements live outside the overlay so "closed" is still read after the overlay hides.
    this.announcer = document.createElement('p');
    this.announcer.className = 'ks-sr-only ks-shot-announcer';
    this.announcer.setAttribute('aria-live', 'polite');
    const bar = q('.ks-shot-bar');
    this.bar = bar;
    bar.setAttribute('aria-label', t('share.shot.controls'));
    q('.ks-shot-badge span:last-child').textContent = t('share.shot.badge');
    this.captureLabel.textContent = t('share.shot.capture');
    q('.ks-shot-switch .ks-shot-label').textContent = t('share.shot.caption');
    this.captionBtn.title = t('share.shot.captionHint');
    q(`#${hintId}`).textContent = t('share.shot.captionHint');
    q('.ks-shot-exit .ks-shot-label').textContent = t('share.shot.exit');

    this.captureBtn.addEventListener('click', () => void this.captureFromOverlay());
    this.captionBtn.addEventListener('click', () => this.setCaption(!this.caption));
    q('.ks-shot-exit').addEventListener('click', () => this.exit());
    // No key filter here: the game's input leaves Tab, Enter and Space to a focused button by itself, and every other
    // key (and every key release) must reach it, or a key released over the toolbar would stay held.
    bar.addEventListener('focusin', () => this.wake());
    opts.parent.append(root, this.announcer);
    this.syncCaptionSwitch();
  }

  get active(): boolean {
    return this._active;
  }

  enter(): void {
    if (this._active) return;
    this._active = true;
    this.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add('ks-screenshot');
    this.root.prepend(this.preview);
    this.root.hidden = false;
    this.root.classList.toggle('is-still', this.still());
    this.refreshHints();
    this.drawPreview();
    this.previewTimer = window.setInterval(() => this.drawPreview(), 1000);
    window.addEventListener('pointermove', this.onActivity, { passive: true });
    window.addEventListener('pointerdown', this.onActivity, { passive: true });
    window.addEventListener('keydown', this.onActivity);
    window.addEventListener('keydown', this.onTab, true);
    window.addEventListener('resize', this.onResize);
    this.barObserver?.observe(this.bar);
    this.publishBar();
    this.wake();
    const k = this.opts.keyHints?.();
    this.announce(k?.capture && k.exit ? t('share.shot.enteredKeys', { capture: k.capture, exit: k.exit }) : t('share.shot.entered'));
    this.opts.onChange?.(true);
  }

  exit(): void {
    if (!this._active) return;
    this._active = false;
    document.body.classList.remove('ks-screenshot');
    window.clearInterval(this.previewTimer);
    window.clearTimeout(this.idleTimer);
    window.removeEventListener('pointermove', this.onActivity);
    window.removeEventListener('pointerdown', this.onActivity);
    window.removeEventListener('keydown', this.onActivity);
    window.removeEventListener('keydown', this.onTab, true);
    window.removeEventListener('resize', this.onResize);
    this.barObserver?.disconnect();
    const body = document.body;
    body.classList.remove('ks-shot-captioned');
    body.style.removeProperty('--ks-shot-bar-bottom');
    body.style.removeProperty('--ks-shot-caption-h');
    const hadFocus = this.root.contains(document.activeElement);
    this.root.hidden = true;
    this.preview.remove();
    this.root.classList.remove('is-idle');
    this.announce(t('share.shot.exited'));
    if (hadFocus) this.restoreFocus?.focus({ preventScroll: true });
    this.opts.onChange?.(false);
  }

  /** Caption switch (also shown in the preview). */
  setCaption(on: boolean): void {
    this.caption = on;
    this.syncCaptionSwitch();
    this.drawPreview();
    this.announce(t(on ? 'share.shot.captionOn' : 'share.shot.captionOff'));
  }

  /** Re-reads the key hints (call after the player rebinds or switches between keyboard and gamepad). */
  refreshHints(): void {
    const k = this.opts.keyHints?.() ?? { capture: null, exit: null };
    this.captureKbd.textContent = k.capture ?? '';
    this.captureKbd.hidden = !k.capture;
    this.exitKbd.textContent = k.exit ?? '';
    this.exitKbd.hidden = !k.exit;
  }

  /**
   * Renders a frame and composites it with the optional caption at native resolution. Resolves a PNG Blob (with the
   * share link in its metadata when `link` is set).
   */
  async capture(opts: { caption?: boolean } = {}): Promise<Blob> {
    const withCaption = opts.caption ?? this.caption;
    const url = this.opts.getCanvasDataUrl();
    // Sample the caption at the same moment as the frame.
    const text = withCaption ? this.opts.captionText() : null;
    const link = this.opts.link?.() ?? null;
    const img = await loadImage(url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error('The canvas image is empty');
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.drawImage(img, 0, 0);
    if (text) drawCaption(ctx, w, h, text, this.style());
    const png = await toBlob(canvas);
    const meta: Record<string, string> = { Software: t('app.title') };
    if (text) {
      meta['Title'] = text.title;
      meta['Description'] = `${text.subtitle}\n${text.credits}`;
    }
    if (link) meta['Comment'] = t('share.png.comment', { url: link });
    meta['Creation Time'] = new Date().toUTCString();
    const bytes = addPngText(new Uint8Array(await png.arrayBuffer()), meta);
    return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' });
  }

  /** Saves a Blob through a temporary download link (knownsky-YYYYMMDD-HHMMSS.png by default). */
  download(blob: Blob, filename: string = screenshotFilename()): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    // Revoke after the browser has started the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  dispose(): void {
    this.exit();
    this.barObserver?.disconnect();
    this.root.remove();
    this.announcer.remove();
  }

  // --- Internals ----------------------------------------------------------------------------------------------------

  private async captureFromOverlay(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    // Busy, not disabled: a disabled button would drop keyboard focus.
    this.captureBtn.setAttribute('aria-busy', 'true');
    this.captureBtn.setAttribute('aria-disabled', 'true');
    this.captureLabel.textContent = t('share.shot.capturing');
    this.flashOnce();
    try {
      const blob = await this.capture();
      if (this.opts.onCapture) this.opts.onCapture(blob);
      else this.download(blob);
    } catch (e) {
      this.opts.onError?.(e);
    } finally {
      this.busy = false;
      this.captureBtn.removeAttribute('aria-busy');
      this.captureBtn.removeAttribute('aria-disabled');
      this.captureLabel.textContent = t('share.shot.capture');
    }
  }

  /** A brief shutter flash (skipped under reduced motion). Public for the integrator's keyboard capture. */
  flashOnce(): void {
    if (this.still() || !this._active) return;
    this.flash.classList.remove('is-on');
    // Reading layout restarts the CSS animation when it is already running.
    this.flash.getBoundingClientRect();
    this.flash.classList.add('is-on');
  }

  private style(): ReturnType<typeof captionStyleFromDocument> {
    return captionStyleFromDocument(t('app.title'), t('app.tagline'));
  }

  private drawPreview(): void {
    if (!this._active) return;
    const c = this.preview;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(innerWidth * dpr));
    const h = Math.max(1, Math.round(innerHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    c.hidden = !this.caption;
    const box = this.caption ? drawCaption(ctx, w, h, this.opts.captionText(), this.style()) : null;
    // The caption's height in CSS pixels: the viewfinder corners and the sound captions keep above it (share.css).
    const body = document.body;
    body.classList.toggle('ks-shot-captioned', box !== null);
    if (box) body.style.setProperty('--ks-shot-caption-h', `${Math.round((h - box.textTop) / (h / innerHeight))}px`);
    else body.style.removeProperty('--ks-shot-caption-h');
  }

  /** Publishes the toolbar's bottom edge (layout box, not the idle fade's offset) for overlays that must stay below it. */
  private publishBar(): void {
    if (!this._active) return;
    document.body.style.setProperty('--ks-shot-bar-bottom', `${Math.round(this.bar.offsetTop + this.bar.offsetHeight)}px`);
  }

  private syncCaptionSwitch(): void {
    this.captionBtn.setAttribute('aria-checked', String(this.caption));
  }

  private wake(): void {
    this.root.classList.remove('is-idle');
    window.clearTimeout(this.idleTimer);
    if (!this._active) return;
    this.idleTimer = window.setTimeout(() => {
      // Stay visible while the overlay has keyboard focus or the pointer is over it.
      if (this.root.querySelector('.ks-shot-bar:focus-within, .ks-shot-bar:hover')) this.wake();
      else this.root.classList.add('is-idle');
    }, (this.opts.idleSeconds ?? 3) * 1000);
  }

  private announce(text: string): void {
    this.announcer.textContent = '';
    window.setTimeout(() => (this.announcer.textContent = text), 60);
  }

  private still(): boolean {
    if (this.opts.reducedMotion?.()) return true;
    if (document.documentElement.dataset['reducedMotion'] === 'true') return true;
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
}
