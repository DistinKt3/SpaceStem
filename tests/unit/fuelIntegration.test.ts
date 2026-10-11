/**
 * The fuel loop's game integration rules (src/game/ship/shipFuel.ts) and the HUD layout that keeps the gauge clear of
 * the HUD panels at any text scale (src/game/ship/fuelLayout.ts). Pure functions; the DOM side is covered by
 * tests/e2e/fuel.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { LIGHT_YEAR_M } from '../../src/core/constants';
import { jumpCost } from '../../src/game/ship/fuel';
import { COMPACT_BELOW_REM, overlapArea, planFuelLayout, type Box, type FuelLayoutInput } from '../../src/game/ship/fuelLayout';
import { MIN_JUMP_LY, heatAlertLevel, jumpFeed, parseFuelOverride } from '../../src/game/ship/shipFuel';

describe('?fuel= override', () => {
  it('accepts finite numbers, clamped to the tank', () => {
    expect(parseFuelOverride('0.25')).toBe(0.25);
    expect(parseFuelOverride('0')).toBe(0);
    expect(parseFuelOverride('7')).toBe(1);
    expect(parseFuelOverride('-1')).toBe(0);
  });
  it('treats missing, empty and non-numeric values as no override (review: empty meant an empty tank)', () => {
    for (const raw of [null, '', '  ', 'abc', 'NaN', 'Infinity']) expect(parseFuelOverride(raw), String(raw)).toBeNull();
  });
});

describe('jump feed for the gauge', () => {
  const base = { underway: false, paidCost: null, targetIsStar: true, costOf: jumpCost };
  it('shows the selected star\'s cost', () => {
    const feed = jumpFeed({ ...base, distanceM: 8.6 * LIGHT_YEAR_M });
    expect(feed.jumpStatus).toBeNull();
    expect(feed.nextJumpCost).toBeCloseTo(jumpCost(8.6), 12);
  });
  it('does not judge the target against the tank while a paid jump is under way (review: "needs 27%" after engaging)', () => {
    expect(jumpFeed({ ...base, underway: true, paidCost: 0.267, distanceM: 8.6 * LIGHT_YEAR_M })).toEqual({ nextJumpCost: 0.267, jumpStatus: 'underway' });
    expect(jumpFeed({ ...base, underway: true, paidCost: null, distanceM: null })).toEqual({ nextJumpCost: null, jumpStatus: 'underway' });
  });
  it('separates "too close to jump" from "no star targeted" (review: the Sun from Earth read "No star targeted")', () => {
    const sunFromEarth = 1.496e11;
    expect(jumpFeed({ ...base, distanceM: sunFromEarth })).toEqual({ nextJumpCost: null, jumpStatus: 'tooClose' });
    expect(jumpFeed({ ...base, distanceM: MIN_JUMP_LY * LIGHT_YEAR_M * 1.01 }).jumpStatus).toBeNull();
    expect(jumpFeed({ ...base, targetIsStar: false, distanceM: 4e8 })).toEqual({ nextJumpCost: null, jumpStatus: null });
    expect(jumpFeed({ ...base, distanceM: null })).toEqual({ nextJumpCost: null, jumpStatus: null });
    expect(jumpFeed({ ...base, distanceM: Number.NaN })).toEqual({ nextJumpCost: null, jumpStatus: null });
  });
});

describe('cockpit status from hull heat', () => {
  it('raises Alert (amber) from the warning level and red at critical and above', () => {
    expect(heatAlertLevel('nominal')).toBe(0);
    expect(heatAlertLevel('warning')).toBeGreaterThanOrEqual(0.5);
    expect(heatAlertLevel('critical')).toBeGreaterThan(heatAlertLevel('warning'));
    expect(heatAlertLevel('emergency')).toBe(1);
  });
});

/**
 * HUD boxes measured in the real game HUD (rem units; hud.css and the gauge CSS), so the plan can be checked at the
 * viewport sizes and text scales the review named. Gauge 14.5 x 8.1 rem compact (9.9 normal, with the scooping chip);
 * target panel 12.7 x 13.4 rem; speed panel 16.7 x 7.06 rem at the top centre; left panel 10.7 x 5.8 rem.
 */
function hudAt(widthPx: number, heightPx: number, scale: number, extra: Partial<FuelLayoutInput> = {}): FuelLayoutInput {
  const rem = 16 * scale;
  const W = widthPx;
  const H = heightPx;
  const compact = H / rem < COMPACT_BELOW_REM;
  const topW = 16.7 * rem;
  const left: Box = { x: 1.2 * rem, y: H / 2 - 2.9 * rem, w: 10.7 * rem, h: 5.8 * rem };
  return {
    width: W,
    height: H,
    rem,
    gauge: { w: 14.5 * rem, h: (compact ? 8.1 : 9.9) * rem },
    top: { x: (W - topW) / 2, y: rem, w: topW, h: 7.06 * rem },
    target: { w: 12.7 * rem, h: 13.4 * rem },
    others: [left],
    ...extra,
  };
}

/** Gauge and target boxes of a plan. */
function boxes(input: FuelLayoutInput, plan: ReturnType<typeof planFuelLayout>): { gauge: Box; target: Box | null } {
  const right = input.width - 1.2 * input.rem;
  const gauge = { x: right - input.gauge.w, y: plan.gaugeTop, w: input.gauge.w, h: input.gauge.h };
  const t = input.target;
  const target = t ? { x: right - t.w, y: plan.targetTop ?? (input.height - t.h) / 2, w: t.w, h: t.h } : null;
  return { gauge, target };
}

