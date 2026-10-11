import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ACTION_IDS,
  DEFAULT_KBM,
  DEFAULT_PAD,
  PAD,
  bindingAllowed,
  defaultBindings,
  findConflicts,
  type ActionId,
} from '../../src/game/input/actions';
import { contextOf, inputsOf, isAxisBinding, parseBinding, type Binding, type BindingMap } from '../../src/game/input/bindings';
import { InputManager, PAD_STICK_DEADZONE } from '../../src/game/input/inputManager';
import { bindingLabel, inputLabel, keyLabel, setKeyboardLayout, setPadStyle } from '../../src/game/input/labels';
import { GamepadMenuNav, pickSpatial } from '../../src/game/input/menuNav';
import { hasKey } from '../../src/game/i18n';
import { Settings, withBinding } from '../../src/game/settings/settings';

// --- Minimal DOM doubles (Vitest runs in node) -------------------------------------------------------------------------

interface FakePad {
  id: string;
  connected: boolean;
  mapping: string;
  axes: number[];
  buttons: { pressed: boolean; value: number; touched: boolean }[];
}

function makePad(): FakePad {
  return {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })),
  };
}

function press(pad: FakePad, b: number, value = 1): void {
  pad.buttons[b] = { pressed: value > 0.5, value, touched: value > 0 };
}

interface FakeDoc extends EventTarget {
  defaultView: unknown;
  activeElement: unknown;
  pointerLockElement: unknown;
  visibilityState: string;
  exitPointerLock(): void;
}

function setup(opts: { pads?: FakePad[] } = {}) {
  const raf: FrameRequestCallback[] = [];
  const win = Object.assign(new EventTarget(), {
    navigator: {},
    requestAnimationFrame: (cb: FrameRequestCallback) => raf.push(cb),
    cancelAnimationFrame: () => undefined,
  });
  const doc: FakeDoc = Object.assign(new EventTarget(), {
    defaultView: win,
    activeElement: null,
    pointerLockElement: null,
    visibilityState: 'visible',
    exitPointerLock() {
      doc.pointerLockElement = null;
      doc.dispatchEvent(new Event('pointerlockchange'));
    },
  });
  const target = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    tagName: 'CANVAS',
    requestPointerLock() {
      doc.pointerLockElement = target;
      doc.dispatchEvent(new Event('pointerlockchange'));
    },
  });
  const settings = new Settings({ storage: null, env: { prefersReducedMotion: false, prefersMoreContrast: false } });
  const pads = opts.pads ?? [];
  const input = new InputManager(target as unknown as HTMLElement, settings, {
    getGamepads: () => pads as unknown as Gamepad[],
  });
  const key = (type: 'keydown' | 'keyup', code: string, extra: Record<string, unknown> = {}): Event => {
    const e = Object.assign(new Event(type, { cancelable: true }), { code, key: code, repeat: false, ctrlKey: false, metaKey: false, isComposing: false, ...extra });
    win.dispatchEvent(e);
    return e;
  };
  const down = (code: string, extra: Record<string, unknown> = {}): Event => key('keydown', code, extra);
  const up = (code: string): Event => key('keyup', code);
  const mouse = (type: string, init: Record<string, unknown>, on: EventTarget = win): Event => {
    const e = Object.assign(new Event(type, { cancelable: true }), { button: 0, movementX: 0, movementY: 0, ...init });
    on.dispatchEvent(e);
    return e;
  };
  const wheel = (deltaY: number): void => {
    target.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY, deltaMode: 0, ctrlKey: false }));
  };
  const flushRaf = (): void => {
    for (const cb of raf.splice(0)) cb(0);
  };
  return { win, doc, target, settings, input, down, up, mouse, wheel, pads, flushRaf };
}

const tick = async (): Promise<void> => {
  await Promise.resolve();
};

// --- Action map and defaults -------------------------------------------------------------------------------------------

