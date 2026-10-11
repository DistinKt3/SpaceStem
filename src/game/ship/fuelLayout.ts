/**
 * Places the fuel gauge in the game HUD so it keeps clear of the HUD's panels at any viewport size and text scale.
 *
 * The gauge sits top-right. The HUD's target panel is vertically centred on the right, its speed panel is centred at
 * the top, and every size is in rem, so whether they collide depends on the viewport measured in rem (the text-scale
 * setting changes the root font size). Media queries cannot follow that (rem in a media query is the initial 16 px),
 * so this module measures the panels and decides:
 *
 * - The gauge goes top-right, or just below the speed panel when the two would overlap side by side (narrow screens).
 * - The target panel stays centred unless that puts it under the gauge; then it moves just below the gauge. It may
 *   run off the bottom by up to 40 % of its height (the least important rows) rather than hide under the gauge.
 * - When no placement is free of overlap (for example 1280x720 at text scale 2, where the HUD's own panels already
 *   overlap each other) the one with the least overlap wins.
 * - Hysteresis: once below the speed panel, the gauge returns to the top only with 1 rem of clearance to spare, so a
 *   speed readout that grows and shrinks by a character does not make it jump back and forth.
 * - On short screens (under 36 rem) the gauge uses its compact spacing.
 *
 * `planFuelLayout` is pure (unit-tested); `FuelHudLayout` reads the DOM and applies the plan.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FuelLayoutInput {
  /** HUD size (px) and the root font size (px per rem). */
  width: number;
  height: number;
  rem: number;
  /** Gauge size (px), measured at the density the plan will use. */
  gauge: { w: number; h: number };
  /** The top speed panel, or null when hidden. */
  top: Box | null;
  /** The target panel's size (px), or null when hidden. Its natural place is right-aligned and vertically centred. */
  target: { w: number; h: number } | null;
  /** Other HUD boxes the gauge should keep clear of (left panel, footer, warning line). Empty boxes are ignored. */
  others: readonly Box[];
  /** The slot chosen last time, for hysteresis. */
  previous?: FuelSlot | null;
}

export type FuelSlot = 'top' | 'belowTop';

export interface FuelLayoutPlan {
  slot: FuelSlot;
  /** Gauge top edge (px from the HUD's top). */
  gaugeTop: number;
  /** Target panel top edge (px), or null to leave it centred. */
  targetTop: number | null;
  /** Overlap area (px²) of the chosen plan: 0 when everything is clear. */
  overlap: number;
}

/** Gap kept between the gauge and its neighbours, and the HUD's own margins (rem, as in hud.css). */
const GAP_REM = 0.5;
const MARGIN_TOP_REM = 1;
const MARGIN_RIGHT_REM = 1.2;
const MARGIN_BOTTOM_REM = 1;
/** The target panel may run off the bottom by at most this share of its height (its last rows: ETA and the hint). */
const TARGET_MAX_OFFSCREEN = 0.4;
/** Below this HUD height (in rem) the gauge uses its compact spacing. */
export const COMPACT_BELOW_REM = 36;

