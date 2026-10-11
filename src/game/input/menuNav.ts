/**
 * Gamepad navigation for DOM menus: turns the D-pad, left stick and face buttons into navigation commands with
 * keyboard-like auto-repeat, and picks the nearest focusable element in a direction (spatial navigation).
 * Bindings here are fixed menu conventions (A accept, B back, X clear, LB/RB switch tab, Menu close), independent of
 * the remappable game actions, and apply to pads with the W3C standard mapping only.
 */
import { PAD } from './actions';

export type NavDirection = 'up' | 'down' | 'left' | 'right';
export type NavCommand = NavDirection | 'accept' | 'back' | 'clear' | 'tabPrev' | 'tabNext' | 'menu';

const BUTTON_COMMANDS: readonly [number, NavCommand][] = [
  [PAD.A, 'accept'],
  [PAD.B, 'back'],
  [PAD.X, 'clear'],
  [PAD.LB, 'tabPrev'],
  [PAD.RB, 'tabNext'],
  [PAD.MENU, 'menu'],
];
const DPAD: readonly [number, NavDirection][] = [
  [PAD.UP, 'up'],
  [PAD.DOWN, 'down'],
  [PAD.LEFT, 'left'],
  [PAD.RIGHT, 'right'],
];
const STICK_ON = 0.55;
const STICK_OFF = 0.35;

export class GamepadMenuNav {
  private readonly held = new Set<string>();
  /** Inputs down when reset() was called; ignored until released so the press that opened a menu does nothing. */
  private readonly ignored = new Set<string>();
  private repeatDir: NavDirection | null = null;
  private nextRepeat = 0;
  /** True once any pad input has been seen (for focus-ring styling). */
  active = false;

  constructor(
    private readonly getPads: () => readonly (Gamepad | null)[],
    private readonly repeatDelay = 0.4,
    private readonly repeatInterval = 0.11,
  ) {}

  reset(): void {
    this.ignored.clear();
    for (const id of this.read()) this.ignored.add(id);
    this.held.clear();
    for (const id of this.ignored) this.held.add(id);
    this.repeatDir = null;
  }

  /** Commands since the last poll. `now` is in seconds. */
  poll(now: number): NavCommand[] {
    const down = this.read();
    const out: NavCommand[] = [];
    for (const id of [...this.ignored]) if (!down.has(id)) this.ignored.delete(id);
    const pressed = (id: string): boolean => down.has(id) && !this.held.has(id) && !this.ignored.has(id);
    for (const [b, cmd] of BUTTON_COMMANDS) if (pressed(`b${b}`)) out.push(cmd);

    let dir: NavDirection | null = null;
    for (const d of ['up', 'down', 'left', 'right'] as const) if (down.has(d) && !this.ignored.has(d)) dir = d;
    if (dir && dir !== this.repeatDir) {
      out.push(dir);
      this.repeatDir = dir;
      this.nextRepeat = now + this.repeatDelay;
    } else if (dir && now >= this.nextRepeat) {
      out.push(dir);
      this.nextRepeat = now + this.repeatInterval;
    } else if (!dir) this.repeatDir = null;

    this.held.clear();
    for (const id of down) this.held.add(id);
    if (out.length > 0) this.active = true;
    return out;
  }

  private read(): Set<string> {
    const down = new Set<string>();
    let pads: readonly (Gamepad | null)[];
    try {
      pads = this.getPads();
    } catch {
      return down;
    }
    for (const p of pads) {
      // Button and axis meanings below are those of the standard mapping; other pads could rest on a stick direction
      // and scroll the menu forever.
      if (!p?.connected || p.mapping !== 'standard') continue;
      p.buttons.forEach((b, i) => {
        if (b.pressed || b.value > 0.5) down.add(`b${i}`);
      });
      for (const [b, d] of DPAD) if (p.buttons[b]?.pressed) down.add(d);
      const x = p.axes[0] ?? 0;
      const y = p.axes[1] ?? 0;
      const wasStick = this.held.has('up') || this.held.has('down') || this.held.has('left') || this.held.has('right');
      const on = wasStick ? STICK_OFF : STICK_ON;
      if (Math.abs(x) > Math.abs(y)) {
        if (x > on) down.add('right');
        else if (x < -on) down.add('left');
      } else {
        if (y > on) down.add('down');
        else if (y < -on) down.add('up');
      }
    }
    return down;
  }
}

export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Index of the best candidate in `dir` from `from`, or -1. Candidates must lie beyond `from` in that direction;
 * among them, the smallest gap wins, with misalignment on the other axis weighted more heavily so moving down a
 * two-column list stays in its column.
 */
export function pickSpatial(from: RectLike, candidates: readonly RectLike[], dir: NavDirection): number {
  const fcx = (from.left + from.right) / 2;
  const fcy = (from.top + from.bottom) / 2;
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((c, i) => {
    const cx = (c.left + c.right) / 2;
    const cy = (c.top + c.bottom) / 2;
    let gap: number;
    let orth: number;
    const overlapX = Math.min(from.right, c.right) - Math.max(from.left, c.left);
    const overlapY = Math.min(from.bottom, c.bottom) - Math.max(from.top, c.top);
    switch (dir) {
      case 'right':
        if (cx <= fcx + 1 || c.left < from.left + 1) return;
        gap = Math.max(0, c.left - from.right);
        orth = overlapY > 0 ? 0 : Math.abs(cy - fcy);
        break;
      case 'left':
        if (cx >= fcx - 1 || c.right > from.right - 1) return;
        gap = Math.max(0, from.left - c.right);
        orth = overlapY > 0 ? 0 : Math.abs(cy - fcy);
        break;
      case 'down':
        if (cy <= fcy + 1 || c.top < from.top + 1) return;
        gap = Math.max(0, c.top - from.bottom);
        orth = overlapX > 0 ? 0 : Math.abs(cx - fcx);
        break;
      case 'up':
        if (cy >= fcy - 1 || c.bottom > from.bottom - 1) return;
        gap = Math.max(0, from.top - c.bottom);
        orth = overlapX > 0 ? 0 : Math.abs(cx - fcx);
        break;
    }
    const along = dir === 'left' || dir === 'right' ? Math.abs(cx - fcx) : Math.abs(cy - fcy);
    const score = gap + orth * 3 + along * 0.05 + (dir === 'up' || dir === 'down' ? Math.abs(c.left - from.left) * 0.02 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
