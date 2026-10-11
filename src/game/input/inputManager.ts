/**
 * InputManager: turns keyboard, mouse and gamepad state into named actions (see actions.ts) using the bindings stored
 * in Settings. Call update(dt) once per frame, then read axis() / held() / justPressed() for that frame.
 *
 * Behaviour worth knowing:
 * - Keys are ignored while a text field has focus, and while Ctrl or Cmd is held (browser shortcuts stay intact).
 * - Losing window focus or visibility clears all state; gamepad buttons held at that moment are ignored until released.
 * - Presses shorter than a frame still register (presses are latched between updates).
 * - Escape (and the gamepad Menu button) always map to `pause`; neither can be rebound or captured.
 * - When pointer lock is lost without releasePointerLock() (the browser exits lock on Escape and swallows that key),
 *   a `pause` press is synthesised so the pause menu still opens.
 * - Mouse movement drives pitch and yaw while the pointer is locked or a button is dragging on the target, except
 *   while headLook is held: then it is only reported by mouseDelta() for the camera.
 */
import { withBinding, type Settings } from '../settings/settings';
import {
  ACTIONS,
  RESERVED_INPUTS,
  actionDef,
  bindingAllowed,
  defaultBindings,
  findConflicts,
  isFixedSlot,
  PAD,
  type ActionId,
  type BindingConflict,
} from './actions';
import {
  contextOf,
  keyInput,
  mouseInput,
  padAxisInput,
  padButtonInput,
  wheelInput,
  type Binding,
  type InputContext,
} from './bindings';
import { padStyleFromId, setPadStyle } from './labels';

/** Radial deadzone for sticks (fraction of full deflection). */
export const PAD_STICK_DEADZONE = 0.18;
/** Deadzone for analog buttons (triggers) used as axes. */
export const PAD_TRIGGER_DEADZONE = 0.06;
const PAD_PRESS = 0.5;
const PAD_RELEASE = 0.35;
/** Rebind capture needs a decisive stick push. */
const PAD_CAPTURE_AXIS = 0.65;
/** Mouse speed in CSS px/s (at sensitivity 1) that gives full pitch/yaw deflection. */
export const MOUSE_FULL_SCALE_PX_PER_S = 1200;
/** Larger single movement events are pointer-lock glitches (a known Chromium issue) and are dropped. */
const MOUSE_SPIKE_PX = 600;
/** Wheel distance in pixels that counts as one notch. */
const WHEEL_NOTCH_PX = 100;

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight']);
const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image']);

export type RebindStep = 'any' | 'neg' | 'pos';

export interface RebindOptions {
  /** Capture only this context's inputs (the panel's device tab). Omitted: whatever device the player uses. */
  context?: InputContext;
  /** Called when an axis capture moves to its second input. */
  onStep?: (step: RebindStep) => void;
  /** Mouse buttons and the wheel are captured only over this element; a click elsewhere cancels the capture. */
  mouseTarget?: Element | null;
}

export interface RebindState {
  readonly id: ActionId;
  readonly slot: 0 | 1;
  readonly context: InputContext | null;
  readonly step: RebindStep;
}

export interface InputManagerOptions {
  /** Gamepad source (tests); defaults to navigator.getGamepads(). */
  getGamepads?: () => readonly (Gamepad | null)[];
}

interface Capture {
  id: ActionId;
  slot: 0 | 1;
  context: InputContext | null;
  step: RebindStep;
  opts: RebindOptions;
  resolve: (b: Binding | null) => void;
  firstKey: string | null;
  firstPadButton: number | null;
  /** Pad inputs that were down when the capture started (or after the first step); ignored until released. */
  padHeld: Set<string>;
  raf: number;
}

interface PadFrame {
  buttons: number[];
  axes: number[];
}

function isEditable(el: unknown): boolean {
  if (typeof el !== 'object' || el === null) return false;
  const e = el as { tagName?: unknown; type?: unknown; isContentEditable?: unknown };
  if (e.isContentEditable === true) return true;
  const tag = typeof e.tagName === 'string' ? e.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has(typeof e.type === 'string' ? e.type.toLowerCase() : 'text');
  return false;
}

