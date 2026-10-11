import { describe, expect, it } from 'vitest';
import { Vec3d } from '../../src/core/vec3d';
import { keplerOrbit } from '../../src/world/kepler';

const MU_SUN = 1.32712440018e20; // m^3/s^2 (IAU 2015 nominal GM_sun)
const AU = 1.495978707e11;

describe('keplerOrbit', () => {
  it('reproduces a circular orbit', () => {
    const r = new Vec3d(AU, 0, 0);
    const v = new Vec3d(0, Math.sqrt(MU_SUN / AU), 0);
    const pts = keplerOrbit(r, v, MU_SUN, 64);
    expect(pts).toHaveLength(65);
    for (const p of pts) expect(p.length() / AU).toBeCloseTo(1, 9);
    for (const p of pts) expect(Math.abs(p.z)).toBeLessThan(1e-3);
  });

  it('recovers periapsis and apoapsis of an eccentric orbit', () => {
    // Start at periapsis q = a(1-e) with vis-viva speed.
    const a = 5 * AU;
    const e = 0.6;
    const q = a * (1 - e);
    const vq = Math.sqrt(MU_SUN * (2 / q - 1 / a));
    const pts = keplerOrbit(new Vec3d(0, q, 0), new Vec3d(0, 0, vq), MU_SUN, 360);
    const d = pts.map((p) => p.length());
    expect(Math.min(...d) / q).toBeCloseTo(1, 9);
    expect(Math.max(...d) / (a * (1 + e))).toBeCloseTo(1, 9);
    // The orbit passes through the starting state (nu = 0 is periapsis).
    expect(pts[0]!.distanceTo(new Vec3d(0, q, 0)) / q).toBeLessThan(1e-12);
  });

  it('returns only the current point for unbound states', () => {
    const r = new Vec3d(AU, 0, 0);
    const v = new Vec3d(0, 2 * Math.sqrt(MU_SUN / AU), 0);
    expect(keplerOrbit(r, v, MU_SUN, 32)).toHaveLength(1);
  });
});
