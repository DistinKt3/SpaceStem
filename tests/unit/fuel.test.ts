import { describe, expect, it } from 'vitest';
import { AU_M, SUN_RADIUS_M, SUN_TEFF_K } from '../../src/core/constants';
import {
  FUEL,
  FUEL_STORAGE_KEY,
  FuelSystem,
  distanceForFlux,
  equilibriumHeat,
  fluxForHeat,
  fluxSolar,
  heatStateFor,
  inScoopBand,
  jumpCost,
  loadFuel,
  rangeFor,
  saveFuel,
  scoopRate,
  surfaceFluxSolar,
  type FuelEvent,
  type FuelStorage,
  type StarEnv,
} from '../../src/game/ship/fuel';
import { hasKey, keySources, t } from '../../src/game/i18n';
import { readFileSync } from 'node:fs';

/** Measured stellar parameters (see docs/FUEL.md for sources). */
const SUN = { radiusM: SUN_RADIUS_M, luminositySun: 1, teffK: SUN_TEFF_K };
const ALPHA_CEN_A = { radiusM: 1.2234 * SUN_RADIUS_M, luminositySun: 1.521, teffK: 5795 };
const PROXIMA = { radiusM: 0.146 * SUN_RADIUS_M, luminositySun: 0.00151, teffK: 2980 };
const SIRIUS_A = { radiusM: 1.713 * SUN_RADIUS_M, luminositySun: 24.7, teffK: 9845 };

const at = (star: Omit<StarEnv, 'distanceM'>, radii: number): StarEnv => ({ ...star, distanceM: radii * star.radiusM });
const CRUISE = { mode: 'cruise', throttle: 1, landed: false };

/** Runs a system for `seconds` in fixed frames and collects every event. */
function run(sys: FuelSystem, seconds: number, env: StarEnv | null, ctx = CRUISE, frame = 1 / 60): FuelEvent[] {
  const out: FuelEvent[] = [];
  const n = Math.round(seconds / frame);
  for (let i = 0; i < n; i++) out.push(...sys.update(frame, env, ctx));
  return out;
}

describe('stellar flux', () => {
  it('is one solar constant for the Sun at 1 au (Kopp & Lean 2011 / IAU 2015 B3)', () => {
    expect(fluxSolar({ ...SUN, distanceM: AU_M })).toBeCloseTo(1, 3);
  });
  it('follows the inverse-square law and scales with luminosity', () => {
    const f1 = fluxSolar({ ...SUN, distanceM: AU_M });
    expect(fluxSolar({ ...SUN, distanceM: 2 * AU_M })).toBeCloseTo(f1 / 4, 9);
    expect(fluxSolar({ ...SUN, luminositySun: 10, distanceM: AU_M })).toBeCloseTo(f1 * 10, 9);
  });
  it('matches sigma T^4 at the solar photosphere (about 46,000 x the solar constant)', () => {
    const surf = surfaceFluxSolar(SUN);
    expect(surf / (AU_M / SUN_RADIUS_M) ** 2).toBeCloseTo(1, 3);
    expect(surf).toBeGreaterThan(46_000);
    expect(surf).toBeLessThan(46_500);
    // sigma * 5772^4 / 1361 W/m^2
    expect(surf / ((5.670374419e-8 * SUN_TEFF_K ** 4) / 1361)).toBeCloseTo(1, 2);
  });
  it('derives the luminosity from radius and temperature when luminosity is missing', () => {
    expect(fluxSolar({ ...SUN, luminositySun: Number.NaN, distanceM: AU_M })).toBeCloseTo(1, 2);
    expect(fluxSolar({ ...SUN, luminositySun: 0, distanceM: AU_M })).toBeCloseTo(1, 2);
  });
  it('is clamped at the photosphere and zero for invalid distances', () => {
    expect(fluxSolar({ ...SUN, distanceM: 0 })).toBeCloseTo(surfaceFluxSolar(SUN), 6);
    expect(fluxSolar({ ...SUN, distanceM: Number.POSITIVE_INFINITY })).toBe(0);
    expect(fluxSolar({ ...SUN, distanceM: Number.NaN })).toBe(0);
  });
  it('round-trips through distanceForFlux', () => {
    // 2,000 x S0 lies outside the photosphere of all four stars (Proxima's surface gives about 3,300).
    for (const star of [SUN, ALPHA_CEN_A, PROXIMA, SIRIUS_A]) {
      const d = distanceForFlux(star, 2_000);
      expect(d).toBeGreaterThan(star.radiusM);
      expect(fluxSolar({ ...star, distanceM: d })).toBeCloseTo(2_000, 6);
    }
  });
});

