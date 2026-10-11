/**
 * The action map: every game action a player can bind, with its default keyboard/mouse and gamepad bindings.
 *
 * Axis sign conventions (consumers rely on these):
 *   pitch +1 = nose up        yaw +1 = turn right       roll +1 = roll right (clockwise)
 *   thrust +1 = forward       strafeX +1 = right        strafeY +1 = up
 * Mouse movement always feeds pitch and yaw (scaled by mouseSensitivity, flipped by invertY) while the pointer is
 * locked or dragging on the game view; it is a setting, not a slot binding. Gamepad bindings follow the W3C standard
 * mapping (https://w3c.github.io/gamepad/#remapping).
 */
import {
  contextOf,
  inputsOf,
  isAxisBinding,
  sameBinding,
  type Binding,
  type BindingMap,
  type BindingSlots,
  type InputContext,
} from './bindings';

export const ACTION_IDS = [
  'pitch',
  'yaw',
  'roll',
  'thrust',
  'strafeX',
  'strafeY',
  'boost',
  'flightAssist',
  'landAssist',
  'throttleUp',
  'throttleDown',
  'throttleZero',
  'modeNext',
  'modePrev',
  'hyperspeed',
  'targetNext',
  'targetPrev',
  'targetReticle',
  'toggleView',
  'headLook',
  'toggleHud',
  'screenshot',
  'toggleMap',
  'toggleCodex',
  'howWeKnow',
  'share',
  'pause',
] as const;

export type ActionId = (typeof ACTION_IDS)[number];
export type ActionKind = 'button' | 'axis';
export type ActionCategory = 'flight' | 'drive' | 'targeting' | 'camera' | 'info' | 'system';

export const ACTION_CATEGORIES: readonly ActionCategory[] = ['flight', 'drive', 'targeting', 'camera', 'info', 'system'];

export interface ActionDef {
  readonly id: ActionId;
  /** i18n key of the action name. */
  readonly label: string;
  readonly kind: ActionKind;
  readonly category: ActionCategory;
  /** Held actions act while the input is down (e.g. boost, head look); the rest are presses. Informational. */
  readonly hold?: boolean;
  /** Axis actions: i18n keys naming the negative and positive directions (used by the rebind prompt). */
  readonly neg?: string;
  readonly pos?: string;
}

const axis = (id: ActionId, category: ActionCategory): ActionDef => ({
  id,
  label: `input.action.${id}`,
  kind: 'axis',
  category,
  neg: `input.action.${id}.neg`,
  pos: `input.action.${id}.pos`,
});
const button = (id: ActionId, category: ActionCategory, hold = false): ActionDef => ({
  id,
  label: `input.action.${id}`,
  kind: 'button',
  category,
  ...(hold ? { hold } : {}),
});

export const ACTIONS: readonly ActionDef[] = [
  axis('pitch', 'flight'),
  axis('yaw', 'flight'),
  axis('roll', 'flight'),
  axis('thrust', 'flight'),
  axis('strafeX', 'flight'),
  axis('strafeY', 'flight'),
  button('boost', 'flight', true),
  button('flightAssist', 'flight'),
  button('landAssist', 'flight'),
  button('throttleUp', 'drive', true),
  button('throttleDown', 'drive', true),
  button('throttleZero', 'drive'),
  button('modeNext', 'drive'),
  button('modePrev', 'drive'),
  button('hyperspeed', 'drive'),
  button('targetNext', 'targeting'),
  button('targetPrev', 'targeting'),
  button('targetReticle', 'targeting'),
  button('toggleView', 'camera'),
  button('headLook', 'camera', true),
  button('toggleHud', 'camera'),
  button('screenshot', 'camera'),
  button('toggleMap', 'info'),
  button('toggleCodex', 'info'),
  button('howWeKnow', 'info'),
  button('share', 'info'),
  button('pause', 'system'),
];

const BY_ID = new Map<string, ActionDef>(ACTIONS.map((a) => [a.id, a]));

export function actionDef(id: ActionId): ActionDef {
  return BY_ID.get(id)!;
}

export function isActionId(id: string): id is ActionId {
  return BY_ID.has(id);
}

// --- Defaults -------------------------------------------------------------------------------------------------------

const K = (code: string): Binding => ({ type: 'key', code });
const KA = (neg: string, pos: string): Binding => ({ type: 'keyAxis', neg, pos });
const MB = (b: number): Binding => ({ type: 'mouseButton', button: b });
const W = (dir: -1 | 1): Binding => ({ type: 'wheel', dir });
const PB = (b: number): Binding => ({ type: 'padButton', button: b });
const PBA = (neg: number, pos: number): Binding => ({ type: 'padButtonAxis', neg, pos });
const PA = (a: number, invert = false): Binding => ({ type: 'padAxis', axis: a, invert });

/** W3C standard gamepad button indices. */
export const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8,
  MENU: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
  HOME: 16,
} as const;

