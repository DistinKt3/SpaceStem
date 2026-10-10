import { describe, expect, it } from 'vitest';
import { planPartitions } from '../../src/render/depth/partition';

describe('planPartitions', () => {
  it('merges overlapping intervals and orders far to near', () => {
    const p = planPartitions(
      [
        { near: 1, far: 10, item: 'a' },
        { near: 5, far: 20, item: 'b' },
        { near: 1e6, far: 2e6, item: 'c' },
      ],
      1e4,
      0.5,
    );
    expect(p.map((x) => x.items)).toEqual([['c'], ['a', 'b']]);
    expect(p[0]!.near).toBeGreaterThan(p[1]!.far);
  });
  it('splits a deep group so no partition exceeds maxRatio', () => {
    const p = planPartitions([{ near: 1, far: 1e9, item: 'planet' }], 1e3, 0.5);
    expect(p.length).toBe(3);
    for (const part of p) expect(part.far / part.near).toBeLessThanOrEqual(1e3 * 1.0001);
    // Contiguous coverage from 1 to 1e9.
    const sorted = [...p].sort((a, b) => a.near - b.near);
    expect(sorted[0]!.near).toBeCloseTo(1);
    expect(sorted[sorted.length - 1]!.far).toBeCloseTo(1e9, -3);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.near).toBeCloseTo(sorted[i - 1]!.far, 6);
  });
  it('clamps near to minNear and puts spanning objects in every overlapped partition', () => {
    const p = planPartitions(
      [
        { near: -5, far: 1e6, item: 'ground' },
        { near: 100, far: 200, item: 'tower' },
      ],
      1e3,
      0.5,
    );
    expect(Math.min(...p.map((x) => x.near))).toBe(0.5);
    const withGround = p.filter((x) => x.items.includes('ground')).length;
    expect(withGround).toBe(p.length);
    expect(p.filter((x) => x.items.includes('tower')).length).toBeGreaterThanOrEqual(1);
  });
});
