/**
 * Gamepad navigation for the Codex dialogs.
 *
 * Open Codex dialogs register as navigation targets; commands go to the most recently opened one. By default the
 * module polls navigator.getGamepads() itself while a target is open (standard mapping: D-pad or left stick to move,
 * A accept, B back, LB/RB previous/next category, Menu close). A host with its own menu-navigation layer can call
 * setCodexGamepadPolling(false) and forward its commands with dispatchCodexNav(); the command names match.
 */
export type CodexNavCommand = 'up' | 'down' | 'left' | 'right' | 'accept' | 'back' | 'tabPrev' | 'tabNext' | 'menu';

export interface CodexNavTarget {
  nav(cmd: CodexNavCommand): void;
}

const stack: CodexNavTarget[] = [];
let polling = true;
let raf = 0;
let held = new Set<string>();
let ignored = new Set<string>();
let repeatDir: string | null = null;
let nextRepeat = 0;

const BUTTONS: readonly [number, CodexNavCommand][] = [
  [0, 'accept'],
  [1, 'back'],
  [4, 'tabPrev'],
  [5, 'tabNext'],
  [9, 'menu'],
];
const DPAD: readonly [number, CodexNavCommand][] = [
  [12, 'up'],
  [13, 'down'],
  [14, 'left'],
  [15, 'right'],
];
const DIRS = new Set<CodexNavCommand>(['up', 'down', 'left', 'right']);
const REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 110;

function readPads(): Set<string> {
  const down = new Set<string>();
  let pads: readonly (Gamepad | null)[];
  try {
    pads =
      typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  } catch {
    return down;
  }
  for (const p of pads) {
    if (!p?.connected) continue;
    for (const [b, cmd] of BUTTONS) if (p.buttons[b]?.pressed) down.add(cmd);
    for (const [b, cmd] of DPAD) if (p.buttons[b]?.pressed) down.add(cmd);
    const x = p.axes[0] ?? 0;
    const y = p.axes[1] ?? 0;
    // Hysteresis: a stick already pushed stays "on" until it falls back below the lower threshold.
    const wasStick = [...DIRS].some((d) => held.has(d));
    const on = wasStick ? 0.35 : 0.55;
    if (Math.abs(x) > Math.abs(y)) {
      if (x > on) down.add('right');
      else if (x < -on) down.add('left');
    } else if (y > on) down.add('down');
    else if (y < -on) down.add('up');
  }
  return down;
}

function poll(): void {
  raf = 0;
  if (stack.length === 0 || !polling) return;
  const now = performance.now();
  const down = readPads();
  for (const id of [...ignored]) if (!down.has(id)) ignored.delete(id);
  const out: CodexNavCommand[] = [];
  for (const id of down) {
    if (DIRS.has(id as CodexNavCommand) || held.has(id) || ignored.has(id)) continue;
    out.push(id as CodexNavCommand);
  }
  let dir: string | null = null;
  for (const d of DIRS) if (down.has(d) && !ignored.has(d)) dir = d;
  if (dir && dir !== repeatDir) {
    out.push(dir as CodexNavCommand);
    repeatDir = dir;
    nextRepeat = now + REPEAT_DELAY;
  } else if (dir && now >= nextRepeat) {
    out.push(dir as CodexNavCommand);
    nextRepeat = now + REPEAT_INTERVAL;
  } else if (!dir) repeatDir = null;
  held = down;
  for (const cmd of out) dispatchCodexNav(cmd);
  schedule();
}

function schedule(): void {
  if (raf || !polling || stack.length === 0 || typeof requestAnimationFrame === 'undefined') return;
  raf = requestAnimationFrame(poll);
}

/** Registers an open dialog. Buttons already held (e.g. the press that opened it) are ignored until released. */
export function pushNavTarget(target: CodexNavTarget): void {
  removeNavTarget(target);
  stack.push(target);
  ignored = readPads();
  held = new Set(ignored);
  repeatDir = null;
  schedule();
}

export function removeNavTarget(target: CodexNavTarget): void {
  const i = stack.indexOf(target);
  if (i >= 0) stack.splice(i, 1);
  if (stack.length === 0 && raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

/** Sends a command to the top Codex dialog. Returns false when no Codex dialog is open. */
export function dispatchCodexNav(cmd: CodexNavCommand): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.nav(cmd);
  return true;
}

/** Turns the built-in gamepad polling on or off (off when the host forwards commands itself). */
export function setCodexGamepadPolling(on: boolean): void {
  polling = on;
  if (on) schedule();
  else if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}
