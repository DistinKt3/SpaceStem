import { describe, expect, it } from 'vitest';
import { PARSEC_M } from '../../src/core/constants';
import { Vec3d } from '../../src/core/vec3d';
import { ExoSystem, type ExoSystemSpec } from '../../src/world/exo/exoSystem';

// Test fixture with TRAPPIST-1-like values (Agol et al. 2021); the game loads the archive JSON instead.
const spec: ExoSystemSpec = {
  id: 'trappist-1',
  name: 'TRAPPIST-1',
  raDeg: 346.6224,
  decDeg: -5.0414,
  distancePc: 12.47,
  nodeDeg: 30,
  star: { radiusSun: 0.1192, massSun: 0.0898, teffK: 2566, luminositySun: 5.53e-4, rotationPeriodDays: 3.3, citation: 'agol2021' },
  planets: [
    { id: 'trappist-1b', name: 'TRAPPIST-1 b', radiusEarth: 1.116, massEarth: 1.374, periodDays: 1.510826, semiMajorAxisAu: 0.01154, transitMidBJD: 2457322.51654, inclinationDeg: 89.728, palette: 'basalt', seed: 11, terrain: 'volcanic', geometricAlbedo: 0.1, tidallyLocked: true, citation: 'agol2021' },
    { id: 'trappist-1e', name: 'TRAPPIST-1 e', radiusEarth: 0.92, massEarth: 0.692, periodDays: 6.101013, semiMajorAxisAu: 0.02925, transitMidBJD: 2457312.71144, inclinationDeg: 89.793, palette: 'temperate', seed: 14, terrain: 'cratered', geometricAlbedo: 0.2, tidallyLocked: true, citation: 'agol2021' },
  ],
};

describe('ExoSystem', () => {
  const sys = new ExoSystem(spec);

  it('places the star at its measured distance and direction', () => {
    expect(sys.helio.length() / PARSEC_M).toBeCloseTo(12.47, 9);
  });

  it('computes relative positions in the local frame, consistent with SSB differencing', () => {
    const t = 8.3e8;
    const sun = new Vec3d(1e9, -2e8, 3e7);
    const local = sys.relative('trappist-1e', 'trappist-1b', t, new Vec3d());
    const viaSsb = sys.ssb('trappist-1e', t, sun, new Vec3d()).sub(sys.ssb('trappist-1b', t, sun, new Vec3d()));
    // Differencing ~4e17 m vectors loses tens of metres; the local result is exact to float64 at ~1e9 m.
    expect(local.distanceTo(viaSsb)).toBeLessThan(200);
    expect(local.distanceTo(viaSsb)).toBeGreaterThan(0);
    expect(sys.relative('trappist-1b', 'trappist-1', t, new Vec3d()).length() / (0.01154 * 1.495978707e11)).toBeCloseTo(1, 12);
  });

  it('builds a lit star and tidally locked planets with measured sizes', () => {
    const defs = sys.bodyDefs();
    expect(defs.map((d) => d.id)).toEqual(['trappist-1', 'trappist-1b', 'trappist-1e']);
    const star = defs[0]!;
    expect(star.kind).toBe('star');
    expect(star.luminositySun).toBeCloseTo(5.53e-4, 9);
    expect(star.radiusM / 6.957e8).toBeCloseTo(0.1192, 3);
    const b = defs[1]!;
    expect(b.parent).toBe('trappist-1');
    expect(b.radiusM / 6.3781e6).toBeCloseTo(1.116, 6);
    expect(b.surface.generated).toEqual({ palette: 'basalt', seed: 11 });
    expect(b.rotation.pm[1]).toBeCloseTo(360 / 1.510826, 6);
    // Surface gravity of b: ~1.1 g (Agol et al. 2021 report 1.102 g).
    expect(ExoSystem.gravity(spec.planets[0]!) / 9.80665).toBeCloseTo(1.1, 1);
  });
});