describe('fuel gauge HUD layout', () => {
  it('measures overlap', () => {
    expect(overlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(25);
    expect(overlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBe(0);
    expect(overlapArea({ x: 0, y: 0, w: 0, h: 10 }, { x: 0, y: 0, w: 5, h: 5 })).toBe(0);
  });

  // Every size the review named where the HUD's own panels do not already overlap each other.
  const clear: [number, number, number][] = [
    [1280, 720, 1],
    [1920, 1080, 1],
    [800, 450, 1],
    [1366, 768, 1.5],
    [1280, 720, 1.5],
    [1920, 1080, 2],
  ];
  for (const [w, h, s] of clear) {
    it(`keeps the gauge clear of the target, speed and left panels at ${w}x${h}, text scale ${s}`, () => {
      const input = hudAt(w, h, s);
      const plan = planFuelLayout(input);
      const b = boxes(input, plan);
      expect(plan.overlap).toBe(0);
      expect(overlapArea(b.gauge, input.top!)).toBe(0);
      expect(overlapArea(b.gauge, b.target!)).toBe(0);
      expect(overlapArea(b.gauge, input.others[0]!)).toBe(0);
      // The target panel stays fully on screen.
      expect(b.target!.y).toBeGreaterThanOrEqual(0);
      expect(b.target!.y + b.target!.h).toBeLessThanOrEqual(h);
    });
  }

  it('leaves the target panel centred when there is room (1280x720, text scale 1)', () => {
    expect(planFuelLayout(hudAt(1280, 720, 1)).targetTop).toBeNull();
  });

  it('moves the target panel just below the gauge when centring would put it underneath (1366x768 at 1.5)', () => {
    const input = hudAt(1366, 768, 1.5);
    const plan = planFuelLayout(input);
    expect(plan.slot).toBe('top');
    expect(plan.targetTop).toBeCloseTo(plan.gaugeTop + input.gauge.h + 0.5 * input.rem, 6);
  });

  it('drops the gauge below the speed panel when they would sit side by side (narrow, tall screen)', () => {
    // 390 x 844 phone at text scale 1: 24 rem wide, the speed panel spans most of the width.
    const input = hudAt(390, 844, 1, { gauge: { w: 14.5 * 16, h: 9.9 * 16 } });
    const plan = planFuelLayout(input);
    expect(plan.slot).toBe('belowTop');
    expect(plan.gaugeTop).toBeGreaterThanOrEqual(input.top!.y + input.top!.h);
    const b = boxes(input, plan);
    expect(overlapArea(b.gauge, input.top!)).toBe(0);
    expect(overlapArea(b.gauge, b.target!)).toBe(0);
  });

  it('when nothing fits (1280x720 at text scale 2) it keeps the target name visible and picks the least overlap', () => {
    const input = hudAt(1280, 720, 2);
    const plan = planFuelLayout(input);
    const b = boxes(input, plan);
    // The HUD's own speed and target panels overlap here whatever the gauge does; the gauge never covers the target
    // panel (its lower rows may run off the bottom instead), and the plan is the cheaper of the two slots.
    expect(overlapArea(b.gauge, b.target!)).toBe(0);
    // Below the speed panel the gauge would leave no room for the target panel at all, so it stays at the top.
    expect(plan.slot).toBe('top');
    expect(b.target!.y).toBeGreaterThanOrEqual(b.gauge.y + b.gauge.h);
    // At most 40 % of the target panel (its last rows) runs off the bottom.
    expect(b.target!.y + 0.6 * b.target!.h).toBeLessThanOrEqual(input.height + 1e-6);
  });

  it('has hysteresis: back to the top only with a rem of clearance to spare', () => {
    // Tall HUD without a target: the speed panel's right edge sits `reach` rem past the gauge's left edge.
    const rem = 16;
    const at = (reach: number): FuelLayoutInput => {
      const W = 60 * rem;
      const gaugeLeft = W - 1.2 * rem - 14.5 * rem;
      return { width: W, height: 60 * rem, rem, gauge: { w: 14.5 * rem, h: 9.9 * rem }, top: { x: gaugeLeft - 20 * rem + reach * rem, y: rem, w: 20 * rem, h: 7 * rem }, target: null, others: [] };
    };
    // Any real overlap moves the gauge below the speed panel, whatever it did before.
    expect(planFuelLayout(at(0.05)).slot).toBe('belowTop');
    expect(planFuelLayout({ ...at(0.05), previous: 'top' }).slot).toBe('belowTop');
    // Just clear again (half a rem): a fresh layout uses the top, but coming from below it stays there.
    expect(planFuelLayout(at(-0.5)).slot).toBe('top');
    expect(planFuelLayout({ ...at(-0.5), previous: 'belowTop' }).slot).toBe('belowTop');
    // Clear by more than a rem: back to the top, and the reported overlap is the real one (0).
    expect(planFuelLayout({ ...at(-1.5), previous: 'belowTop' })).toMatchObject({ slot: 'top', overlap: 0 });
  });

  it('without a target panel only the gauge is placed', () => {
    const plan = planFuelLayout(hudAt(1280, 720, 1, { target: null }));
    expect(plan).toMatchObject({ slot: 'top', targetTop: null, overlap: 0 });
  });
});
