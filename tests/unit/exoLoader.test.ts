import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Vec3d } from '../../src/core/vec3d';
import { ExoSystem } from '../../src/world/exo/exoSystem';
import { bjdToTdbSeconds } from '../../src/world/exo/orbitFrame';
import { fromSystemJson, hexToLinear } from '../../src/world/exo/systemLoader';
import { orbitalFrameToIcrs, orbitalPosition, type ExoSystem as SystemJson } from '../../src/world/exo/systemData';

const raw = JSON.parse(readFileSync('public/data/systems/trappist-1.json', 'utf8')) as Record<string, unknown>;

describe('TRAPPIST-1 through the game adapter', () => {
  const spec = fromSystemJson(raw);

  it('adapts all seven planets, ordered by period, with the mean ephemeris', () => {
    expect(spec).not.toBeNull();
    expect(spec!.planets.map((p) => p.id)).toEqual(['b', 'c', 'd', 'e', 'f', 'g', 'h'].map((l) => `trappist-1${l}`));
    const b = spec!.planets[0]!;
    // Mean ephemeris period (inferred) is used for phase, not the N-body osculating period.
    expect(b.periodDays).toBeCloseTo(1.5108737, 7);
    expect(spec!.star.luminositySun).toBeCloseTo(0.000553, 9);
    expect(spec!.distancePc).toBeCloseTo(12.43, 2);
  });

  it('carries the generated palettes and scales them to the generated albedo', () => {
    const h = spec!.planets[6]!;
    expect(typeof h.palette).toBe('object');
    if (typeof h.palette === 'object') {
      expect(h.palette.colors).toHaveLength(5);
      expect(h.palette.iceCoverage).toBeCloseTo(0.94, 2);
    }
    expect(h.albedoScale).toBeGreaterThan(0.3);
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToLinear('nope')).toBeNull();
  });

  it('agrees with the data module on where each planet is (independent implementations)', () => {
    const sys = new ExoSystem(spec!);
    const data = raw as unknown as SystemJson;
    const basis = orbitalFrameToIcrs(data);
    for (const p of data.planets) {
      const t = bjdToTdbSeconds(p.inferred.ephemerisTransitMidBJD?.value ?? p.measured.transitMidBJD.value) + 0.37 * 86_400;
      const local = orbitalPosition(p, t);
      const theirs = basis.x.clone().scale(local.x).addScaled(basis.y, local.y).addScaled(basis.z, local.z).normalize();
      const ours = sys.local(p.id, t, new Vec3d()).normalize();
      // Same phase and sense; the frames differ only by per-planet vs system inclination (< 0.2 deg).
      expect(ours.dot(theirs)).toBeGreaterThan(Math.cos((0.5 * Math.PI) / 180));
    }
  });
});
