import { describe, expect, it } from 'vitest';
import { AU_M, LIGHT_YEAR_M, PARSEC_M, SPEED_OF_LIGHT_M_PER_S } from '../../src/core/constants';
import { auToMeters, lightTravelTime, metersToLightYears, parsecsToLightYears } from '../../src/core/units';
import { Mat3d, Vec3d } from '../../src/core/vec3d';
import { earthRotationAngle, tdbSecondsSinceJ2000ToUnixMs, unixMsToJdUtc, unixMsToTdbSecondsSinceJ2000 } from '../../src/core/time';
import { Rng, fbm3, hashInts, hashString, valueNoise3 } from '../../src/core/rng';
import { weakest } from '../../src/core/provenance';

describe('constants and units', () => {
  it('uses exact SI/IAU definitions', () => {
    expect(SPEED_OF_LIGHT_M_PER_S).toBe(299_792_458);
    expect(AU_M).toBe(149_597_870_700);
    expect(LIGHT_YEAR_M).toBe(9_460_730_472_580_800);
  });
  it('parsec is 648000/pi au and ~3.26156 ly', () => {
    expect(PARSEC_M / AU_M).toBeCloseTo(206_264.806_247, 5);
    expect(parsecsToLightYears(1)).toBeCloseTo(3.261_563_777, 8);
  });
  it('light from the Sun takes ~499.0 s to reach 1 au', () => {
    expect(lightTravelTime(auToMeters(1))).toBeCloseTo(499.004_784, 5);
  });
  it('round-trips meters <-> light-years', () => {
    expect(metersToLightYears(LIGHT_YEAR_M * 4.2465)).toBeCloseTo(4.2465, 12);
  });
});

describe('Vec3d / Mat3d', () => {
  it('keeps millimetre differences at 1e12 m (float64)', () => {
    const a = new Vec3d(1e12, -3e11, 7e11);
    const b = new Vec3d(1e12 + 0.001, -3e11, 7e11);
    expect(new Vec3d().subVectors(b, a).x).toBeCloseTo(0.001, 3); // float64 step at 1e12 m is ~0.12 mm
  });
  it('rotation and transpose are inverses', () => {
    const m = new Mat3d().rotationZ(0.7);
    const r = new Mat3d().rotationX(-0.3);
    const c = new Mat3d().multiplyMatrices(m, r);
    const v = new Vec3d(1, 2, 3);
    const w = v.clone().applyMat3(c).applyMat3Transpose(c);
    expect(w.x).toBeCloseTo(1, 12);
    expect(w.y).toBeCloseTo(2, 12);
    expect(w.z).toBeCloseTo(3, 12);
  });
  it('cross product follows the right-hand rule', () => {
    const z = new Vec3d(1, 0, 0).cross(new Vec3d(0, 1, 0));
    expect([z.x, z.y, z.z]).toEqual([0, 0, 1]);
  });
});

describe('time scales', () => {
  it('Unix epoch is JD 2440587.5', () => {
    expect(unixMsToJdUtc(0)).toBe(2_440_587.5);
  });
  it('TT seconds since J2000 for a 2026 UTC instant (TT-UTC = 69.184 s)', () => {
    const ms = Date.UTC(2026, 0, 1);
    const expected = (ms - Date.UTC(2000, 0, 1, 12)) / 1000 + 69.184;
    expect(unixMsToTdbSecondsSinceJ2000(ms)).toBeCloseTo(expected, 6);
    expect(tdbSecondsSinceJ2000ToUnixMs(unixMsToTdbSecondsSinceJ2000(ms))).toBeCloseTo(ms, 6);
  });
  it('Earth rotation angle at J2000 matches IERS (0.7790572732640 turns)', () => {
    expect(earthRotationAngle(2_451_545.0) / (2 * Math.PI)).toBeCloseTo(0.779_057_273_264, 12);
  });
});

describe('determinism', () => {
  it('hashes are stable golden values', () => {
    expect(hashInts(42, 1, 2, 3)).toBe(hashInts(42, 1, 2, 3));
    expect(hashString('TRAPPIST-1 e')).toBe(hashString('TRAPPIST-1 e'));
    // Golden values pin the algorithm: changing them changes every generated world.
    expect(hashInts(0)).toMatchInlineSnapshot(`2462723854`);
    expect(hashString('Known Sky')).toMatchInlineSnapshot(`4103780325`);
  });
  it('Rng sequence is reproducible and in [0,1)', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    for (let i = 0; i < 1000; i++) {
      const x = a.next();
      expect(x).toBe(b.next());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
  it('noise is continuous and bounded', () => {
    const v0 = valueNoise3(7, 1.5, 2.5, 3.5);
    const v1 = valueNoise3(7, 1.5 + 1e-6, 2.5, 3.5);
    expect(Math.abs(v0 - v1)).toBeLessThan(1e-4);
    for (let i = 0; i < 200; i++) {
      const f = fbm3(3, i * 0.37, i * 0.11, i * 0.73, 6);
      expect(Math.abs(f)).toBeLessThanOrEqual(1);
    }
  });
});

describe('provenance', () => {
  it('weakest picks the least certain tier', () => {
    expect(weakest('measured', 'inferred')).toBe('inferred');
    expect(weakest('measured', 'generated', 'inferred')).toBe('generated');
    expect(weakest()).toBe('measured');
  });
});