const bump = (m: Map<string, number>, k: string, n = 1): void => {
  m.set(k, (m.get(k) ?? 0) + n);
};

function stickPair(x: number, y: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag < PAD_STICK_DEADZONE) return [0, 0];
  const scaled = Math.min(1, (mag - PAD_STICK_DEADZONE) / (1 - PAD_STICK_DEADZONE));
  return [(x / mag) * scaled, (y / mag) * scaled];
}

function triggerValue(v: number): number {
  return v < PAD_TRIGGER_DEADZONE ? 0 : Math.min(1, (v - PAD_TRIGGER_DEADZONE) / (1 - PAD_TRIGGER_DEADZONE));
}

export class InputManager {
  /** The device family used most recently (for on-screen prompts). */
  activeDevice: InputContext = 'kbm';
  /** Synthesise a pause press when the browser drops pointer lock on its own (Escape). */
  pauseOnPointerLockLoss = true;

  private readonly win: Window;
  private readonly doc: Document;
  private readonly getPads: () => readonly (Gamepad | null)[];
  private _enabled = true;
  private disposed = false;

  // Bindings, rebuilt when settings change.
  private kbm = new Map<ActionId, Binding[]>();
  private pad = new Map<ActionId, Binding[]>();
  private kbmCodes = new Set<string>();
  private kbmMouseButtons = new Set<number>();

  // Raw device state.
  private readonly keys = new Set<string>();
  private readonly mouseButtons = new Set<number>();
  private readonly dragButtons = new Set<number>();
  private readonly presses = new Map<string, number>();
  private readonly synthetic = new Map<ActionId, number>();
  private wheelAccum = 0;
  private rawDx = 0;
  private rawDy = 0;
  private padFrame: PadFrame = { buttons: [], axes: [] };
  private readonly padDown = new Set<string>();
  private readonly padSuppressed = new Set<string>();

  // Per-frame action state.
  private frameDx = 0;
  private frameDy = 0;
  private readonly values = new Map<ActionId, number>();
  private heldNow = new Set<ActionId>();
  private heldPrev = new Set<ActionId>();
  private readonly counts = new Map<ActionId, number>();