/** Area (px²) shared by two boxes. */
export function overlapArea(a: Box, b: Box): number {
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return 0;
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function planFuelLayout(input: FuelLayoutInput): FuelLayoutPlan {
  const { width: W, height: H, rem, gauge, top, target } = input;
  const gap = GAP_REM * rem;
  const gaugeX = W - MARGIN_RIGHT_REM * rem - gauge.w;
  const targetBox = (y: number): Box | null => (target ? { x: W - MARGIN_RIGHT_REM * rem - target.w, y, w: target.w, h: target.h } : null);
  const centred = target ? (H - target.h) / 2 : 0;
  const naturalTarget = targetBox(centred);

  /** `margin`: extra clearance (px) the gauge must have on its left and below to count as clear (hysteresis). */
  const evaluate = (slot: FuelSlot, margin = 0): FuelLayoutPlan => {
    const gaugeTop = slot === 'top' || !top ? MARGIN_TOP_REM * rem : top.y + top.h + gap;
    const g: Box = { x: gaugeX, y: gaugeTop, w: gauge.w, h: gauge.h };
    const scored: Box = { x: g.x - margin, y: g.y, w: g.w + margin, h: g.h + margin };
    let targetTop: number | null = null;
    let t = naturalTarget;
    if (target && t && overlapArea(g, { x: t.x, y: t.y - gap, w: t.w, h: t.h + 2 * gap }) > 0) {
      // Below the gauge, but keep at least the panel's upper rows on screen.
      const below = g.y + g.h + gap;
      const lowest = Math.max(H - MARGIN_BOTTOM_REM * rem - target.h, H - (1 - TARGET_MAX_OFFSCREEN) * target.h);
      targetTop = Math.max(0, Math.min(below, lowest));
      t = targetBox(targetTop);
    }
    let overlap = 0;
    if (top) overlap += overlapArea(scored, top);
    if (t) overlap += overlapArea(g, t);
    for (const o of input.others) overlap += overlapArea(scored, o);
    // Moving the target panel must not make it cover more of the HUD than it already did where it was.
    if (t && naturalTarget && targetTop !== null) {
      const covered = (b: Box): number => (top ? overlapArea(b, top) : 0) + input.others.reduce((s, o) => s + overlapArea(b, o), 0);
      overlap += Math.max(0, covered(t) - covered(naturalTarget));
      overlap += t.w * Math.max(0, t.y + t.h - H);
    }
    return { slot, gaugeTop, targetTop, overlap };
  };

  if (!top) return evaluate('top');
  // Ties go to the top slot (the gauge's home); coming back up from below needs the extra clearance.
  const plans = [evaluate('top', input.previous === 'belowTop' ? rem : 0), evaluate('belowTop')];
  const best = plans.reduce((a, b) => (b.overlap < a.overlap ? b : a));
  // Report the real overlap of the chosen slot (the hysteresis margin only steers the choice).
  return best.slot === 'top' ? evaluate('top') : best;
}

/** Applies planFuelLayout to the live HUD: measures, positions the gauge and, when needed, the target panel. */
export class FuelHudLayout {
  private slot: FuelSlot | null = null;
  private last = -Infinity;
  private key = '';

  constructor(
    private readonly hudRoot: HTMLElement,
    private readonly gauge: { root: HTMLElement; setDensity(d: 'normal' | 'compact'): void },
  ) {}

  /** Re-plan at most every `intervalMs` (the HUD panels themselves refresh at 10 Hz), or at once after a resize. */
  update(now = performance.now(), intervalMs = 100): FuelLayoutPlan | null {
    const hud = this.hudRoot;
    const W = hud.clientWidth;
    const H = hud.clientHeight;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const key = `${W}x${H}@${rem}`;
    if (now - this.last < intervalMs && key === this.key) return null;
    this.last = now;
    this.key = key;
    const g = this.gauge.root;
    if (W === 0 || H === 0 || g.hidden) {
      this.clearTarget();
      return null;
    }
    this.gauge.setDensity(H / rem < COMPACT_BELOW_REM ? 'compact' : 'normal');
    const rect = (sel: string): Box | null => {
      const el = hud.querySelector<HTMLElement>(sel);
      if (!el || el.offsetParent === null) return null;
      const r = el.getBoundingClientRect();
      const o = hud.getBoundingClientRect();
      return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
    };
    const targetEl = hud.querySelector<HTMLElement>(':scope > .ks-hud-right');
    const target = targetEl && targetEl.offsetParent !== null ? { w: targetEl.offsetWidth, h: targetEl.offsetHeight } : null;
    const plan = planFuelLayout({
      width: W,
      height: H,
      rem,
      gauge: { w: g.offsetWidth, h: g.offsetHeight },
      top: rect(':scope > .ks-hud-top'),
      target,
      others: [rect(':scope > .ks-hud-left'), rect(':scope > .ks-hud-footer'), rect(':scope > .ks-hud-warn')].filter((b): b is Box => b !== null),
      previous: this.slot,
    });
    this.slot = plan.slot;
    const top = `${Math.round(plan.gaugeTop)}px`;
    if (g.style.top !== top) g.style.top = top;
    if (plan.targetTop === null) this.clearTarget();
    else {
      hud.dataset['fuelPush'] = '';
      hud.style.setProperty('--ks-fuel-target-top', `${Math.round(plan.targetTop)}px`);
    }
    return plan;
  }

  private clearTarget(): void {
    if (this.hudRoot.dataset['fuelPush'] === undefined) return;
    delete this.hudRoot.dataset['fuelPush'];
    this.hudRoot.style.removeProperty('--ks-fuel-target-top');
  }
}
