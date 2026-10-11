/**
 * Human-readable names for bindings. Keys follow KeyboardEvent.code (physical positions); when the browser exposes
 * the Keyboard Map API we show the character the player's own layout prints on that key (e.g. "Z" for KeyY on a
 * German layout). Gamepad buttons are named after the connected pad family (Xbox-style or PlayStation-style).
 */
import { t } from '../i18n';
import type { Binding } from './bindings';

export type PadStyle = 'xbox' | 'playstation';
export type LabelLength = 'short' | 'long';

let layout: ReadonlyMap<string, string> | null = null;
let padStyle: PadStyle = 'xbox';

interface KeyboardWithLayout {
  getLayoutMap?: () => Promise<ReadonlyMap<string, string>>;
}

/** Loads the keyboard layout map when the browser supports it (Chromium). Safe to call repeatedly. */
export async function loadKeyboardLayout(): Promise<boolean> {
  try {
    const kb = (globalThis.navigator as (Navigator & { keyboard?: KeyboardWithLayout }) | undefined)?.keyboard;
    if (!kb?.getLayoutMap) return false;
    layout = await kb.getLayoutMap();
    return true;
  } catch {
    return false;
  }
}

/** Test hook and manual override. */
export function setKeyboardLayout(map: ReadonlyMap<string, string> | null): void {
  layout = map;
}

export function setPadStyle(style: PadStyle): void {
  padStyle = style;
}

export function getPadStyle(): PadStyle {
  return padStyle;
}

/** Guesses the label family from Gamepad.id (vendor 054c is Sony). */
export function padStyleFromId(id: string): PadStyle {
  return /054c|playstation|dualshock|dualsense|sony/i.test(id) ? 'playstation' : 'xbox';
}

const PUNCTUATION: Readonly<Record<string, string>> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  IntlBackslash: '\\',
};

/** Named keys with their own message (input.key.<code>). */
const NAMED = new Set([
  'Space',
  'Tab',
  'Escape',
  'Enter',
  'Backspace',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ContextMenu',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'NumpadEnter',
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadDecimal',
  'PrintScreen',
  'ScrollLock',
  'Pause',
  'NumLock',
]);

export function keyLabel(code: string, length: LabelLength = 'short'): string {
  const mapped = layout?.get(code);
  if (mapped && mapped.trim().length > 0 && !NAMED.has(code)) return mapped.length === 1 ? mapped.toUpperCase() : mapped;
  if (NAMED.has(code)) return t(`input.key.${code}${length === 'short' ? '.short' : ''}`);
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1]!;
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1]!;
  m = /^Numpad(\d)$/.exec(code);
  if (m) return t('input.key.numpad', { key: m[1]! });
  if (/^F\d{1,2}$/.test(code)) return code;
  return PUNCTUATION[code] ?? code;
}

function padButtonName(button: number, length: LabelLength): string {
  const key = `input.pad.${padStyle}.b${button}`;
  const name = t(key);
  if (name === key) return t('input.pad.buttonN', { n: button });
  if (length === 'short') return name;
  const long = t(`${key}.long`);
  return long === `${key}.long` ? t('input.pad.buttonLong', { name }) : long;
}

const STICK_OF_AXIS = ['left', 'left', 'right', 'right'] as const;

function padAxisName(axis: number, dir: -1 | 0 | 1, length: LabelLength): string {
  const stick = STICK_OF_AXIS[axis];
  if (!stick) return t('input.pad.axisN', { n: axis, dir: dir < 0 ? '−' : dir > 0 ? '+' : '±' });
  const vertical = axis % 2 === 1;
  const glyph = dir === 0 ? (vertical ? '↕' : '↔') : vertical ? (dir < 0 ? '↑' : '↓') : dir < 0 ? '←' : '→';
  return t(length === 'long' ? 'input.pad.stickLong' : 'input.pad.stick', { stick: t(`input.pad.stick.${stick}`), dir: glyph });
}

/** Label for a canonical input id (see bindings.ts), e.g. "key:KeyW" -> "W". */
export function inputLabel(input: string, length: LabelLength = 'short'): string {
  const [kind, rest = ''] = input.split(':');
  switch (kind) {
    case 'key':
      return keyLabel(rest, length);
    case 'mouse':
      return mouseLabel(Number(rest), length);
    case 'wheel':
      return t(`input.mouse.wheel.${rest === 'up' ? 'up' : 'down'}${length === 'long' ? '.long' : ''}`);
    case 'pad': {
      if (rest.startsWith('b')) return padButtonName(Number(rest.slice(1)), length);
      const m = /^a(\d+)([+-])$/.exec(rest);
      if (m) return padAxisName(Number(m[1]), m[2] === '-' ? -1 : 1, length);
      return input;
    }
    default:
      return input;
  }
}

function mouseLabel(button: number, length: LabelLength): string {
  const key = `input.mouse.${button}${length === 'long' ? '.long' : ''}`;
  const s = t(key);
  return s === key ? t('input.mouse.n', { n: button + 1 }) : s;
}

/** Display text for a binding, e.g. "S / W", "Right mouse", "Right stick ↕". */
export function bindingLabel(b: Binding | null, length: LabelLength = 'short'): string {
  if (!b) return t('input.unbound');
  switch (b.type) {
    case 'key':
      return keyLabel(b.code, length);
    case 'keyAxis':
      return t('input.binding.pair', { neg: keyLabel(b.neg, length), pos: keyLabel(b.pos, length) });
    case 'mouseButton':
      return mouseLabel(b.button, length);
    case 'wheel':
      return inputLabel(b.dir < 0 ? 'wheel:up' : 'wheel:down', length);
    case 'padButton':
      return padButtonName(b.button, length);
    case 'padButtonAxis':
      return t('input.binding.pair', { neg: padButtonName(b.neg, length), pos: padButtonName(b.pos, length) });
    case 'padAxis':
      return padAxisName(b.axis, 0, length);
    case 'padAxisDir':
      return padAxisName(b.axis, b.dir, length);
  }
}

/** The individual keycaps to draw for a binding (one for buttons, two for axis pairs). */
export function bindingParts(b: Binding | null): string[] {
  if (!b) return [];
  switch (b.type) {
    case 'keyAxis':
      return [keyLabel(b.neg), keyLabel(b.pos)];
    case 'padButtonAxis':
      return [padButtonName(b.neg, 'short'), padButtonName(b.pos, 'short')];
    default:
      return [bindingLabel(b)];
  }
}
