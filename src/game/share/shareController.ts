/**
 * Share and screenshot features wired to the game's input actions, independent of the App so it can run on the
 * demo page (share.html) with a fake host:
 *
 * - `share` action: copies a link to the current view and puts it in the address bar; a toast confirms.
 * - `screenshot` action: enters screenshot mode; pressed again, captures and downloads a PNG.
 * - `pause` (Escape, gamepad Menu) while in screenshot mode: leaves the mode instead of opening the pause menu.
 * - On boot and on `hashchange`, a `#ks1.…` fragment is decoded and applied through the host.
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
import { Toast } from './toast';

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
}

export class ShareController {
  readonly toast: Toast;
  readonly screenshot: ScreenshotMode;
  private readonly host: ShareHost;
  private readonly input: ActionSource;
  private lastDevice: InputContext;
  private capturing = false;
  private disposers: (() => void)[] = [];

  constructor(opts: ShareControllerOptions) {
    this.host = opts.host;
    this.input = opts.input;
    this.lastDevice = opts.input.activeDevice;
    const parent = opts.parent ?? document.body;
    const reducedMotion = opts.reducedMotion ?? ((): boolean => false);
    this.toast = new Toast({ parent, reducedMotion, label: t('share.toast.region') });
    this.screenshot = new ScreenshotMode({
      parent,
      getCanvasDataUrl: () => this.host.captureFrame(),
      captionText: () => this.host.caption(),
      keyHints: () => ({ capture: this.keyFor('screenshot'), exit: this.keyFor('pause') }),
      link: () => this.link(),
      onChange: (active) => this.host.setScreenshotMode?.(active),
      onCapture: (blob) => this.saved(blob),
      onError: (e) => this.failed(e),
      reducedMotion,
    });
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
    return shareUrl(location.href, s);
  }

  /** Copies the link, mirrors it in the address bar and confirms with a toast. Resolves whether it was copied. */
  async copyLink(): Promise<boolean> {
    const s = this.host.currentState();
    const url = s && !shareStateProblem(s) ? shareUrl(location.href, s) : null;
    if (!s || !url) {
      this.toast.show(t('share.toast.cannotShare'), { kind: 'error' });
      return false;
    }
    try {
      history.replaceState(history.state, '', url);
    } catch {
      // Sandboxed frames may refuse; the clipboard still has the link.
    }
    const ok = await copyText(url);
    if (ok) this.toast.show(t('share.toast.linkCopied'), { kind: 'ok', icon: 'link', detail: t('share.toast.linkCopiedDetail', { utc: formatUtc(s.timeMs) }) });
    else this.toast.show(t('share.toast.linkNotCopied'), { kind: 'warn', icon: 'link', detail: t('share.toast.linkNotCopiedDetail') });
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
    if (!r.ok) {
      if (r.error === 'empty' || r.error === 'not-share') return 'none';
      const newer = r.error === 'version' && (r.version ?? 0) > 1;
      if (say) this.toast.show(t(newer ? 'share.toast.newerVersion' : 'share.toast.damaged'), { kind: 'warn', icon: 'pin' });
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
      if (res === 'unknown-place') this.toast.show(t('share.toast.unknownPlace'), { kind: 'warn', icon: 'pin' });
      else {
        const place = this.host.placeName?.(r.state) ?? '';
        const detail = res === 'time-adjusted' ? t('share.toast.timeAdjusted') : t('share.toast.arrivedDetail', { place, utc: formatUtc(r.state.timeMs) });
        this.toast.show(t('share.toast.arrived'), { kind: res === 'ok' ? 'ok' : 'warn', icon: 'pin', detail });
      }
    }
    return res;
  }

  /** Reads the link embedded in a Known Sky screenshot and goes there. */
  async applyFromFile(file: Blob): Promise<FragmentOutcome> {
    let token: string | null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      token = isPng(bytes) ? findShareInPng(bytes) : null;
    } catch {
      token = null;
    }
    if (!token) {
      this.toast.show(t('share.toast.imageNoLink'), { kind: 'warn', icon: 'pin' });
      return 'none';
    }
    return this.applyFragment(`#${token}`);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.screenshot.dispose();
    this.toast.dispose();
  }

  private saved(blob: Blob): void {
    const name = screenshotFilename();
    this.screenshot.download(blob, name);
    this.toast.show(t('share.toast.screenshotSaved'), { kind: 'ok', icon: 'camera', detail: name });
  }

  private failed(e: unknown): void {
    console.error('Screenshot failed', e);
    this.toast.show(t('share.toast.screenshotFailed'), { kind: 'error', icon: 'camera' });
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.disposers.push(() => target.removeEventListener(type, fn));
  }
}