export const DEFAULT_KBM: Readonly<Record<ActionId, BindingSlots>> = {
  pitch: [KA('ArrowDown', 'ArrowUp'), null],
  yaw: [KA('KeyA', 'KeyD'), KA('ArrowLeft', 'ArrowRight')],
  roll: [KA('KeyQ', 'KeyE'), null],
  thrust: [KA('KeyS', 'KeyW'), null],
  strafeX: [KA('KeyZ', 'KeyX'), null],
  strafeY: [KA('KeyF', 'KeyR'), null],
  boost: [K('ShiftLeft'), K('ShiftRight')],
  flightAssist: [K('KeyG'), null],
  landAssist: [K('KeyL'), null],
  throttleUp: [K('Equal'), W(-1)],
  throttleDown: [K('Minus'), W(1)],
  throttleZero: [K('Backspace'), null],
  modeNext: [K('Space'), null],
  modePrev: [K('KeyB'), null],
  hyperspeed: [K('KeyJ'), null],
  targetNext: [K('Tab'), null],
  targetPrev: [K('KeyY'), null],
  targetReticle: [K('KeyT'), MB(1)],
  toggleView: [K('KeyV'), null],
  headLook: [MB(2), K('AltLeft')],
  toggleHud: [K('KeyH'), null],
  screenshot: [K('KeyP'), null],
  toggleMap: [K('KeyM'), null],
  toggleCodex: [K('KeyC'), null],
  howWeKnow: [K('KeyI'), null],
  share: [K('KeyK'), null],
  pause: [K('Escape'), null],
};

export const DEFAULT_PAD: Readonly<Record<ActionId, BindingSlots>> = {
  pitch: [PA(3, true), null],
  yaw: [PA(2), null],
  roll: [PBA(PAD.LB, PAD.RB), null],
  thrust: [PBA(PAD.LT, PAD.RT), null],
  strafeX: [PA(0), null],
  strafeY: [PA(1, true), null],
  boost: [PB(PAD.LS), null],
  flightAssist: [PB(PAD.X), null],
  landAssist: [null, null],
  throttleUp: [null, null],
  throttleDown: [null, null],
  throttleZero: [null, null],
  modeNext: [PB(PAD.UP), null],
  modePrev: [PB(PAD.DOWN), null],
  hyperspeed: [PB(PAD.Y), null],
  targetNext: [PB(PAD.RIGHT), null],
  targetPrev: [PB(PAD.LEFT), null],
  targetReticle: [PB(PAD.A), null],
  toggleView: [PB(PAD.B), null],
  headLook: [PB(PAD.RS), null],
  toggleHud: [null, null],
  screenshot: [null, null],
  toggleMap: [PB(PAD.VIEW), null],
  toggleCodex: [null, null],
  howWeKnow: [null, null],
  share: [null, null],
  pause: [PB(PAD.MENU), null],
};

/** Slots that can never change: Escape and the gamepad Menu button always open the pause menu. */
export const FIXED: Readonly<Record<InputContext, Partial<Record<ActionId, { slot: 0 | 1; binding: Binding }>>>> = {
  kbm: { pause: { slot: 0, binding: K('Escape') } },
  pad: { pause: { slot: 0, binding: PB(PAD.MENU) } },
};

/** Inputs reserved for the fixed bindings; no other action may use them (and rebind capture treats them as cancel). */
export const RESERVED_INPUTS: ReadonlySet<string> = new Set(['key:Escape', `pad:b${PAD.MENU}`]);

export function isFixedSlot(context: InputContext, id: ActionId, slot: 0 | 1): boolean {
  return FIXED[context][id]?.slot === slot;
}

export function defaultBindings(context: InputContext): BindingMap {
  const src = context === 'kbm' ? DEFAULT_KBM : DEFAULT_PAD;
  const out: BindingMap = {};
  for (const a of ACTIONS) {
    const s = src[a.id];
    out[a.id] = [s[0], s[1]];
  }
  return out;
}

/** Whether `b` may sit in slot `slot` of action `id` in `context` (kind, device and reserved-input checks). */
export function bindingAllowed(context: InputContext, id: ActionId, slot: 0 | 1, b: Binding | null): boolean {
  const fixed = FIXED[context][id];
  if (fixed?.slot === slot) return b !== null && sameBinding(b, fixed.binding);
  if (b === null) return true;
  if (contextOf(b) !== context) return false;
  const def = actionDef(id);
  if (def.kind === 'axis' && !isAxisBinding(b)) return false;
  if (def.kind === 'button' && isAxisBinding(b)) return false;
  return !inputsOf(b).some((i) => RESERVED_INPUTS.has(i));
}

export interface BindingConflict {
  readonly context: InputContext;
  /** Canonical input id, e.g. "key:KeyW" (see bindings.ts). Display with inputLabel(). */
  readonly binding: string;
  readonly actions: ActionId[];
}

/** Physical inputs bound to more than one action within a context. */
export function findConflicts(map: BindingMap, context: InputContext): BindingConflict[] {
  const users = new Map<string, ActionId[]>();
  for (const a of ACTIONS) {
    for (const b of map[a.id] ?? []) {
      if (!b) continue;
      for (const input of inputsOf(b)) {
        const list = users.get(input) ?? [];
        if (!list.includes(a.id)) list.push(a.id);
        users.set(input, list);
      }
    }
  }
  const out: BindingConflict[] = [];
  for (const [binding, actions] of users) if (actions.length > 1) out.push({ context, binding, actions });
  return out;
}