describe('jump cost', () => {
  it('a full tank reaches 50 ly, and no further', () => {
    expect(jumpCost(50)).toBeCloseTo(1, 12);
    const f = new FuelSystem({ hyperFuel: 1 });
    expect(f.canJump(50)).toBe(true);
    expect(f.canJump(50.1)).toBe(false);
    expect(rangeFor(1)).toBeCloseTo(50, 6);
  });
  it('one jump to alpha Centauri (4.37 ly) costs 15-20% of the tank', () => {
    expect(jumpCost(4.37)).toBeGreaterThanOrEqual(0.15);
    expect(jumpCost(4.37)).toBeLessThanOrEqual(0.2);
  });
  it('has a minimum cost per jump', () => {
    expect(jumpCost(0)).toBe(FUEL.minJumpCost);
    expect(jumpCost(0.01)).toBe(FUEL.minJumpCost);
  });
  it('never decreases with distance and grows more slowly than distance', () => {
    let prev = 0;
    for (let ly = 0; ly <= 200; ly += 0.25) {
      const c = jumpCost(ly);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
    // Sublinear: doubling the distance less than doubles the cost (above the minimum).
    expect(jumpCost(20) / jumpCost(10)).toBeLessThan(2);
    expect(jumpCost(40) / jumpCost(20)).toBeCloseTo(2 ** FUEL.costExponent, 9);
  });
  it('refuses invalid distances (NaN, infinite, negative)', () => {
    const f = new FuelSystem();
    for (const bad of [Number.NaN, Infinity, -Infinity, -3, -1e-9]) {
      expect(jumpCost(bad), String(bad)).toBe(Infinity);
      expect(f.canJump(bad), String(bad)).toBe(false);
      f.consumeJump(bad);
    }
    expect(f.hyperFuel).toBe(1);
    // Review: a nearly empty tank must not afford a jump of -Infinity.
    expect(new FuelSystem({ hyperFuel: 0.05 }).canJump(-Infinity)).toBe(false);
    expect(jumpCost(0)).toBe(FUEL.minJumpCost);
  });
  it('consumeJump subtracts the cost and never empties below zero', () => {
    const f = new FuelSystem({ hyperFuel: 0.5 });
    f.consumeJump(4.37);
    expect(f.hyperFuel).toBeCloseTo(0.5 - jumpCost(4.37), 12);
    f.consumeJump(50);
    expect(f.hyperFuel).toBe(0);
    expect(f.canJump(0)).toBe(false);
  });
  it('allows a jump that costs exactly the fuel left', () => {
    const f = new FuelSystem({ hyperFuel: jumpCost(8.6) });
    expect(f.canJump(8.6)).toBe(true);
    f.consumeJump(8.6);
    expect(f.hyperFuel).toBe(0);
  });
});

describe('scoop band', () => {
  it('opens at 1,000 x the solar constant', () => {
    expect(inScoopBand(999)).toBe(false);
    expect(inScoopBand(1_000)).toBe(true);
    expect(scoopRate(999, 1)).toBe(0);
    expect(scoopRate(1_000, 1)).toBeCloseTo(FUEL.scoopRateAtEdge, 12);
  });
  it('rate scales with flux (linear below the cap) and with throttle', () => {
    expect(scoopRate(4_000, 1) / scoopRate(2_000, 1)).toBeCloseTo(2, 12);
    expect(scoopRate(1e7, 1)).toBe(FUEL.scoopRateMax);
    expect(scoopRate(2_000, 0)).toBeCloseTo(scoopRate(2_000, 1) * FUEL.scoopIdleFactor, 12);
    expect(scoopRate(2_000, -0.5)).toBeCloseTo(scoopRate(2_000, 0.5), 12);
  });
  it('dim M dwarfs need the ship much closer in stellar radii; hot stars open the band far out', () => {
    const edge = (s: typeof SUN): number => distanceForFlux(s, FUEL.scoopMinFlux) / s.radiusM;
    expect(edge(SUN)).toBeCloseTo(6.8, 1);
    expect(edge(ALPHA_CEN_A)).toBeCloseTo(6.86, 1);
    expect(edge(PROXIMA)).toBeLessThan(2);
    expect(edge(SIRIUS_A)).toBeGreaterThan(19);
    // At the same distance in stellar radii a hotter star scoops faster and heats more.
    expect(scoopRate(fluxSolar(at(SIRIUS_A, 10)), 1)).toBeGreaterThan(scoopRate(fluxSolar(at(SUN, 10)), 1));
    expect(fluxSolar(at(SUN, 10))).toBeLessThan(FUEL.scoopMinFlux);
    expect(equilibriumHeat(fluxSolar(at(SIRIUS_A, 3)))).toBeGreaterThan(1);
    // Proxima never reaches the warning level, even at its photosphere.
    expect(equilibriumHeat(surfaceFluxSolar(PROXIMA))).toBeLessThan(FUEL.heatWarning);
  });
  it('scoops only in the band, outside the star, not landed and not in hyperspeed', () => {
    const near = at(SUN, 3);
    const f = new FuelSystem({ hyperFuel: 0.2 });
    expect(f.update(0.1, at(SUN, 8), CRUISE)).toEqual([]);
    expect(f.scooping).toBe(false);
    expect(f.update(0.1, near, CRUISE)).toContain('scoop-start');
    expect(f.scooping).toBe(true);
    expect(f.update(0.1, near, { ...CRUISE, mode: 'hyperspeed' })).toContain('scoop-stop');
    expect(f.update(0.1, near, CRUISE)).toContain('scoop-start');
    expect(f.update(0.1, near, { ...CRUISE, landed: true })).toContain('scoop-stop');
    expect(f.update(0.1, null, CRUISE)).toEqual([]);
    expect(f.scooping).toBe(false);
    expect(f.fluxSolar).toBe(0);
    f.update(0.1, { ...SUN, distanceM: SUN_RADIUS_M * 0.5 }, CRUISE);
    expect(f.scooping).toBe(false);
  });
  it('fills the tank at the documented rate, then reports tank-full and stops', () => {
    const env = at(SUN, 3);
    const flux = fluxSolar(env);
    const f = new FuelSystem({ hyperFuel: 0.5, heat: 0.6 });
    const ev = run(f, 1, env);
    expect(ev).toEqual(['scoop-start']);
    expect(f.hyperFuel).toBeCloseTo(0.5 + scoopRate(flux, 1), 6);
    expect(f.secondsToFull).toBeCloseTo((1 - f.hyperFuel) / scoopRate(flux, 1), 6);
    const rest = run(f, 60, env);
    expect(rest).toContain('tank-full');
    expect(rest.indexOf('tank-full')).toBeLessThan(rest.indexOf('scoop-stop'));
    expect(f.hyperFuel).toBe(1);
    expect(f.scooping).toBe(false);
    expect(f.secondsToFull).toBeNull();
    // A full tank in the band does not restart scooping.
    expect(run(f, 5, env)).not.toContain('scoop-start');
  });
});

describe('hull heat', () => {
  it('settles at the Stefan-Boltzmann-shaped equilibrium (F / F_limit)^(1/4)', () => {
    for (const flux of [1_000, 5_000, 12_000]) {
      const env: StarEnv = { ...SUN, distanceM: distanceForFlux(SUN, flux) };
      const f = new FuelSystem({ heat: 0.3 });
      run(f, 400, env, CRUISE, 0.1);
      expect(f.heat).toBeCloseTo(equilibriumHeat(flux), 3);
      expect(f.equilibriumHeat).toBeCloseTo(Math.pow(flux / FUEL.heatLimitFlux, 0.25), 9);
    }
    expect(fluxForHeat(equilibriumHeat(7_000))).toBeCloseTo(7_000, 6);
  });
  it('rises faster near a hotter star at the same distance in stellar radii', () => {
    const a = new FuelSystem({ heat: 0.3 });
    const b = new FuelSystem({ heat: 0.3 });
    run(a, 3, at(SUN, 4));
    run(b, 3, at(SIRIUS_A, 4));
    expect(b.heat).toBeGreaterThan(a.heat);
  });
  it('cools radiatively away from stars, slowly at low heat', () => {
    const f = new FuelSystem({ heat: 0.95 });
    run(f, 10, null);
    const after10 = f.heat;
    expect(after10).toBeLessThan(0.95);
    // Integral of dh/dt = -h^4 / tau: 1/h^3 = 1/h0^3 + 3 t / tau.
    expect(after10).toBeCloseTo(Math.pow(1 / 0.95 ** 3 + (3 * 10) / FUEL.heatTimeConstantS, -1 / 3), 3);
    run(f, 10, null);
    expect(after10 - f.heat).toBeLessThan(0.95 - after10);
  });
  it('raises warning, critical and emergency once each, with hysteresis', () => {
    const f = new FuelSystem({ heat: 0.5, hyperFuel: 1 });
    const hot: StarEnv = { ...SUN, distanceM: distanceForFlux(SUN, FUEL.heatLimitFlux * 1.6) };
    const events: FuelEvent[] = [];
    const states: string[] = [f.heatState];
    for (let i = 0; i < 60 * 20; i++) {
      events.push(...f.update(1 / 60, hot, CRUISE));
      if (states.at(-1) !== f.heatState) states.push(f.heatState);
    }
    expect(states).toEqual(['nominal', 'warning', 'critical', 'emergency']);
    expect(events.filter((e) => e.startsWith('heat-'))).toEqual(['heat-warning', 'heat-critical', 'heat-emergency']);
    expect(f.heat).toBe(1);
    // Cooling just below the emergency level does not re-arm or re-fire.
    expect(heatStateFor('emergency', 0.97)).toBe('emergency');
    expect(heatStateFor('emergency', 0.93)).toBe('critical');
    expect(heatStateFor('critical', 0.88)).toBe('critical');
    expect(heatStateFor('critical', 0.84)).toBe('warning');
    expect(heatStateFor('warning', 0.66)).toBe('warning');
    expect(heatStateFor('warning', 0.64)).toBe('nominal');
    expect(heatStateFor('nominal', 0.95)).toBe('critical');
    // Leave, cool to nominal, return: the events fire again.
    run(f, 300, null);
    expect(f.heatState).toBe('nominal');
    const again = run(f, 20, hot);
    expect(again.filter((e) => e.startsWith('heat-')).length).toBeGreaterThan(0);
  });
  it('reports only the highest level when one step crosses several', () => {
    const f = new FuelSystem({ heat: 0.5 });
    const ev = f.update(30, { ...SUN, distanceM: SUN_RADIUS_M * 1.05 }, CRUISE);
    expect(ev.filter((e) => e.startsWith('heat-'))).toEqual(['heat-emergency']);
  });
  it('is independent of the frame rate (fixed substeps)', () => {
    const env = at(SUN, 2.2);
    const a = new FuelSystem({ hyperFuel: 0.1, heat: 0.4 });
    const b = new FuelSystem({ hyperFuel: 0.1, heat: 0.4 });
    run(a, 12, env, CRUISE, 1 / 60);
    run(b, 12, env, CRUISE, 0.1);
    expect(a.heat).toBeCloseTo(b.heat, 3);
    expect(a.hyperFuel).toBeCloseTo(b.hyperFuel, 6);
  });
  it('is deterministic', () => {
    const go = (): string => {
      const f = new FuelSystem({ hyperFuel: 0.3 });
      const ev = run(f, 30, at(SIRIUS_A, 6));
      return JSON.stringify([f.toJSON(), ev]);
    };
    expect(go()).toBe(go());
  });
  it('ignores invalid time steps', () => {
    const f = new FuelSystem({ heat: 0.5, hyperFuel: 0.5 });
    f.update(Number.NaN, at(SUN, 2), CRUISE);
    f.update(-5, at(SUN, 2), CRUISE);
    expect(f.heat).toBe(0.5);
    expect(f.hyperFuel).toBe(0.5);
  });
});

describe('fuel-low', () => {
  it('fires once when the tank drops below the threshold and re-arms after refuelling', () => {
    const f = new FuelSystem({ hyperFuel: 0.3 });
    expect(f.update(0.1, null, CRUISE)).toEqual([]);
    f.consumeJump(4.37);
    expect(f.update(0.1, null, CRUISE)).toEqual(['fuel-low']);
    expect(run(f, 1, null)).toEqual([]);
    f.refuel(0.04); // inside the hysteresis band: still low, no repeat
    expect(f.update(0.1, null, CRUISE)).toEqual([]);
    f.refuel(1);
    f.update(0.1, null, CRUISE);
    f.consumeJump(40);
    expect(f.update(0.1, null, CRUISE)).toEqual(['fuel-low']);
  });
  it('fires on the first update after loading a low tank', () => {
    expect(new FuelSystem({ hyperFuel: 0.05 }).update(0.016, null, CRUISE)).toEqual(['fuel-low']);
  });
});

describe('serialisation', () => {
  it('round-trips through JSON', () => {
    const f = new FuelSystem({ hyperFuel: 0.4321, heat: 0.77 });
    const g = FuelSystem.fromJSON(JSON.parse(JSON.stringify(f)));
    expect(g.toJSON()).toEqual({ version: 1, hyperFuel: 0.4321, heat: 0.77 });
    expect(g.heatState).toBe('warning');
    expect(FuelSystem.fromJSON(JSON.stringify(f)).toJSON()).toEqual(f.toJSON());
  });
  it('sanitises corrupt or partial data field by field', () => {
    expect(FuelSystem.fromJSON(null).toJSON()).toEqual({ version: 1, hyperFuel: 1, heat: 0 });
    expect(FuelSystem.fromJSON('{nope').toJSON()).toEqual({ version: 1, hyperFuel: 1, heat: 0 });
    expect(FuelSystem.fromJSON([1, 2]).toJSON()).toEqual({ version: 1, hyperFuel: 1, heat: 0 });
    expect(FuelSystem.fromJSON({ hyperFuel: 7, heat: -1 }).toJSON()).toEqual({ version: 1, hyperFuel: 1, heat: 0 });
    expect(FuelSystem.fromJSON({ hyperFuel: '0.5', heat: 0.25 }).toJSON()).toEqual({ version: 1, hyperFuel: 1, heat: 0.25 });
    expect(new FuelSystem({ hyperFuel: Number.NaN }).hyperFuel).toBe(1);
  });
  it('saves to and loads from storage, surviving storage errors', () => {
    const mem = new Map<string, string>();
    const storage: FuelStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
    expect(loadFuel(storage).hyperFuel).toBe(1);
    saveFuel(new FuelSystem({ hyperFuel: 0.25, heat: 0.1 }), storage);
    expect(JSON.parse(mem.get(FUEL_STORAGE_KEY)!)).toEqual({ version: 1, hyperFuel: 0.25, heat: 0.1 });
    expect(loadFuel(storage).hyperFuel).toBe(0.25);
    const broken: FuelStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadFuel(broken).hyperFuel).toBe(1);
    expect(() => saveFuel(new FuelSystem(), broken)).not.toThrow();
    expect(loadFuel(null).hyperFuel).toBe(1);
  });
});

