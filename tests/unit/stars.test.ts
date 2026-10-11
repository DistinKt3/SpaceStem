import { describe, expect, it } from 'vitest';
import { bolometricCorrectionV, bvToTeff, inferStar } from '../../src/world/starCatalog';

const R_SUN = 6.957e8;

describe('star inference', () => {
  it('B-V of the Sun gives ~5,770 K', () => {
    expect(bvToTeff(0.65)).toBeGreaterThan(5650);
    expect(bvToTeff(0.65)).toBeLessThan(5900);
  });

  it('bolometric correction matches Flower/Torres reference values', () => {
    // Sun: BC_V ~ -0.07 (consistent with M_V = 4.81, M_bol = 4.74).
    expect(bolometricCorrectionV(5772)).toBeCloseTo(-0.07, 1);
    // Cool stars need large negative corrections; hot stars too.
    expect(bolometricCorrectionV(3400)).toBeLessThan(-1.5);
    expect(bolometricCorrectionV(20000)).toBeLessThan(-1.5);
    // Late F / early G stars have the smallest correction.
    expect(Math.abs(bolometricCorrectionV(6500))).toBeLessThan(0.1);
  });

  it('recovers the Sun from its own magnitude and colour', () => {
    const s = inferStar(4.83, 0.65);
    expect(s.luminositySun).toBeGreaterThan(0.9);
    expect(s.luminositySun).toBeLessThan(1.1);
    expect(s.radiusM / R_SUN).toBeGreaterThan(0.9);
    expect(s.radiusM / R_SUN).toBeLessThan(1.1);
  });

  it('alpha Centauri A is within 15% of measured L = 1.52, R = 1.22 (Kervella et al. 2017)', () => {
    const s = inferStar(4.38, 0.71);
    expect(s.luminositySun / 1.52).toBeGreaterThan(0.85);
    expect(s.luminositySun / 1.52).toBeLessThan(1.15);
    expect(s.radiusM / R_SUN / 1.22).toBeGreaterThan(0.85);
    expect(s.radiusM / R_SUN / 1.22).toBeLessThan(1.15);
  });
});
