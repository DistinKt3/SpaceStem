import { describe, expect, it } from 'vitest';
import { Mat3d, Vec3d } from '../../src/core/vec3d';
import { bodyToIcrf } from '../../src/world/rotation';
import { SystemFrame, bjdToTdbSeconds, radecToUnit, type CircularOrbit } from '../../src/world/exo/orbitFrame';

// TRAPPIST-1-like geometry: RA 346.62°, Dec −5.04°, nearly edge-on orbits.
const los = radecToUnit(346.6224, -5.0414);
const orbit: CircularOrbit = { aM: 0.01154 * 1.495978707e11, periodS: 1.51088 * 86_400, t0: bjdToTdbSeconds(2_457_322.51654) };

describe('SystemFrame', () => {
  it('builds an orthonormal frame with the normal at the inclination from the line of sight', () => {
    for (const i of [90, 89.7, 60]) {
      const f = new SystemFrame(los, i, 30);
      expect(f.normal.length()).toBeCloseTo(1, 12);
      expect(f.xAxis.dot(f.yAxis)).toBeCloseTo(0, 12);
      expect(f.normal.dot(f.xAxis)).toBeCloseTo(0, 12);
      // Angle between normal and toward-observer equals the inclination.
      expect((Math.acos(f.normal.dot(f.toObserver)) * 180) / Math.PI).toBeCloseTo(i, 9);
    }
  });

  it('puts the planet between the star and the observer at the transit midpoint', () => {
    const f = new SystemFrame(los, 89.7, 30);
    const r = f.position(orbit, orbit.t0).normalize();
    // Closest possible approach to the observer direction for this inclination: cos(angle) = sin(i).
    expect(r.dot(f.toObserver)).toBeCloseTo(Math.sin((89.7 * Math.PI) / 180), 9);
    // Half a period later the planet is behind the star (secondary eclipse side).
    const r2 = f.position(orbit, orbit.t0 + orbit.periodS / 2).normalize();
    expect(r2.dot(f.toObserver)).toBeLessThan(-0.99);
  });

  it('is periodic, keeps radius a, and its velocity is the time derivative', () => {
    const f = new SystemFrame(los, 89.7, 30);
    const t = orbit.t0 + 12_345.6;
    expect(f.position(orbit, t).distanceTo(f.position(orbit, t + orbit.periodS)) / orbit.aM).toBeLessThan(1e-9);
    expect(f.position(orbit, t).length() / orbit.aM).toBeCloseTo(1, 12);
    const h = 1;
    const fd = f.position(orbit, t + h).sub(f.position(orbit, t - h)).scale(1 / (2 * h));
    expect(fd.distanceTo(f.velocity(orbit, t)) / fd.length()).toBeLessThan(1e-6);
  });

  it('tidally locked rotation keeps longitude 0 facing the star', () => {
    const f = new SystemFrame(los, 89.7, 30);
    const rot = f.tidallyLocked(orbit);
    const m = new Mat3d();
    for (const t of [0, orbit.t0, orbit.t0 + 0.3 * orbit.periodS, 5e8]) {
      const subStellar = new Vec3d(1, 0, 0).applyMat3(bodyToIcrf(rot, t, m));
      const toStar = f.position(orbit, t).scale(-1).normalize();
      expect(subStellar.dot(toStar)).toBeGreaterThan(1 - 1e-9);
      // The spin axis is the orbit normal.
      expect(new Vec3d(0, 0, 1).applyMat3(m).dot(f.normal)).toBeCloseTo(1, 9);
    }
  });
});