describe('heat events for a system created or restored hot', () => {
  const far: StarEnv = { ...SUN, distanceM: 1e15 };
  const ctx = { mode: 'cruise', throttle: 0, landed: false };
  it('reports the hull limit on the first update, so the ship climbs (review: no climb after restoring at the limit)', () => {
    const f = new FuelSystem({ hyperFuel: 0.5, heat: 1 });
    expect(f.heatState).toBe('emergency');
    // Far above the limit flux (Sirius A at 3 radii) the first update reports the emergency once.
    const sirius: StarEnv = { ...SIRIUS_A, distanceM: 3 * SIRIUS_A.radiusM };
    expect(f.update(0.1, sirius, ctx)).toContain('heat-emergency');
    expect(f.update(0.1, sirius, ctx)).not.toContain('heat-emergency');
    expect(FuelSystem.fromJSON({ version: 1, hyperFuel: 0.5, heat: 1 }).update(0, null, ctx)).toContain('heat-emergency');
  });
  it('reports the highest level reached, once, for warning and critical starts too', () => {
    expect(new FuelSystem({ heat: 0.75 }).update(0, far, ctx)).toEqual(['heat-warning']);
    expect(new FuelSystem({ heat: 0.95 }).update(0, far, ctx)).toEqual(['heat-critical']);
    const f = new FuelSystem({ heat: 0.95 });
    f.update(0, far, ctx);
    expect(f.update(0.1, far, ctx)).toEqual([]);
    expect(new FuelSystem({ heat: 0.2 }).update(0, far, ctx)).toEqual([]);
  });
});

