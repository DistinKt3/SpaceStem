/**
 * Physical input bindings. A binding is one slot's worth of input for one action: a key, a key pair for an axis, a
 * mouse button, a wheel direction, or a gamepad button / stick. Bindings are plain JSON so they persist in settings.
 *
 * Contexts: keyboard and mouse ('kbm') and gamepad ('pad') each have their own two slots per action, so a player can
 * keep both a keyboard layout and a controller layout. Conflicts are only meaningful within one context.
 *
 * Canonical input ids (used for conflict detection and press tracking):
 *   key:<KeyboardEvent.code>  mouse:<button>  wheel:up | wheel:down  pad:b<button>  pad:a<axis>+ | pad:a<axis>-
 */

export type InputContext = 'kbm' | 'pad';
export const INPUT_CONTEXTS: readonly InputContext[] = ['kbm', 'pad'];

export type Binding =
  /** A single key (button actions). `code` is KeyboardEvent.code, so bindings follow physical key positions. */
  | { readonly type: 'key'; readonly code: string }
  /** Two keys driving an axis: `neg` gives -1, `pos` gives +1. */
  | { readonly type: 'keyAxis'; readonly neg: string; readonly pos: string }
  /** MouseEvent.button: 0 left, 1 middle, 2 right, 3 back, 4 forward. */
  | { readonly type: 'mouseButton'; readonly button: number }
  /** One wheel notch is one press. dir -1 = wheel up (away from you), +1 = wheel down. */
  | { readonly type: 'wheel'; readonly dir: -1 | 1 }
  /** Gamepad button index (W3C standard mapping when the pad reports it). */
  | { readonly type: 'padButton'; readonly button: number }
  /** Two (possibly analog) gamepad buttons driving an axis, e.g. the triggers. */
  | { readonly type: 'padButtonAxis'; readonly neg: number; readonly pos: number }
  /** A gamepad stick axis. invert flips the sign (standard mapping reports stick-up as -1). */
  | { readonly type: 'padAxis'; readonly axis: number; readonly invert: boolean }
  /** One direction of a gamepad stick axis used as a button. */
  | { readonly type: 'padAxisDir'; readonly axis: number; readonly dir: -1 | 1 };

export type BindingSlots = [Binding | null, Binding | null];
export type BindingMap = Record<string, BindingSlots>;

const AXIS_TYPES = new Set<Binding['type']>(['keyAxis', 'padButtonAxis', 'padAxis']);
const PAD_TYPES = new Set<Binding['type']>(['padButton', 'padButtonAxis', 'padAxis', 'padAxisDir']);

export function contextOf(b: Binding): InputContext {
  return PAD_TYPES.has(b.type) ? 'pad' : 'kbm';
}

/** True for bindings that produce a signed value (usable by axis actions). */
export function isAxisBinding(b: Binding): boolean {
  return AXIS_TYPES.has(b.type);
}

export const keyInput = (code: string): string => `key:${code}`;
export const mouseInput = (button: number): string => `mouse:${button}`;
export const wheelInput = (dir: -1 | 1): string => (dir < 0 ? 'wheel:up' : 'wheel:down');
export const padButtonInput = (button: number): string => `pad:b${button}`;
export const padAxisInput = (axis: number, dir: -1 | 1): string => `pad:a${axis}${dir < 0 ? '-' : '+'}`;

/** The canonical physical inputs a binding listens to. */
export function inputsOf(b: Binding): string[] {
  switch (b.type) {
    case 'key':
      return [keyInput(b.code)];
    case 'keyAxis':
      return [keyInput(b.neg), keyInput(b.pos)];
    case 'mouseButton':
      return [mouseInput(b.button)];
    case 'wheel':
      return [wheelInput(b.dir)];
    case 'padButton':
      return [padButtonInput(b.button)];
    case 'padButtonAxis':
      return [padButtonInput(b.neg), padButtonInput(b.pos)];
    case 'padAxis':
      return [padAxisInput(b.axis, -1), padAxisInput(b.axis, 1)];
    case 'padAxisDir':
      return [padAxisInput(b.axis, b.dir)];
  }
}

export function sameBinding(a: Binding | null, b: Binding | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** Field order is fixed so JSON comparison is stable. */
function normalize(b: Binding): Binding {
  switch (b.type) {
    case 'key':
      return { type: b.type, code: b.code };
    case 'keyAxis':
      return { type: b.type, neg: b.neg, pos: b.pos };
    case 'mouseButton':
      return { type: b.type, button: b.button };
    case 'wheel':
      return { type: b.type, dir: b.dir };
    case 'padButton':
      return { type: b.type, button: b.button };
    case 'padButtonAxis':
      return { type: b.type, neg: b.neg, pos: b.pos };
    case 'padAxis':
      return { type: b.type, axis: b.axis, invert: b.invert };
    case 'padAxisDir':
      return { type: b.type, axis: b.axis, dir: b.dir };
  }
}

const isCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(v);
const isIndex = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const isDir = (v: unknown): v is -1 | 1 => v === -1 || v === 1;

/** Validates untrusted JSON (e.g. from localStorage). Returns a clean binding or null. */
export function parseBinding(raw: unknown): Binding | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r['type']) {
    case 'key':
      return isCode(r['code']) ? { type: 'key', code: r['code'] } : null;
    case 'keyAxis':
      return isCode(r['neg']) && isCode(r['pos']) && r['neg'] !== r['pos'] ? { type: 'keyAxis', neg: r['neg'], pos: r['pos'] } : null;
    case 'mouseButton':
      return isIndex(r['button'], 4) ? { type: 'mouseButton', button: r['button'] } : null;
    case 'wheel':
      return isDir(r['dir']) ? { type: 'wheel', dir: r['dir'] } : null;
    case 'padButton':
      return isIndex(r['button'], 31) ? { type: 'padButton', button: r['button'] } : null;
    case 'padButtonAxis':
      return isIndex(r['neg'], 31) && isIndex(r['pos'], 31) && r['neg'] !== r['pos']
        ? { type: 'padButtonAxis', neg: r['neg'], pos: r['pos'] }
        : null;
    case 'padAxis':
      return isIndex(r['axis'], 15) && typeof r['invert'] === 'boolean' ? { type: 'padAxis', axis: r['axis'], invert: r['invert'] } : null;
    case 'padAxisDir':
      return isIndex(r['axis'], 15) && isDir(r['dir']) ? { type: 'padAxisDir', axis: r['axis'], dir: r['dir'] } : null;
    default:
      return null;
  }
}
