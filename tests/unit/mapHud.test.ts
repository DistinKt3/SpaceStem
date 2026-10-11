/**
 * Map keyboard / gamepad rules (mapNav.ts) and the HUD throttle readout (throttle.ts).
 * The browser side (focus, ARIA, input routing, label layout) is covered by tests/e2e/mapHud.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { THROTTLE_MAX, THROTTLE_MIN, throttleMeter } from '../../src/game/hud/throttle';
import { fitDistance, freeArea, keyCamera, sceneArea, keyTriggers, listStep, mouseTriggers, overlaps, padCamera, padHolds, type PadLike } from '../../src/game/map/mapNav';

function pad(over: { axes?: number[]; pressed?: number[]; values?: Record<number, number> } = {}): PadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const v = over.values?.[i] ?? (over.pressed?.includes(i) ? 1 : 0);
    return { pressed: v > 0.5, value: v };
  });
  return { connected: true, axes: over.axes ?? [0, 0, 0, 0], buttons };
}

describe('map list navigation', () => {
  it('moves through the list with arrows, Home/End and paging, clamped at the ends', () => {
    expect(listStep('ArrowDown', 0, 5)).toBe(1);
    expect(listStep('ArrowDown', 4, 5)).toBe(4);
    expect(listStep('ArrowUp', 0, 5)).toBe(0);
    expect(listStep('Home', 3, 5)).toBe(0);
    expect(listStep('End', 0, 5)).toBe(4);
    expect(listStep('PageDown', 0, 50, 10)).toBe(10);
    expect(listStep('PageUp', 3, 50, 10)).toBe(0);
  });
  it('ignores other keys and empty lists', () => {
    expect(listStep('Tab', 0, 5)).toBeNull();
    expect(listStep(' ', 0, 5)).toBeNull();
    expect(listStep('ArrowDown', 0, 0)).toBeNull();
  });
});

describe('map close bindings', () => {
  it('matches the toggle-map key and mouse bindings (any rebinding)', () => {
    expect(keyTriggers({ type: 'key', code: 'KeyM' }, 'KeyM')).toBe(true);
    expect(keyTriggers({ type: 'key', code: 'KeyM' }, 'KeyN')).toBe(false);
    expect(keyTriggers({ type: 'keyAxis', neg: 'KeyM', pos: 'KeyN' }, 'KeyM')).toBe(false);
    expect(keyTriggers(null, 'KeyM')).toBe(false);
    expect(mouseTriggers({ type: 'mouseButton', button: 3 }, 3)).toBe(true);
    expect(mouseTriggers({ type: 'mouseButton', button: 3 }, 4)).toBe(false);
  });
  it('detects a held gamepad button or stick direction on any connected pad', () => {
    expect(padHolds({ type: 'padButton', button: 8 }, [pad({ pressed: [8] })])).toBe(true);
    expect(padHolds({ type: 'padButton', button: 8 }, [pad(), null])).toBe(false);
    expect(padHolds({ type: 'padButton', button: 8 }, [{ ...pad({ pressed: [8] }), connected: false }])).toBe(false);
    expect(padHolds({ type: 'padAxisDir', axis: 1, dir: -1 }, [pad({ axes: [0, -0.9, 0, 0] })])).toBe(true);
    expect(padHolds({ type: 'padAxisDir', axis: 1, dir: 1 }, [pad({ axes: [0, -0.9, 0, 0] })])).toBe(false);
  });
});

describe('map camera from keyboard and gamepad', () => {
  it('orbits with Shift+arrows and zooms with + and -', () => {
    expect(keyCamera('ArrowLeft', true)?.yaw).toBeLessThan(0);
    expect(keyCamera('ArrowUp', true)?.pitch).toBeLessThan(0);
    expect(keyCamera('ArrowLeft', false)).toBeNull(); // Plain arrows move through the list.
    expect(keyCamera('Equal', false)?.zoom).toBeLessThan(1);
    expect(keyCamera('Minus', false)?.zoom).toBeGreaterThan(1);
    expect(keyCamera('KeyA', true)).toBeNull();
  });
  it('orbits with the right stick outside its deadzone and zooms with the triggers', () => {
    const still = padCamera([pad({ axes: [0, 0, 0.1, 0.1] })], 1 / 60);
    expect([still.yaw, still.pitch, still.zoom]).toEqual([0, 0, 1]);
    const right = padCamera([pad({ axes: [0, 0, 1, 0] })], 0.5);
    expect(right.yaw).toBeGreaterThan(0);
    expect(right.pitch).toBe(0);
    expect(padCamera([pad({ values: { 7: 1 } })], 0.5).zoom).toBeLessThan(1);
    expect(padCamera([pad({ values: { 6: 1 } })], 0.5).zoom).toBeGreaterThan(1);
    // The left stick belongs to list navigation.
    expect(padCamera([pad({ axes: [1, 1, 0, 0] })], 0.5).yaw).toBe(0);
  });
});

describe('map framing and labels', () => {
  it('centres the scene in the area left of the destination list, whatever its width', () => {
    // Regression: at text scale 2 on 1024 px the list starts at 338 px and no shift was applied.
    expect(freeArea(1024, 338, 648)).toEqual({ shift: (1024 - 338) / 2, width: 338 });
    expect(freeArea(800, 456, 326)).toEqual({ shift: 172, width: 456 });
    expect(freeArea(800, 0, 0)).toEqual({ shift: 0, width: 800 });
  });
  it('centres the scene clear of both the list and the title box', () => {
    // No title: same as freeArea, full height.
    expect(sceneArea(800, 450, { left: 456, width: 326 }, null)).toEqual({ shiftX: 172, shiftY: 0, fit: fitDistance(456, 450) });
    // Tall title (1024x768 at text scale 2): below it is the better area; the scene moves down and right of centre.
    const tall = sceneArea(1024, 768, { left: 523, width: 480 }, { right: 450, bottom: 404 });
    expect(tall.shiftY).toBeLessThan(0);
    expect(1024 / 2 - tall.shiftX).toBeCloseTo(523 / 2);
    expect(768 / 2 - tall.shiftY).toBeCloseTo(404 + (768 - 404) / 2);
    // Narrow, short title: right of it keeps the full height and wins.
    const slim = sceneArea(1600, 900, { left: 1300, width: 280 }, { right: 300, bottom: 600 });
    expect(slim.shiftY).toBe(0);
    expect(1600 / 2 - slim.shiftX).toBeCloseTo(300 + (1300 - 300) / 2);
    expect(slim.fit).toBeCloseTo(fitDistance(1000, 900));
  });
  it('moves the camera back when the free area is narrow', () => {
    expect(fitDistance(1600, 900)).toBeCloseTo(2.1);
    expect(fitDistance(338, 768)).toBeGreaterThan(5);
  });
  it('detects overlapping label boxes', () => {
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 5, h: 5 })).toBe(true);
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBe(false);
  });
});

describe('HUD throttle readout', () => {
  const attr = (html: string, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];

  it('is a meter with a name, range and value', () => {
    const h = throttleMeter(0.75);
    expect(attr(h, 'role')).toBe('meter');
    expect(attr(h, 'aria-label')).toBe('Throttle');
    expect(attr(h, 'aria-valuemin')).toBe(String(THROTTLE_MIN * 100));
    expect(attr(h, 'aria-valuemax')).toBe(String(THROTTLE_MAX * 100));
    expect(attr(h, 'aria-valuenow')).toBe('75');
    expect(attr(h, 'aria-valuetext')).toBe('Throttle 75%');
    expect(h).toContain('>Throttle 75%</div>');
  });
  it('shows reverse thrust in words and by direction, not only by colour', () => {
    const fwd = throttleMeter(0.5);
    const rev = throttleMeter(-0.5);
    expect(attr(rev, 'aria-valuenow')).toBe('-50');
    expect(attr(rev, 'aria-valuetext')).toBe('Reverse 50%');
    expect(rev).toContain('>Reverse 50%</div>');
    expect(rev).toContain('ks-throttle is-reverse');
    expect(fwd).not.toContain('is-reverse');
    // Same fill width; the difference is the reverse class (fills from the right, hatched) and the text.
    expect(attr(rev, 'style')).toBe(attr(fwd, 'style'));
    expect(rev).not.toContain('background:');
  });
  it('never shows "-0%" and clamps to the ship range', () => {
    expect(attr(throttleMeter(-0.001), 'aria-valuetext')).toBe('Throttle 0%');
    expect(attr(throttleMeter(-2), 'aria-valuenow')).toBe('-50');
    expect(attr(throttleMeter(3), 'aria-valuenow')).toBe('100');
  });
});