describe('fuel strings', () => {
  it('has every key the gauge and integration use', () => {
    for (const k of [
      'fuel.gauge.label',
      'fuel.gauge.fiction',
      'fuel.gauge.noJump',
      'fuel.gauge.tooClose',
      'fuel.gauge.underway',
      'fuel.gauge.underwayPaid',
      'fuel.error.insufficient',
      'fuel.warn.emergencyClimb',
      'fuel.demo.limit.emergency',
      'fuel.say.fuelLow',
      ...['nominal', 'warning', 'critical', 'emergency'].flatMap((s) => [`fuel.heat.${s}`, `fuel.say.heat.${s}`]),
      ...(['scoop-start', 'scoop-stop', 'tank-full', 'heat-warning', 'heat-critical', 'heat-emergency', 'fuel-low'] as FuelEvent[]).map(
        (e) => `fuel.demo.event.${e}`,
      ),
    ])
      expect(hasKey(k), k).toBe(true);
  });
  it('has no unused strings (review: dead keys)', () => {
    const files = ['src/game/ship/fuel.ts', 'src/game/ship/fuelGauge.ts', 'src/game/ship/shipFuel.ts', 'src/game/ship/shipController.ts', 'src/spike/fuelDemo.ts'];
    const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    const keys = keySources()
      .filter((k) => k.file.endsWith('en.fuel.json'))
      .map((k) => k.key);
    expect(keys.length).toBeGreaterThan(50);
    // A key is used when the source names it, or builds it from a template prefix and names its varying part.
    const used = (key: string): boolean => {
      if (src.includes(`'${key}'`)) return true;
      const cut = key.lastIndexOf('.');
      const prefix = key.slice(0, cut + 1);
      const last = key.slice(cut + 1).replace(/Sub$/, '');
      return src.includes(`\`${prefix}\${`) && new RegExp(`['"\`]${last}['"\`]`).test(src);
    };
    expect(keys.filter((k) => !used(k))).toEqual([]);
  });
  it('labels the mechanic as fiction in player-facing text', () => {
    for (const k of ['fuel.gauge.label', 'fuel.gauge.fiction', 'fuel.gauge.fictionNote', 'fuel.error.insufficient', 'fuel.demo.subtitle']) {
      expect(t(k).toLowerCase(), k).toMatch(/game mechanic/);
    }
  });
});