describe('action map', () => {
  it('defines every action once with a label, kind and category', () => {
    expect(ACTIONS.map((a) => a.id)).toEqual([...ACTION_IDS]);
    for (const a of ACTIONS) {
      expect(hasKey(a.label), a.label).toBe(true);
      expect(hasKey(`input.category.${a.category}`)).toBe(true);
      if (a.kind === 'axis') {
        expect(hasKey(a.neg!), a.neg).toBe(true);
        expect(hasKey(a.pos!), a.pos).toBe(true);
      }
    }
  });

  it('includes the actions the game needs', () => {
    for (const id of ['pitch', 'yaw', 'roll', 'thrust', 'strafeX', 'strafeY', 'throttleUp', 'throttleDown', 'throttleZero', 'boost', 'modeNext', 'modePrev', 'targetNext', 'targetPrev', 'targetReticle', 'autoAlign', 'hyperspeed', 'flightAssist', 'landAssist', 'toggleMap', 'toggleCodex', 'howWeKnow', 'screenshot', 'toggleHud', 'toggleView', 'headLook', 'share', 'pause']) {
      expect(ACTION_IDS).toContain(id);
    }
    for (const id of ['pitch', 'yaw', 'roll', 'thrust', 'strafeX', 'strafeY'] as const) expect(ACTIONS.find((a) => a.id === id)!.kind).toBe('axis');
  });

  it('binds every action on keyboard and mouse by default', () => {
    for (const a of ACTIONS) expect(DEFAULT_KBM[a.id].some((b) => b !== null), a.id).toBe(true);
  });

  it('binds flight, drive, targeting and pause on the gamepad by default', () => {
    for (const id of ['pitch', 'yaw', 'roll', 'thrust', 'strafeX', 'strafeY', 'boost', 'modeNext', 'modePrev', 'hyperspeed', 'targetNext', 'targetReticle', 'toggleMap', 'pause'] as const) {
      expect(DEFAULT_PAD[id].some((b) => b !== null), id).toBe(true);
    }
  });

  it('has no input used twice within a context', () => {
    expect(findConflicts(defaultBindings('kbm'), 'kbm')).toEqual([]);
    expect(findConflicts(defaultBindings('pad'), 'pad')).toEqual([]);
    for (const ctx of ['kbm', 'pad'] as const) {
      const seen = new Map<string, string>();
      for (const a of ACTIONS) {
        for (const b of defaultBindings(ctx)[a.id]!) {
          if (!b) continue;
          for (const i of inputsOf(b)) {
            expect(seen.has(i), `${i} used by ${seen.get(i)} and ${a.id}`).toBe(false);
            seen.set(i, a.id);
          }
        }
      }
    }
  });

  it('uses the requested keyboard layout', () => {
    const k = DEFAULT_KBM;
    expect(k.thrust[0]).toEqual({ type: 'keyAxis', neg: 'KeyS', pos: 'KeyW' });
    expect(k.yaw[0]).toEqual({ type: 'keyAxis', neg: 'KeyA', pos: 'KeyD' });
    expect(k.yaw[1]).toEqual({ type: 'keyAxis', neg: 'ArrowLeft', pos: 'ArrowRight' });
    expect(k.roll[0]).toEqual({ type: 'keyAxis', neg: 'KeyQ', pos: 'KeyE' });
    expect(k.pitch[0]).toEqual({ type: 'keyAxis', neg: 'ArrowDown', pos: 'ArrowUp' });
    expect(k.strafeY[0]).toEqual({ type: 'keyAxis', neg: 'KeyF', pos: 'KeyR' });
    const single: [ActionId, string][] = [
      ['boost', 'ShiftLeft'],
      ['targetNext', 'Tab'],
      ['targetReticle', 'KeyT'],
      ['hyperspeed', 'KeyJ'],
      ['toggleMap', 'KeyM'],
      ['toggleCodex', 'KeyC'],
      ['howWeKnow', 'KeyI'],
      ['screenshot', 'KeyP'],
      ['toggleHud', 'KeyH'],
      ['toggleView', 'KeyV'],
      ['pause', 'Escape'],
    ];
    for (const [id, code] of single) expect(k[id][0], id).toEqual({ type: 'key', code });
    expect(k.headLook[0]).toEqual({ type: 'mouseButton', button: 2 });
    expect(k.throttleUp).toContainEqual({ type: 'wheel', dir: -1 });
    expect(k.throttleDown).toContainEqual({ type: 'wheel', dir: 1 });
  });

  it('only allows bindings of the right kind, device and reserved inputs', () => {
    for (const ctx of ['kbm', 'pad'] as const) {
      const map = defaultBindings(ctx);
      for (const a of ACTIONS) for (const slot of [0, 1] as const) expect(bindingAllowed(ctx, a.id, slot, map[a.id]![slot]), `${ctx} ${a.id}`).toBe(true);
    }
    expect(bindingAllowed('kbm', 'thrust', 0, { type: 'key', code: 'KeyW' })).toBe(false); // axis needs an axis binding
    expect(bindingAllowed('kbm', 'boost', 0, { type: 'keyAxis', neg: 'KeyA', pos: 'KeyB' })).toBe(false);
    expect(bindingAllowed('kbm', 'boost', 0, { type: 'padButton', button: 0 })).toBe(false); // wrong context
    expect(bindingAllowed('kbm', 'toggleMap', 0, { type: 'key', code: 'Escape' })).toBe(false); // reserved
    expect(bindingAllowed('kbm', 'pause', 0, { type: 'key', code: 'KeyP' })).toBe(false); // fixed slot
    expect(bindingAllowed('kbm', 'pause', 0, null)).toBe(false); // Escape can never be unbound
    expect(bindingAllowed('kbm', 'pause', 1, { type: 'key', code: 'KeyO' })).toBe(true);
    expect(bindingAllowed('pad', 'toggleMap', 0, { type: 'padButton', button: PAD.MENU })).toBe(false);
  });
});