  private wasLocked = false;
  private releasingLock = false;
  private capture: Capture | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    readonly target: HTMLElement,
    readonly settings: Settings,
    options: InputManagerOptions = {},
  ) {
    this.doc = target.ownerDocument;
    this.win = this.doc.defaultView ?? window;
    const nav = this.win.navigator as Navigator | undefined;
    this.getPads =
      options.getGamepads ??
      (() => {
        try {
          return nav?.getGamepads?.() ?? [];
        } catch {
          return []; // Blocked by permissions policy or an insecure context.
        }
      });
    this.rebuildBindings();
    this.cleanups.push(
      settings.onChange((_, changed) => {
        if (changed.has('bindings') || changed.has('padBindings')) this.rebuildBindings();
      }),
    );

    this.listen(this.win, 'keydown', this.onKeyDown);
    this.listen(this.win, 'keyup', this.onKeyUp);
    this.listen(this.win, 'blur', this.onBlur);
    this.listen(this.doc, 'visibilitychange', this.onVisibility);
    this.listen(this.target, 'mousedown', this.onMouseDown);
    this.listen(this.win, 'mouseup', this.onMouseUp);
    this.listen(this.win, 'mousemove', this.onMouseMove);
    this.listen(this.target, 'wheel', this.onWheel, { passive: false });
    this.listen(this.target, 'contextmenu', this.onContextMenu);
    this.listen(this.doc, 'pointerlockchange', this.onPointerLockChange);
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** While disabled (e.g. a menu is open) all actions read as idle. */
  set enabled(v: boolean) {
    if (v === this._enabled) return;
    this._enabled = v;
    this.clearState();
  }

  get pointerLocked(): boolean {
    return this.doc.pointerLockElement === this.target;
  }

  /** The current capture, if a rebind is in progress. */
  get rebinding(): RebindState | null {
    const c = this.capture;
    return c ? { id: c.id, slot: c.slot, context: c.context, step: c.step } : null;
  }

  // --- Per-frame API ------------------------------------------------------------------------------------------------

  update(dt: number): void {
    this.pollPads();
    this.pollCapturePads();
    this.frameDx = this.rawDx;
    this.frameDy = this.rawDy;
    this.rawDx = 0;
    this.rawDy = 0;

    this.heldPrev = this.heldNow;
    this.heldNow = new Set();
    this.values.clear();
    this.counts.clear();
    if (this._enabled) {
      const headLook = this.evaluate('headLook', dt, false);
      for (const a of ACTIONS) if (a.id !== 'headLook') this.evaluate(a.id, dt, headLook);
    }
    this.presses.clear();
    this.synthetic.clear();
  }

  /** -1..1 for axis actions (keys + mouse + gamepad, deadzoned and clamped); 0 or 1 for button actions. */
  axis(id: ActionId): number {
    return this.values.get(id) ?? 0;
  }

  held(id: ActionId): boolean {
    return this.heldNow.has(id);
  }

  /** True on the frame the action was pressed (a press shorter than a frame still counts). */
  justPressed(id: ActionId): boolean {
    return (this.counts.get(id) ?? 0) > 0;
  }

  /** Presses this frame (e.g. several wheel notches). */
  pressCount(id: ActionId): number {
    return this.counts.get(id) ?? 0;
  }

  /**
   * Mouse movement this frame in CSS pixels, scaled by mouseSensitivity, with +y meaning "look up" (flipped by
   * invertY). Only reported while the pointer is locked or dragging on the target.
   */
  mouseDelta(): { x: number; y: number } {
    if (!this._enabled) return { x: 0, y: 0 };
    const s = this.settings.data.mouseSensitivity;
    const inv = this.settings.data.invertY ? -1 : 1;
    return { x: this.frameDx * s, y: -this.frameDy * s * inv };
  }

  requestPointerLock(): void {
    const el = this.target as HTMLElement & { requestPointerLock?: (o?: unknown) => unknown };
    if (!el.requestPointerLock || this.pointerLocked) return;
    this.releasingLock = false;
    const plain = (): void => {
      try {
        const r = el.requestPointerLock();
        if (r instanceof Promise) r.catch(() => undefined);
      } catch {
        // Needs a user gesture; the caller can retry on the next click.
      }
    };
    try {
      // Raw (unaccelerated) movement where the platform supports it.
      const r = el.requestPointerLock({ unadjustedMovement: true });
      if (r instanceof Promise) r.catch(plain);
    } catch {
      plain();
    }
  }

  releasePointerLock(): void {
    if (!this.pointerLocked) return;
    this.releasingLock = true;
    this.doc.exitPointerLock();
  }

  // --- Bindings -----------------------------------------------------------------------------------------------------

  binding(id: ActionId, slot: 0 | 1, context: InputContext = 'kbm'): Binding | null {
    const map = context === 'kbm' ? this.settings.data.bindings : this.settings.data.padBindings;
    return map[id]?.[slot] ?? null;
  }

  /**
   * Sets one slot. The context comes from the binding (or `context` when clearing, default keyboard/mouse).
   * Returns false when the binding is not allowed there (wrong kind, reserved input, or a fixed slot).
   */
  setBinding(id: ActionId, slot: 0 | 1, binding: Binding | null, context?: InputContext): boolean {
    const ctx = binding ? contextOf(binding) : (context ?? 'kbm');
    if (!bindingAllowed(ctx, id, slot, binding)) return false;
    if (ctx === 'kbm') this.settings.set({ bindings: withBinding(this.settings.data.bindings, id, slot, binding) });
    else this.settings.set({ padBindings: withBinding(this.settings.data.padBindings, id, slot, binding) });
    return true;
  }

  /** Restores default bindings for one context, or both. */
  resetDefaults(context?: InputContext): void {
    if (context === 'kbm') this.settings.set({ bindings: defaultBindings('kbm') });
    else if (context === 'pad') this.settings.set({ padBindings: defaultBindings('pad') });
    else this.settings.set({ bindings: defaultBindings('kbm'), padBindings: defaultBindings('pad') });
  }

  /** Inputs bound to more than one action, per context. */
  conflicts(): BindingConflict[] {
    return [...findConflicts(this.settings.data.bindings, 'kbm'), ...findConflicts(this.settings.data.padBindings, 'pad')];
  }

  /**
   * Captures the next key, mouse button, wheel notch, gamepad button or stick and binds it to (id, slot). Axis actions
   * take two keys or buttons (negative direction first) or one stick push toward the positive direction. Escape (or
   * the gamepad Menu button) cancels and resolves null. Starting another capture cancels this one.
   */
  beginRebind(id: ActionId, slot: 0 | 1, opts: RebindOptions = {}): Promise<Binding | null> {
    this.cancelRebind();
    // A slot fixed in one context can still be captured from the other one.
    const open = (['kbm', 'pad'] as const).filter((c) => (opts.context ?? c) === c && !isFixedSlot(c, id, slot));
    if (open.length === 0) return Promise.resolve(null);
    const ctx: InputContext | null = open.length === 1 ? open[0]! : null;
    return new Promise((resolve) => {
      const step: RebindStep = actionDef(id).kind === 'axis' ? 'neg' : 'any';
      const cap: Capture = {
        id,
        slot,
        context: ctx,
        step,
        opts,
        resolve,
        firstKey: null,
        firstPadButton: null,
        padHeld: this.currentPadDown(),
        raf: 0,
      };
      this.capture = cap;
      this.win.addEventListener('keydown', this.onCaptureKey, true);
      this.win.addEventListener('mousedown', this.onCaptureMouse, true);
      this.win.addEventListener('wheel', this.onCaptureWheel, { capture: true, passive: false });
      const tick = (): void => {
        if (this.capture !== cap) return;
        this.pollCapturePads();
        if (this.capture === cap) cap.raf = this.win.requestAnimationFrame(tick);
      };
      cap.raf = this.win.requestAnimationFrame(tick);
    });
  }

  cancelRebind(): void {
    this.endCapture(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRebind();
    for (const c of this.cleanups.splice(0)) c();
  }

  // --- Internals: evaluation ----------------------------------------------------------------------------------------

  private evaluate(id: ActionId, dt: number, headLookHeld: boolean): boolean {
    const def = actionDef(id);
    const bindings = [...(this.kbm.get(id) ?? []), ...(this.pad.get(id) ?? [])];
    let count = this.synthetic.get(id) ?? 0;
    let value = 0;
    let held = false;
    const invertY = this.settings.data.invertY;
    for (const b of bindings) {
      count += this.pressesOf(b);
      if (def.kind === 'axis') {
        let v = this.axisValue(b);
        if (id === 'pitch' && invertY && b.type === 'padAxis') v = -v;
        value += v;
      } else if (this.buttonDown(b)) held = true;
    }
    if (def.kind === 'axis') {
      if ((id === 'pitch' || id === 'yaw') && !headLookHeld && (this.frameDx !== 0 || this.frameDy !== 0)) {
        const rate = this.settings.data.mouseSensitivity / (Math.max(dt, 1 / 240) * MOUSE_FULL_SCALE_PX_PER_S);
        value += id === 'yaw' ? this.frameDx * rate : -this.frameDy * rate * (invertY ? -1 : 1);
      }
      value = Math.max(-1, Math.min(1, value));
      held = value !== 0;
      this.values.set(id, value);
    } else {
      this.values.set(id, held ? 1 : 0);
    }
    if (held) this.heldNow.add(id);
    if (count === 0 && held && !this.heldPrev.has(id)) count = 1;
    if (count > 0) this.counts.set(id, count);
    return held;
  }

  private pressesOf(b: Binding): number {
    const p = (k: string): number => this.presses.get(k) ?? 0;
    switch (b.type) {
      case 'key':
        return p(keyInput(b.code));
      case 'keyAxis':
        return p(keyInput(b.neg)) + p(keyInput(b.pos));
      case 'mouseButton':
        return p(mouseInput(b.button));
      case 'wheel':
        return p(wheelInput(b.dir));
      case 'padButton':
        return p(padButtonInput(b.button));
      case 'padButtonAxis':
        return p(padButtonInput(b.neg)) + p(padButtonInput(b.pos));
      case 'padAxis':
        return p(padAxisInput(b.axis, -1)) + p(padAxisInput(b.axis, 1));
      case 'padAxisDir':
        return p(padAxisInput(b.axis, b.dir));
    }
  }

  private buttonDown(b: Binding): boolean {
    switch (b.type) {
      case 'key':
        return this.keys.has(b.code);
      case 'mouseButton':
        return this.mouseButtons.has(b.button);
      case 'padButton':
        return this.padActive(padButtonInput(b.button));
      case 'padAxisDir':
        return this.padActive(padAxisInput(b.axis, b.dir));
      default:
        return false;
    }
  }

  private axisValue(b: Binding): number {
    switch (b.type) {
      case 'keyAxis':
        return (this.keys.has(b.pos) ? 1 : 0) - (this.keys.has(b.neg) ? 1 : 0);
      case 'padButtonAxis': {
        const v = (i: number): number => (this.padSuppressed.has(padButtonInput(i)) ? 0 : triggerValue(this.padFrame.buttons[i] ?? 0));
        return v(b.pos) - v(b.neg);
      }
      case 'padAxis': {
        if (this.padSuppressed.has(padAxisInput(b.axis, -1)) || this.padSuppressed.has(padAxisInput(b.axis, 1))) return 0;
        return this.stickValue(b.axis) * (b.invert ? -1 : 1);
      }
      default:
        return 0;
    }
  }

  private stickValue(axis: number): number {
    const a = this.padFrame.axes;
    if (axis <= 3) {
      const base = axis - (axis % 2);
      const [x, y] = stickPair(a[base] ?? 0, a[base + 1] ?? 0);
      return axis % 2 === 0 ? x : y;
    }
    const v = a[axis] ?? 0;
    return Math.abs(v) < PAD_STICK_DEADZONE ? 0 : Math.sign(v) * Math.min(1, (Math.abs(v) - PAD_STICK_DEADZONE) / (1 - PAD_STICK_DEADZONE));
  }

  private padActive(input: string): boolean {
    return this.padDown.has(input) && !this.padSuppressed.has(input);
  }

  // --- Internals: devices -------------------------------------------------------------------------------------------

  private readPads(): PadFrame {
    const frame: PadFrame = { buttons: [], axes: [] };
    let first: Gamepad | null = null;
    for (const p of this.getPads()) {
      if (!p?.connected) continue;
      first ??= p;
      p.buttons.forEach((b, i) => {
        frame.buttons[i] = Math.max(frame.buttons[i] ?? 0, b.pressed ? Math.max(b.value, PAD_PRESS + 0.01) : b.value);
      });
      p.axes.forEach((v, i) => {
        if (Math.abs(v) > Math.abs(frame.axes[i] ?? 0)) frame.axes[i] = v;
        else frame.axes[i] ??= 0;
      });
    }
    if (first) setPadStyle(padStyleFromId(first.id));
    return frame;
  }

  /** Down pad inputs (buttons and stick directions) with hysteresis. */
  private padInputsOf(frame: PadFrame, prev: ReadonlySet<string>, press = PAD_PRESS): Set<string> {
    const down = new Set<string>();
    frame.buttons.forEach((v, i) => {
      const id = padButtonInput(i);
      if (v > (prev.has(id) ? PAD_RELEASE : press)) down.add(id);
    });
    frame.axes.forEach((v, i) => {
      for (const dir of [-1, 1] as const) {
        const id = padAxisInput(i, dir);
        if (v * dir > (prev.has(id) ? PAD_RELEASE : press)) down.add(id);
      }
    });
    return down;
  }

  private currentPadDown(): Set<string> {
    return this.padInputsOf(this.readPads(), new Set(), PAD_RELEASE);
  }

  private pollPads(): void {
    this.padFrame = this.readPads();
    const now = this.padInputsOf(this.padFrame, this.padDown);
    for (const id of now) {
      if (this.padDown.has(id)) continue;
      if (!this._enabled || this.padSuppressed.has(id)) this.padSuppressed.add(id);
      else bump(this.presses, id);
      this.activeDevice = 'pad';
    }
    for (const id of this.padDown) if (!now.has(id)) this.padSuppressed.delete(id);
    this.padDown.clear();
    for (const id of now) this.padDown.add(id);
  }

  private clearState(): void {
    this.keys.clear();
    this.mouseButtons.clear();
    this.dragButtons.clear();
    this.presses.clear();
    this.synthetic.clear();
    this.wheelAccum = 0;
    this.rawDx = this.rawDy = this.frameDx = this.frameDy = 0;
    this.values.clear();
    this.counts.clear();
    this.heldNow = new Set();
    this.heldPrev = new Set();
    for (const id of this.padDown) this.padSuppressed.add(id);
  }

  private rebuildBindings(): void {
    const build = (map: Readonly<Record<string, readonly [Binding | null, Binding | null]>>): Map<ActionId, Binding[]> => {
      const out = new Map<ActionId, Binding[]>();
      for (const a of ACTIONS) out.set(a.id, (map[a.id] ?? [null, null]).filter((b): b is Binding => b !== null));
      return out;
    };
    this.kbm = build(this.settings.data.bindings);
    this.pad = build(this.settings.data.padBindings);
    this.kbmCodes = new Set();
    this.kbmMouseButtons = new Set();
    for (const list of this.kbm.values()) {
      for (const b of list) {
        if (b.type === 'key') this.kbmCodes.add(b.code);
        else if (b.type === 'keyAxis') {
          this.kbmCodes.add(b.neg);
          this.kbmCodes.add(b.pos);
        } else if (b.type === 'mouseButton') this.kbmMouseButtons.add(b.button);
      }
    }
  }

  private listen(t: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    t.addEventListener(type, fn, opts);
    this.cleanups.push(() => t.removeEventListener(type, fn, opts));
  }

  private readonly onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    // During a rebind capture the key belongs to the capture, whatever order listeners run in.
    if (!this._enabled || this.capture || e.isComposing || !e.code) return;
    if (isEditable(e.target) || isEditable(this.doc.activeElement)) return;
    if ((e.ctrlKey || e.metaKey) && !MODIFIER_CODES.has(e.code)) return;
    if (this.kbmCodes.has(e.code)) e.preventDefault();
    this.activeDevice = 'kbm';
    if (!e.repeat && !this.keys.has(e.code)) bump(this.presses, keyInput(e.code));
    this.keys.add(e.code);
  };

  private readonly onKeyUp = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    // macOS sends no keyup for keys released while Cmd is held.
    if (e.code === 'MetaLeft' || e.code === 'MetaRight') this.keys.clear();
    this.keys.delete(e.code);
    if (this._enabled && this.kbmCodes.has(e.code) && !isEditable(e.target)) e.preventDefault();
  };

  private readonly onBlur = (): void => {
    this.clearState();
  };

  private readonly onVisibility = (): void => {
    if (this.doc.visibilityState === 'hidden') this.clearState();
  };

  private readonly onMouseDown = (ev: Event): void => {
    const e = ev as MouseEvent;
    if (!this._enabled || this.capture) return;
    this.activeDevice = 'kbm';
    this.dragButtons.add(e.button);
    if (!this.mouseButtons.has(e.button)) bump(this.presses, mouseInput(e.button));
    this.mouseButtons.add(e.button);
    // Stop text selection and middle-click autoscroll on the game view.
    if (e.button !== 0 || this.kbmMouseButtons.has(e.button)) e.preventDefault();
  };

  private readonly onMouseUp = (ev: Event): void => {
    const e = ev as MouseEvent;
    this.mouseButtons.delete(e.button);
    this.dragButtons.delete(e.button);
  };

  private readonly onMouseMove = (ev: Event): void => {
    const e = ev as MouseEvent;
    if (!this._enabled || (!this.pointerLocked && this.dragButtons.size === 0)) return;
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    if (Math.abs(dx) > MOUSE_SPIKE_PX || Math.abs(dy) > MOUSE_SPIKE_PX) return;
    this.rawDx += dx;
    this.rawDy += dy;
  };

  private readonly onWheel = (ev: Event): void => {
    const e = ev as WheelEvent;
    if (!this._enabled || this.capture || e.ctrlKey) return; // Ctrl+wheel is browser zoom.
    e.preventDefault();
    this.activeDevice = 'kbm';
    const px = e.deltaMode === 1 ? e.deltaY * (WHEEL_NOTCH_PX / 3) : e.deltaMode === 2 ? e.deltaY * WHEEL_NOTCH_PX : e.deltaY;
    // A direction change discards the partial notch so reversing feels immediate.
    if (Math.sign(px) !== Math.sign(this.wheelAccum)) this.wheelAccum = 0;
    this.wheelAccum += px;
    while (Math.abs(this.wheelAccum) >= WHEEL_NOTCH_PX) {
      const dir = this.wheelAccum < 0 ? -1 : 1;
      bump(this.presses, wheelInput(dir));
      this.wheelAccum -= dir * WHEEL_NOTCH_PX;
    }
  };

  private readonly onContextMenu = (ev: Event): void => {
    ev.preventDefault();
  };

  private readonly onPointerLockChange = (): void => {
    const locked = this.pointerLocked;
    if (!locked) {
      if (this.wasLocked && !this.releasingLock && this.pauseOnPointerLockLoss && this._enabled) this.synthetic.set('pause', 1);
      this.releasingLock = false;
      this.dragButtons.clear();
    }
    this.wasLocked = locked;
  };

  // --- Internals: rebind capture ------------------------------------------------------------------------------------

  private readonly onCaptureKey = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    const cap = this.capture;
    if (!cap) return;
    if (e.code === 'Escape') {
      swallow(e);
      this.swallowNext(['keyup'], (x) => (x as KeyboardEvent).code === 'Escape');
      this.endCapture(null);
      return;
    }
    if (cap.context === 'pad' || cap.firstPadButton !== null || !e.code || e.isComposing) return;
    swallow(e);
    if (e.repeat) return;
    const code = e.code;
    this.swallowNext(['keyup'], (x) => (x as KeyboardEvent).code === code);
    if (RESERVED_INPUTS.has(keyInput(code))) return;
    if (cap.step === 'any') this.endCapture({ type: 'key', code });
    else if (cap.step === 'neg') {
      cap.firstKey = code;
      this.setStep(cap, 'pos');
    } else if (cap.firstKey !== null && code !== cap.firstKey) this.endCapture({ type: 'keyAxis', neg: cap.firstKey, pos: code });
  };

  private readonly onCaptureMouse = (ev: Event): void => {
    const e = ev as MouseEvent;
    const cap = this.capture;
    if (!cap) return;
    const within = isWithin(cap.opts.mouseTarget, e.target);
    if (!within) {
      this.endCapture(null); // Clicking elsewhere cancels; the click itself proceeds normally.
      return;
    }
    swallow(e);
    // Only the follow-ups of this button: a later click with another button must still work.
    const button = e.button;
    this.swallowNext(['mouseup', 'click', 'auxclick', 'contextmenu'], (x) => x.type === 'contextmenu' ? button === 2 : (x as MouseEvent).button === button);
    if (cap.context === 'pad' || cap.step !== 'any') return; // Mouse buttons cannot drive axes.
    this.endCapture({ type: 'mouseButton', button: e.button });
  };

  private readonly onCaptureWheel = (ev: Event): void => {
    const e = ev as WheelEvent;
    const cap = this.capture;
    if (!cap || cap.context === 'pad' || cap.step !== 'any' || e.deltaY === 0) return;
    const within = isWithin(cap.opts.mouseTarget, e.target);
    if (!within) return;
    swallow(e);
    this.endCapture({ type: 'wheel', dir: e.deltaY < 0 ? -1 : 1 });
  };

  private pollCapturePads(): void {
    const cap = this.capture;
    if (!cap || cap.context === 'kbm' || cap.firstKey !== null) return;
    const frame = this.readPads();
    const down = this.padInputsOf(frame, new Set(), PAD_RELEASE);
    for (const id of [...cap.padHeld]) if (!down.has(id)) cap.padHeld.delete(id);
    // Buttons first: a trigger also reports an axis on some pads.
    for (let i = 0; i < frame.buttons.length; i++) {
      const id = padButtonInput(i);
      if ((frame.buttons[i] ?? 0) <= PAD_PRESS || cap.padHeld.has(id)) continue;
      cap.padHeld.add(id);
      if (i === PAD.MENU) {
        this.endCapture(null);
        return;
      }
      if (cap.step === 'any') this.endCapture({ type: 'padButton', button: i });
      else if (cap.step === 'neg') {
        cap.firstPadButton = i;
        this.setStep(cap, 'pos');
      } else if (cap.firstPadButton !== null && i !== cap.firstPadButton) {
        this.endCapture({ type: 'padButtonAxis', neg: cap.firstPadButton, pos: i });
      }
      return;
    }
    for (let i = 0; i < frame.axes.length; i++) {
      const v = frame.axes[i] ?? 0;
      const dir: -1 | 1 = v < 0 ? -1 : 1;
      const id = padAxisInput(i, dir);
      if (Math.abs(v) < PAD_CAPTURE_AXIS || cap.padHeld.has(id)) continue;
      cap.padHeld.add(id);
      // Axis actions ask for a push toward the positive direction.
      if (cap.step === 'any') this.endCapture({ type: 'padAxisDir', axis: i, dir });
      else this.endCapture({ type: 'padAxis', axis: i, invert: dir < 0 });
      return;
    }
  }

  private setStep(cap: Capture, step: RebindStep): void {
    cap.step = step;
    cap.opts.onStep?.(step);
  }

  private endCapture(b: Binding | null): void {
    const cap = this.capture;
    if (!cap) return;
    this.capture = null;
    this.win.cancelAnimationFrame(cap.raf);
    this.win.removeEventListener('keydown', this.onCaptureKey, true);
    this.win.removeEventListener('mousedown', this.onCaptureMouse, true);
    this.win.removeEventListener('wheel', this.onCaptureWheel, { capture: true });
    // Inputs used for capturing must not leak into the game when it resumes.
    for (const id of this.padDown) this.padSuppressed.add(id);
    const ok = b !== null && this.setBinding(cap.id, cap.slot, b);
    cap.resolve(ok ? b : null);
  }

  /** Swallows the follow-up events of a captured input (e.g. the keyup of Space would click the focused button). */
  private swallowNext(types: string[], match: (e: Event) => boolean): void {
    const handlers: [string, (e: Event) => void][] = [];
    const done = (): void => {
      for (const [type, fn] of handlers) this.win.removeEventListener(type, fn, true);
      clearTimeout(timer);
    };
    for (const type of types) {
      const fn = (e: Event): void => {
        if (!match(e)) return;
        swallow(e);
        if (type === 'keyup' || type === 'click' || type === 'auxclick') done();
      };
      handlers.push([type, fn]);
      this.win.addEventListener(type, fn, true);
    }
    const timer = setTimeout(done, 1500);
  }
}

/** True when there is no capture area, or the event target lies inside it. */
function isWithin(area: Element | null | undefined, target: EventTarget | null): boolean {
  if (!area) return true;
  return typeof Node !== 'undefined' && target instanceof Node && area.contains(target);
}

function swallow(e: Event): void {
  e.preventDefault();
  e.stopImmediatePropagation();
}
