/**
 * Share and screenshot features wired to the game's input actions, independent of the App so it can run on the
 * demo page (share.html) with a fake host:
 *
 * - `share` action: copies a link to the current view; a toast confirms. Only when the clipboard refuses does the link
 *   go into the address bar (the toast says so), so the address bar never keeps a place the player has left.
 * - `screenshot` action: enters screenshot mode; pressed again, captures and downloads a PNG.
 * - `pause` (Escape, gamepad Menu) while in screenshot mode: leaves the mode instead of opening the pause menu.
 * - On boot and on `hashchange`, a `#ks1.…` fragment is decoded and applied through the host, then removed from the
 *   address bar (so pasting the same link again applies it again, and a reload starts afresh).
 * - A Known Sky screenshot dropped on the page takes the player to the place it shows (link in the PNG metadata).
 *
 * The host adapts the world (App) to this controller; see gameShare.ts for the game's host.
 */
import { t } from '../i18n';
import type { ActionId } from '../input/actions';
import type { Binding, InputContext } from '../input/bindings';
import { bindingLabel } from '../input/labels';
import { formatUtc, type CaptionText } from './caption';
import { findShareInPng, isPng } from './pngText';
import { ScreenshotMode, screenshotFilename } from './screenshot';
import { parseShare, shareStateProblem, shareUrl, copyText, type ShareState } from './shareLink';
import { Toast, type ToastOptions } from './toast';

/** Outcome of applying a decoded link. */
export type ApplyResult = 'ok' | 'time-adjusted' | 'unknown-place';
/** Outcome of applyFragment(): 'none' when there was no Known Sky fragment. */
export type FragmentOutcome = ApplyResult | 'none' | 'newer-version' | 'damaged';

export interface ShareHost {
  /** The current view, or null when it cannot be shared (e.g. still booting). */
  currentState(): ShareState | null;
  /** Moves the camera, time and target to a decoded state. */
  applyState(s: ShareState): ApplyResult | Promise<ApplyResult>;
  /** Renders a frame and returns the canvas as a PNG data URL. */
  captureFrame(): string;
  /** Caption for the current view. */
  caption(): CaptionText;
  /** Short name of the place a state points at, for the arrival toast (e.g. "Moon"). */
  placeName?(s: ShareState): string;
  /** Screenshot mode changed: hide or restore the cockpit, release pointer lock, close overlays. */
  setScreenshotMode?(active: boolean): void;
  /** True while a menu or overlay (map, settings, Codex) has taken over the screen: screenshot mode then closes. */
  overlayOpen?(): boolean;
}

/** The parts of InputManager this controller reads. */
export interface ActionSource {
  justPressed(id: ActionId): boolean;
  binding(id: ActionId, slot: 0 | 1, context?: InputContext): Binding | null;
  readonly activeDevice: InputContext;
}

export interface ShareControllerOptions {
  host: ShareHost;
  input: ActionSource;
  /** The player's reduced-motion setting. */
  reducedMotion?: () => boolean;
  parent?: HTMLElement;
  /** Take the player to the place shown by a dropped Known Sky screenshot (default true). */
  acceptDrops?: boolean;
  /** Apply links pasted into the address bar while playing (default true). */
  followHashChanges?: boolean;
  /**
   * The page a link opens (default: this page's origin and path). Query parameters are left out on purpose: they are
   * the sharer's own choices (renderer, debug camera, a settings reset on the lab page) and must not reach the
   * recipient.
   */
  baseUrl?: () => string;
  /** Other notification stacks in the same corner (e.g. the Codex's): toasts are placed below them. */
  stackBelow?: () => readonly (Element | null)[];
}

/** A dropped file is read only this far for its link: Known Sky writes the link right after the PNG header. */
export const DROP_HEAD_BYTES = 1 << 20;
/** Files up to this size are read whole when the link is not near the start (another tool re-saved the image). */
export const DROP_MAX_BYTES = 64 << 20;