describe('conflict detection', () => {
  it('reports inputs shared by two actions, once per input', () => {
    let map: BindingMap = defaultBindings('kbm');
    map = withBinding(map, 'toggleCodex', 1, { type: 'key', code: 'KeyW' });
    const c = findConflicts(map, 'kbm');
    expect(c).toEqual([{ context: 'kbm', binding: 'key:KeyW', actions: ['thrust', 'toggleCodex'] }]);
  });

  it('treats the same input in both slots of one action as no conflict', () => {
    const map = withBinding(defaultBindings('kbm'), 'boost', 1, { type: 'key', code: 'ShiftLeft' });
    expect(findConflicts(map, 'kbm')).toEqual([]);
  });

  it('detects stick halves shared between an axis and a button', () => {
    const map = withBinding(defaultBindings('pad'), 'toggleCodex', 0, { type: 'padAxisDir', axis: 2, dir: 1 });
    const c = findConflicts(map, 'pad');
    expect(c).toHaveLength(1);
    expect(c[0]!.binding).toBe('pad:a2+');
    expect(c[0]!.actions.sort()).toEqual(['toggleCodex', 'yaw']);
  });

  it('keeps contexts separate', () => {
    const { input } = setup();
    expect(input.conflicts()).toEqual([]);
    expect(input.setBinding('toggleCodex', 1, { type: 'key', code: 'KeyW' })).toBe(true);
    expect(input.setBinding('toggleCodex', 0, { type: 'padButton', button: PAD.A }, 'pad')).toBe(true);
    const c = input.conflicts();
    expect(c.map((x) => `${x.context}:${x.binding}`).sort()).toEqual(['kbm:key:KeyW', 'pad:pad:b0']);
  });
});

