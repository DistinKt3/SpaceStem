import { describe, expect, it } from 'vitest';
import { boxesOverlap, labelSpots } from '../../src/game/hud/hud';

describe('HUD label placement', () => {
  it('offers four spots around the point, right first, none covering the point itself', () => {
    const spots = labelSpots(100, 100, 60, 14);
    expect(spots[0]).toEqual({ x: 108, y: 92, w: 60, h: 14 });
    expect(spots[1]!.x + spots[1]!.w).toBe(92);
    for (const b of spots) expect(b.x <= 100 && 100 <= b.x + b.w && b.y <= 100 && 100 <= b.y + b.h).toBe(false);
  });

  it('lets close neighbours fall back to another spot instead of stacking', () => {
    const first = labelSpots(400, 300, 120, 14)[0]!;
    const near = labelSpots(404, 302, 120, 14);
    expect(boxesOverlap(near[0]!, first)).toBe(true);
    const free = near.find((b) => !boxesOverlap(b, first));
    expect(free).toBeDefined();
    expect(free).not.toEqual(near[0]);
  });
});
