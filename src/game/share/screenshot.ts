/**
 * Screenshot mode: hides the HUD and cockpit (body class `ks-screenshot`, styled in share.css), shows a minimal
 * overlay (capture button, caption switch, exit) with viewfinder corners and a live preview of the caption, and
 * composites the rendered frame plus the optional caption bar into a PNG at the canvas's native resolution.
 *
 * Keyboard: the overlay is a group of native buttons (Tab, Enter, Space). Global keys (capture, exit) belong to the
 * game's input bindings; the integrator calls capture()/exit() from its action handler and passes the bound key
 * labels through `keyHints`, so hints always name the player's own bindings. Activation keys pressed on the overlay
 * stop at the overlay, so they do not also steer the ship.
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

const ACTIVATION_KEYS = new Set(['Enter', 'NumpadEnter', 'Space', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

export class ScreenshotMode {
  /** Caption switch state (used when capture() is called without an explicit caption option). */
  caption = true;
  /** The overlay root (hidden while inactive). */
  readonly root: HTMLElement;
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
  private readonly onResize = (): void => this.drawPreview();

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
    // Activation and navigation keys on the overlay must not reach the game's input bindings (window listeners).
    bar.addEventListener('keydown', (e) => {
      if (ACTIVATION_KEYS.has(e.code) || e.key === 'Enter' || e.key === ' ') e.stopPropagation();
    });
    bar.addEventListener('keyup', (e) => {
      if (ACTIVATION_KEYS.has(e.code) || e.key === 'Enter' || e.key === ' ') e.stopPropagation();
    });
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
    this.root.hidden = false;
    this.root.classList.toggle('is-still', this.still());
    this.refreshHints();
    this.drawPreview();
    this.previewTimer = window.setInterval(() => this.drawPreview(), 1000);
    window.addEventListener('pointermove', this.onActivity, { passive: true });
    window.addEventListener('pointerdown', this.onActivity, { passive: true });
    window.addEventListener('keydown', this.onActivity);
    window.addEventListener('resize', this.onResize);
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
    window.removeEventListener('resize', this.onResize);
    const hadFocus = this.root.contains(document.activeElement);
    this.root.hidden = true;
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
    this.root.remove();
    this.announcer.remove();
  }

  // --- Internals ----------------------------------------------------------------------------------------------------

  private async captureFromOverlay(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.captureBtn.setAttribute('aria-busy', 'true');
    this.captureBtn.disabled = true;
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
      this.captureBtn.disabled = false;
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
    if (this.caption) drawCaption(ctx, w, h, this.opts.captionText(), this.style());
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