describe('bindings', () => {
  it('parses valid bindings and rejects junk', () => {
    expect(parseBinding({ type: 'key', code: 'KeyW' })).toEqual({ type: 'key', code: 'KeyW' });
    expect(parseBinding({ type: 'keyAxis', neg: 'KeyS', pos: 'KeyW', extra: 1 })).toEqual({ type: 'keyAxis', neg: 'KeyS', pos: 'KeyW' });
    expect(parseBinding({ type: 'padAxis', axis: 3, invert: true })).toEqual({ type: 'padAxis', axis: 3, invert: true });
    for (const junk of [null, 1, 'KeyW', [], {}, { type: 'key' }, { type: 'key', code: '<script>' }, { type: 'keyAxis', neg: 'KeyA', pos: 'KeyA' }, { type: 'mouseButton', button: 9 }, { type: 'wheel', dir: 0 }, { type: 'padAxis', axis: 1 }, { type: 'nope' }]) {
      expect(parseBinding(junk), JSON.stringify(junk)).toBeNull();
    }
  });

  it('classifies context and axis bindings', () => {
    const b: Binding = { type: 'padButtonAxis', neg: 6, pos: 7 };
    expect(contextOf(b)).toBe('pad');
    expect(isAxisBinding(b)).toBe(true);
    expect(contextOf({ type: 'wheel', dir: -1 })).toBe('kbm');
    expect(inputsOf({ type: 'padAxis', axis: 1, invert: true })).toEqual(['pad:a1-', 'pad:a1+']);
  });

  it('labels keys, mouse and pads', () => {
    setKeyboardLayout(null);
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('ArrowUp', 'long')).toBe('Up arrow');
    expect(keyLabel('Minus')).toBe('-');
    expect(keyLabel('ShiftLeft', 'long')).toBe('Left Shift');
    expect(bindingLabel({ type: 'keyAxis', neg: 'KeyS', pos: 'KeyW' })).toBe('S / W');
    expect(bindingLabel({ type: 'mouseButton', button: 2 }, 'long')).toBe('Right mouse button');
    expect(bindingLabel(null)).toBe('Not bound');
    setKeyboardLayout(new Map([['KeyY', 'z']]));
    expect(keyLabel('KeyY')).toBe('Z'); // A German layout prints Z on the KeyY position.
    setKeyboardLayout(null);
    setPadStyle('playstation');
    expect(bindingLabel({ type: 'padButton', button: 0 }, 'long')).toBe('Cross button');
    setPadStyle('xbox');
    expect(bindingLabel({ type: 'padButton', button: 0 })).toBe('A');
    expect(bindingLabel({ type: 'padButtonAxis', neg: 6, pos: 7 })).toBe('LT / RT');
    expect(inputLabel('pad:a2+')).toBe('R stick →');
  });
});

// --- InputManager -----------------------------------------------------------------------------------------------------