/** The page a link opens: origin and path, without the query or fragment. */
export function pageUrl(loc: Pick<Location, 'origin' | 'pathname'> = location): string {
  return `${loc.origin === 'null' ? '' : loc.origin}${loc.pathname}`;
}

/** The part of a File or Blob that shareTokenFromFile reads. */
export interface ReadableFile {
  readonly size: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * The share token ('ks1.…') in a dropped file, or null. Reads the 8-byte signature first and stops for anything but a
 * PNG; then the first DROP_HEAD_BYTES (Known Sky writes the link right after the header); the whole file only when the
 * link is not there and the file is at most DROP_MAX_BYTES. Never throws.
 */
export async function shareTokenFromFile(file: ReadableFile): Promise<string | null> {
  try {
    if (!isPng(new Uint8Array(await file.slice(0, 8).arrayBuffer()))) return null;
    const head = findShareInPng(new Uint8Array(await file.slice(0, DROP_HEAD_BYTES).arrayBuffer()));
    if (head || file.size <= DROP_HEAD_BYTES || file.size > DROP_MAX_BYTES) return head;
    return findShareInPng(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return null;
  }
}

/** True when an address-bar fragment is a Known Sky link (any version). */
function isShareFragment(hash: string): boolean {
  return /^#ks\d/.test(hash);
}

export class ShareController {
  readonly toast: Toast;
  readonly screenshot: ScreenshotMode;
  private readonly host: ShareHost;
  private readonly input: ActionSource;
  private lastDevice: InputContext;
  private capturing = false;
  private disposers: (() => void)[] = [];
  private readonly baseUrl: () => string;
  private readonly stackBelow: () => readonly (Element | null)[];
  private readonly stackObserver: ResizeObserver | null;
  private readonly observed = new Set<Element>();

  constructor(opts: ShareControllerOptions) {
    this.host = opts.host;
    this.input = opts.input;
    this.lastDevice = opts.input.activeDevice;
    this.baseUrl = opts.baseUrl ?? ((): string => pageUrl());
    this.stackBelow = opts.stackBelow ?? ((): readonly Element[] => []);
    const parent = opts.parent ?? document.body;
    const reducedMotion = opts.reducedMotion ?? ((): boolean => false);
    this.toast = new Toast({ parent, reducedMotion, label: t('share.toast.region') });
    this.screenshot = new ScreenshotMode({
      parent,
      getCanvasDataUrl: () => this.host.captureFrame(),
      captionText: () => this.host.caption(),
      keyHints: () => ({ capture: this.keyFor('screenshot'), exit: this.keyFor('pause') }),
      reservedKeys: () => [...this.keyCodes('screenshot'), ...this.keyCodes('pause')],
      link: () => this.link(),
      onChange: (active) => {
        this.host.setScreenshotMode?.(active);
        this.placeToasts();
      },
      onCapture: (blob) => this.saved(blob),
      onError: (e) => this.failed(e),
      reducedMotion,
    });
    // Toasts sit below the screenshot toolbar and any other notification stack in the same corner, re-measured when
    // either changes size.
    this.stackObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.placeToasts()) : null;
    this.listen(window, 'resize', () => this.placeToasts());
    if (opts.followHashChanges ?? true) this.listen(window, 'hashchange', () => void this.applyFragment(location.hash));
    if (opts.acceptDrops ?? true) {
      this.listen(window, 'dragover', (e) => {
        const dt = (e as DragEvent).dataTransfer;
        if (dt?.types.includes('Files')) {
          e.preventDefault();
          dt.dropEffect = 'copy';
        }
      });
      this.listen(window, 'drop', (e) => {
        const file = (e as DragEvent).dataTransfer?.files[0];
        if (!file) return;
        e.preventDefault();
        void this.applyFromFile(file);
      });
    }
  }

  /**
   * Call once per frame after input.update(). Handles the share and screenshot actions, and returns true when it
   * consumed `pause` (Escape closes screenshot mode instead of opening the pause menu).
   */
  update(): boolean {
    const inp = this.input;
    let consumed = false;
    // A menu or overlay that takes over the screen (the map, say) ends screenshot mode.
    if (this.screenshot.active && this.host.overlayOpen?.()) this.screenshot.exit();
    if (this.screenshot.active && inp.justPressed('pause')) {
      this.screenshot.exit();
      consumed = true;
    }
    if (inp.justPressed('screenshot')) {
      if (!this.screenshot.active) this.screenshot.enter();
      else void this.captureAndSave();
    }
    if (inp.justPressed('share')) void this.copyLink();
    if (inp.activeDevice !== this.lastDevice) {
      this.lastDevice = inp.activeDevice;
      if (this.screenshot.active) this.screenshot.refreshHints();
    }
    return consumed;
  }

  /** Label of the input bound to an action on the active device (null when unbound). */
  keyFor(action: ActionId): string | null {
    const ctx = this.input.activeDevice;
    const b = this.input.binding(action, 0, ctx) ?? this.input.binding(action, 1, ctx);
    return b ? bindingLabel(b) : null;
  }

  /** Link to the current view, or null when it cannot be shared. */
  link(): string | null {
    const s = this.host.currentState();
    if (!s || shareStateProblem(s)) return null;
    return shareUrl(this.baseUrl(), s);
  }

  /**
   * Copies the link and confirms with a toast. When the clipboard refuses, the link goes into the address bar instead
   * (the toast says so). Resolves whether it was copied.
   */
  async copyLink(): Promise<boolean> {
    const s = this.host.currentState();
    const url = s && !shareStateProblem(s) ? shareUrl(this.baseUrl(), s) : null;
    if (!s || !url) {
      this.showToast(t('share.toast.cannotShare'), { kind: 'error' });
      return false;
    }
    const ok = await copyText(url);
    if (ok) {
      // A link left in the address bar by an earlier failed copy would now name a place the player has left.
      this.clearAddressFragment();
      this.showToast(t('share.toast.linkCopied'), { kind: 'ok', icon: 'link', detail: t('share.toast.linkCopiedDetail', { utc: formatUtc(s.timeMs) }) });
    } else {
      this.setAddress(url);
      this.showToast(t('share.toast.linkNotCopied'), { kind: 'warn', icon: 'link', detail: t('share.toast.linkNotCopiedDetail') });
    }
    return ok;
  }

  /** Captures (with the caption switch's setting), downloads and confirms. Resolves the Blob, or null on failure. */
  async captureAndSave(): Promise<Blob | null> {
    if (this.capturing) return null;
    this.capturing = true;
    this.screenshot.flashOnce();
    try {
      const blob = await this.screenshot.capture();
      this.saved(blob);
      return blob;
    } catch (e) {
      this.failed(e);
      return null;
    } finally {
      this.capturing = false;
    }
  }

  /**
   * Applies a `#ks1.…` fragment (or a full URL). Does nothing for an empty or foreign fragment; otherwise moves the
   * view and explains the outcome with a toast.
   */
  async applyFragment(fragment: string, opts: { toast?: boolean } = {}): Promise<FragmentOutcome> {
    const say = opts.toast ?? true;
    const r = parseShare(fragment);
    if (!r.ok && (r.error === 'empty' || r.error === 'not-share')) return 'none';
    // The link has been read: take it out of the address bar, so that pasting it again applies it again (no
    // hashchange fires for an unchanged fragment) and a reload does not return to a place the player has left.
    if (fragment === location.hash) this.clearAddressFragment();
    if (!r.ok) {
      const newer = r.error === 'version' && (r.version ?? 0) > 1;
      if (say) this.showToast(t(newer ? 'share.toast.newerVersion' : 'share.toast.damaged'), { kind: 'warn', icon: 'pin' });
      return newer ? 'newer-version' : 'damaged';
    }
    if (this.screenshot.active) this.screenshot.exit();
    let res: ApplyResult;
    try {
      res = await this.host.applyState(r.state);
    } catch (e) {
      console.error('Applying a shared location failed', e);
      res = 'unknown-place';
    }
    if (say) {
      if (res === 'unknown-place') this.showToast(t('share.toast.unknownPlace'), { kind: 'warn', icon: 'pin' });
      else {
        const place = this.host.placeName?.(r.state) ?? '';
        const detail = res === 'time-adjusted' ? t('share.toast.timeAdjusted') : t('share.toast.arrivedDetail', { place, utc: formatUtc(r.state.timeMs) });
        this.showToast(t('share.toast.arrived'), { kind: res === 'ok' ? 'ok' : 'warn', icon: 'pin', detail });
      }
    }
    return res;
  }

  /**
   * Reads the link embedded in a Known Sky screenshot and goes there. Only PNGs are read, and only their first
   * DROP_HEAD_BYTES (where Known Sky writes the link), unless the link is further in and the file is at most
   * DROP_MAX_BYTES: dropping a video or an archive by mistake never loads it into memory.
   */
  async applyFromFile(file: Blob): Promise<FragmentOutcome> {
    const token = await shareTokenFromFile(file);
    if (!token) {
      this.showToast(t('share.toast.imageNoLink'), { kind: 'warn', icon: 'pin' });
      return 'none';
    }
    return this.applyFragment(`#${token}`);
  }

  /**
   * Places the toast stack below whatever else occupies the top of the screen: the screenshot toolbar while it is
   * shown, and other notification stacks in the same corner. Measured, so it holds at any text size and window size.
   */
  placeToasts(): void {
    const bar = this.screenshot.active ? this.screenshot.bar : null;
    let bottom = 0;
    for (const el of [...this.stackBelow(), bar]) {
      if (!el) continue;
      if (this.stackObserver && !this.observed.has(el)) {
        this.observed.add(el);
        this.stackObserver.observe(el);
      }
      // The toolbar's layout box: its idle fade slides it up a little, and the toasts need not follow.
      const r = el === bar ? { top: bar.offsetTop, height: bar.offsetHeight } : el.getBoundingClientRect();
      if (r.height > 0) bottom = Math.max(bottom, r.top + r.height);
    }
    const gap = 0.6 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    this.toast.element.style.setProperty('--ks-toast-top', bottom > 0 ? `${Math.round(bottom + gap)}px` : '');
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.stackObserver?.disconnect();
    this.screenshot.dispose();
    this.toast.dispose();
  }

  /** KeyboardEvent.code values bound to an action (either slot). */
  private keyCodes(action: ActionId): string[] {
    return [this.input.binding(action, 0, 'kbm'), this.input.binding(action, 1, 'kbm')].flatMap((b) => (b?.type === 'key' ? [b.code] : []));
  }

  private saved(blob: Blob): void {
    const name = screenshotFilename();
    this.screenshot.download(blob, name);
    this.showToast(t('share.toast.screenshotSaved'), { kind: 'ok', icon: 'camera', detail: name });
  }

  private failed(e: unknown): void {
    console.error('Screenshot failed', e);
    this.showToast(t('share.toast.screenshotFailed'), { kind: 'error', icon: 'camera' });
  }

  private showToast(message: string, opts: ToastOptions): void {
    this.placeToasts();
    this.toast.show(message, opts);
  }

  /** Puts a URL in the address bar without navigating (sandboxed frames may refuse). */
  private setAddress(url: string): void {
    try {
      history.replaceState(history.state, '', url);
    } catch {
      // Nothing else to do: the toast explains what happened.
    }
  }

  /** Removes a Known Sky fragment from the address bar (any other fragment is left alone). */
  private clearAddressFragment(): void {
    if (isShareFragment(location.hash)) this.setAddress(`${location.pathname}${location.search}`);
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.disposers.push(() => target.removeEventListener(type, fn));
  }
}