describe('InputManager', () => {
  it('combines key pairs into axes', () => {
    const { input, down, up } = setup();
    down('KeyW');
    input.update(1 / 60);
    expect(input.axis('thrust')).toBe(1);
    expect(input.held('thrust')).toBe(true);
    down('KeyS');
    input.update(1 / 60);
    expect(input.axis('thrust')).toBe(0);
    up('KeyW');
    input.update(1 / 60);
    expect(input.axis('thrust')).toBe(-1);
    down('KeyD');
    down('ArrowRight');
    input.update(1 / 60);
    expect(input.axis('yaw')).toBe(1); // clamped
  });

  it('reports presses for one frame, and taps shorter than a frame', () => {
    const { input, down, up } = setup();
    down('KeyT');
    input.update(1 / 60);
    expect(input.justPressed('targetReticle')).toBe(true);
    expect(input.held('targetReticle')).toBe(true);
    down('KeyT', { repeat: true });
    input.update(1 / 60);
    expect(input.justPressed('targetReticle')).toBe(false);
    expect(input.held('targetReticle')).toBe(true);
    up('KeyT');
    down('KeyM');
    up('KeyM');
    input.update(1 / 60);
    expect(input.justPressed('toggleMap')).toBe(true);
    expect(input.held('toggleMap')).toBe(false);
    input.update(1 / 60);
    expect(input.justPressed('toggleMap')).toBe(false);
  });

  it('prevents browser defaults only for bound keys', () => {
    const { down } = setup();
    expect(down('Tab').defaultPrevented).toBe(true);
    expect(down('Space').defaultPrevented).toBe(true);
    expect(down('KeyU').defaultPrevented).toBe(false);
  });

  it('clears state on blur and when hidden', () => {
    const { input, down, win, doc } = setup();
    down('KeyW');
    win.dispatchEvent(new Event('blur'));
    input.update(1 / 60);
    expect(input.axis('thrust')).toBe(0);
    down('KeyW');
    input.update(1 / 60);
    expect(input.axis('thrust')).toBe(1);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    input.update(1 / 60);
    expect(input.axis('thrust')).toBe(0);
  });

  it('ignores keys while a text field has focus, and browser shortcuts', () => {
    const { input, down, doc } = setup();
    doc.activeElement = { tagName: 'INPUT', type: 'text' };
    down('KeyW');
    input.update(1 / 60);
    expect(input.axis('thrust')).toBe(0);
    doc.activeElement = { tagName: 'INPUT', type: 'checkbox' };
    down('KeyW');
    input.update(1 / 60);
    expect(input.axis('thrust')).toBe(1);
    doc.activeElement = null;
    const e = down('KeyC', { ctrlKey: true });
    input.update(1 / 60);
    expect(input.justPressed('toggleCodex')).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it('reads as idle while disabled', () => {
    const { input, down } = setup();
    input.enabled = false;
    down('KeyW');
    input.update(1 / 60);
    expect(input.axis('thrust')).toBe(0);
    input.enabled = true;
    down('KeyW', { repeat: true }); // still held after the menu closed: counts as held, not as a new press
    input.update(1 / 60);
    expect(input.axis('thrust')).toBe(1);
    expect(input.justPressed('thrust')).toBe(true); // rising edge of the axis
  });

  it('turns locked mouse movement into pitch and yaw, except during head look', () => {
    const { input, mouse, target, settings } = setup();
    mouse('mousemove', { movementX: 20, movementY: 0 });
    input.update(1 / 60);
    expect(input.axis('yaw')).toBe(0); // not locked, not dragging
    input.requestPointerLock();
    expect(input.pointerLocked).toBe(true);
    mouse('mousemove', { movementX: 10, movementY: -10 });
    input.update(1 / 60);
    expect(input.axis('yaw')).toBeGreaterThan(0);
    expect(input.axis('pitch')).toBeGreaterThan(0); // mouse up = nose up
    expect(input.mouseDelta()).toEqual({ x: 10, y: 10 });
    settings.set({ invertY: true, mouseSensitivity: 2 });
    mouse('mousemove', { movementX: 0, movementY: -10 });
    input.update(1 / 60);
    expect(input.axis('pitch')).toBeLessThan(0);
    expect(input.mouseDelta()).toEqual({ x: 0, y: -20 });
    mouse('mousedown', { button: 2 }, target); // right button = head look
    mouse('mousemove', { movementX: 30, movementY: 0 });
    input.update(1 / 60);
    expect(input.held('headLook')).toBe(true);
    expect(input.axis('yaw')).toBe(0);
    expect(input.mouseDelta().x).toBe(60);
  });

  it('opens the pause menu when the browser drops pointer lock', () => {
    const { input, doc } = setup();
    input.requestPointerLock();
    input.update(1 / 60);
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
    input.update(1 / 60);
    expect(input.justPressed('pause')).toBe(true);
    input.requestPointerLock();
    input.releasePointerLock(); // a deliberate release is not a pause
    input.update(1 / 60);
    expect(input.justPressed('pause')).toBe(false);
  });

  it('counts wheel notches as throttle presses', () => {
    const { input, wheel } = setup();
    wheel(-100);
    wheel(-60);
    wheel(-60);
    input.update(1 / 60);
    expect(input.pressCount('throttleUp')).toBe(2);
    wheel(100);
    input.update(1 / 60);
    expect(input.justPressed('throttleDown')).toBe(true);
    expect(input.justPressed('throttleUp')).toBe(false);
  });

  it('reads gamepad sticks with a deadzone, triggers and buttons', () => {
    const pad = makePad();
    const { input } = setup({ pads: [pad] });
    pad.axes = [0, 0, PAD_STICK_DEADZONE * 0.8, 0];
    input.update(1 / 60);
    expect(input.axis('yaw')).toBe(0);
    pad.axes = [0, 0, 1, 0];
    input.update(1 / 60);
    expect(input.axis('yaw')).toBeCloseTo(1, 5);
    pad.axes = [0, 0, 0, -1]; // stick up
    input.update(1 / 60);
    expect(input.axis('pitch')).toBeCloseTo(1, 5); // up = nose up
    press(pad, PAD.RT, 0.6);
    input.update(1 / 60);
    expect(input.axis('thrust')).toBeGreaterThan(0.5);
    expect(input.axis('thrust')).toBeLessThan(0.6);
    press(pad, PAD.Y);
    input.update(1 / 60);
    expect(input.justPressed('hyperspeed')).toBe(true);
    expect(input.activeDevice).toBe('pad');
    input.update(1 / 60);
    expect(input.justPressed('hyperspeed')).toBe(false);
    expect(input.held('hyperspeed')).toBe(true);
  });

  it('ignores a gamepad button held across a menu until it is released', () => {
    const pad = makePad();
    const { input } = setup({ pads: [pad] });
    press(pad, PAD.MENU);
    input.update(1 / 60);
    expect(input.justPressed('pause')).toBe(true);
    input.enabled = false; // menu opens
    input.update(1 / 60);
    input.enabled = true; // menu closes while Menu is still down
    input.update(1 / 60);
    expect(input.justPressed('pause')).toBe(false);
    expect(input.held('pause')).toBe(false);
    press(pad, PAD.MENU, 0);
    input.update(1 / 60);
    press(pad, PAD.MENU);
    input.update(1 / 60);
    expect(input.justPressed('pause')).toBe(true);
  });

  it('applies invertY to gamepad pitch', () => {
    const pad = makePad();
    const { input, settings } = setup({ pads: [pad] });
    settings.set({ invertY: true });
    pad.axes = [0, 0, 0, -1];
    input.update(1 / 60);
    expect(input.axis('pitch')).toBeCloseTo(-1, 5);
  });
});

describe('rebinding', () => {
  it('captures the next key, saves it and swallows the event', async () => {
    const { input, down, settings } = setup();
    const p = input.beginRebind('toggleMap', 0);
    expect(input.rebinding).toEqual({ id: 'toggleMap', slot: 0, context: null, step: 'any' }); // any device
    const e = down('KeyO');
    expect(e.defaultPrevented).toBe(true);
    await expect(p).resolves.toEqual({ type: 'key', code: 'KeyO' });
    expect(settings.data.bindings['toggleMap']![0]).toEqual({ type: 'key', code: 'KeyO' });
    expect(input.rebinding).toBeNull();
    // The captured key press did not leak into the game.
    input.update(1 / 60);
    expect(input.justPressed('toggleMap')).toBe(false);
  });

  it('cancels on Escape without changing anything', async () => {
    const { input, down, settings } = setup();
    const before = settings.data.bindings['toggleMap'];
    const p = input.beginRebind('toggleMap', 0);
    down('Escape');
    await expect(p).resolves.toBeNull();
    expect(settings.data.bindings['toggleMap']).toEqual(before);
  });

  it('captures two keys for an axis, negative first', async () => {
    const { input, down } = setup();
    const steps: string[] = [];
    const p = input.beginRebind('roll', 1, { context: 'kbm', onStep: (s) => steps.push(s) });
    down('KeyN');
    expect(steps).toEqual(['pos']);
    down('KeyN'); // the same key again is ignored
    down('KeyU');
    await expect(p).resolves.toEqual({ type: 'keyAxis', neg: 'KeyN', pos: 'KeyU' });
    expect(input.binding('roll', 1)).toEqual({ type: 'keyAxis', neg: 'KeyN', pos: 'KeyU' });
  });

  it('never captures or unbinds Escape', async () => {
    const { input, down } = setup();
    await expect(input.beginRebind('pause', 0)).resolves.toBeNull();
    expect(input.setBinding('pause', 0, { type: 'key', code: 'KeyP' })).toBe(false);
    expect(input.setBinding('pause', 0, null)).toBe(false);
    expect(input.setBinding('toggleMap', 0, { type: 'key', code: 'Escape' })).toBe(false);
    expect(input.binding('pause', 0)).toEqual({ type: 'key', code: 'Escape' });
    // The second pause slot is free, and Escape still cancels its capture.
    const p = input.beginRebind('pause', 1, { context: 'kbm' });
    down('Escape');
    await expect(p).resolves.toBeNull();
  });

  it('captures gamepad sticks and buttons', async () => {
    const pad = makePad();
    const { input, flushRaf } = setup({ pads: [pad] });
    const p = input.beginRebind('yaw', 1, { context: 'pad' });
    pad.axes = [0.9, 0, 0, 0];
    flushRaf();
    await expect(p).resolves.toEqual({ type: 'padAxis', axis: 0, invert: false });
    pad.axes = [0, 0, 0, 0];
    press(pad, PAD.A); // held when the next capture starts: ignored until released
    const q = input.beginRebind('share', 0, { context: 'pad' });
    input.update(1 / 60);
    expect(input.rebinding).not.toBeNull();
    press(pad, PAD.A, 0);
    input.update(1 / 60);
    press(pad, PAD.B);
    input.update(1 / 60);
    await expect(q).resolves.toEqual({ type: 'padButton', button: PAD.B });
    expect(input.binding('share', 0, 'pad')).toEqual({ type: 'padButton', button: PAD.B });
  });

  it('cancels a gamepad capture with Menu, and a new capture replaces the old one', async () => {
    const pad = makePad();
    const { input } = setup({ pads: [pad] });
    const first = input.beginRebind('share', 0, { context: 'pad' });
    const second = input.beginRebind('share', 1, { context: 'pad' });
    await expect(first).resolves.toBeNull();
    press(pad, PAD.MENU);
    input.update(1 / 60);
    await expect(second).resolves.toBeNull();
    await tick();
  });

  it('resets to defaults per context', () => {
    const { input, settings } = setup();
    input.setBinding('toggleMap', 0, { type: 'key', code: 'KeyO' });
    input.setBinding('toggleMap', 1, { type: 'padButton', button: 3 });
    input.resetDefaults('kbm');
    expect(settings.data.bindings).toEqual(defaultBindings('kbm'));
    expect(settings.data.padBindings['toggleMap']![1]).toEqual({ type: 'padButton', button: 3 });
    input.resetDefaults();
    expect(settings.data.padBindings).toEqual(defaultBindings('pad'));
  });

  it('follows bindings changed through settings', () => {
    const { input, down, settings } = setup();
    settings.set({ bindings: withBinding(settings.data.bindings, 'toggleMap', 1, { type: 'key', code: 'KeyN' }) });
    down('KeyN');
    input.update(1 / 60);
    expect(input.justPressed('toggleMap')).toBe(true);
  });

  it('stops listening after dispose', () => {
    const { input, down } = setup();
    input.dispose();
    down('KeyW');
    input.update(1 / 60);
    expect(input.axis('thrust')).toBe(0);
  });
});

// --- Menu navigation --------------------------------------------------------------------------------------------------

describe('menu navigation', () => {
  const r = (left: number, top: number, w = 100, h = 30) => ({ left, top, right: left + w, bottom: top + h });

  it('moves within a column and across columns', () => {
    // Two-column grid of slots: [a0 a1] / [b0 b1]
    const a0 = r(200, 0);
    const a1 = r(320, 0);
    const b0 = r(200, 40);
    const b1 = r(320, 40);
    const cands = [a0, a1, b0, b1];
    expect(pickSpatial(a1, cands, 'down')).toBe(3);
    expect(pickSpatial(a0, cands, 'right')).toBe(1);
    expect(pickSpatial(b1, cands, 'up')).toBe(1);
    expect(pickSpatial(b0, cands, 'left')).toBe(-1);
  });

  it('turns D-pad and stick input into commands with repeat', () => {
    const pad = makePad();
    const nav = new GamepadMenuNav(() => [pad as unknown as Gamepad], 0.4, 0.1);
    press(pad, PAD.A);
    nav.reset(); // A held while the menu opens is ignored
    expect(nav.poll(0)).toEqual([]);
    press(pad, PAD.A, 0);
    expect(nav.poll(0.02)).toEqual([]);
    press(pad, PAD.A);
    expect(nav.poll(0.04)).toEqual(['accept']);
    press(pad, PAD.A, 0);
    pad.axes = [0, 0.9, 0, 0];
    expect(nav.poll(1)).toEqual(['down']);
    expect(nav.poll(1.2)).toEqual([]);
    expect(nav.poll(1.41)).toEqual(['down']);
    expect(nav.poll(1.52)).toEqual(['down']);
    pad.axes = [0, 0, 0, 0];
    expect(nav.poll(1.6)).toEqual([]);
    press(pad, PAD.RB);
    expect(nav.poll(1.7)).toEqual(['tabNext']);
  });
});
