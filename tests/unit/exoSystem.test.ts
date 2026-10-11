import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AU_M, DAY_S, J2000_JD, PARSEC_M, SPEED_OF_LIGHT_M_PER_S } from '../../src/core/constants';
import { hashString } from '../../src/core/rng';
import { hasKey, t } from '../../src/game/i18n';
import {
  ATMOSPHERES,
  atmosphereLabelKey,
  bjdToTdbSeconds,
  COMPOSITIONS,
  compositionLabelKey,
  equilibriumTemp,
  INFERRED_FIELDS,
  insolation,
  lightTimeSeconds,
  loadSystem,
  MEASURED_FIELDS,
  orbitalFrameToIcrs,
  orbitalPhase,
  orbitalPosition,
  orbitalSpeed,
  sigma,
  TERRAINS,
  terrainLabelKey,
  toCoreSourced,
  validateSystem,
  type ExoSourced,
  type ExoSystem,
} from '../../src/world/exo/systemData';

const FILE = resolve(import.meta.dirname, '../../public/data/systems/trappist-1.json');
const raw = readFileSync(FILE, 'utf8');
const load = (): ExoSystem => JSON.parse(raw) as ExoSystem;
const sys = load();
const LETTERS = ['b', 'c', 'd', 'e', 'f', 'g', 'h'];

/** Every Sourced-shaped object in the file, with its JSON path. */
function allSourced(obj: unknown, path = ''): { path: string; s: ExoSourced<unknown> }[] {
  if (typeof obj !== 'object' || obj === null) return [];
  if (Array.isArray(obj)) return obj.flatMap((v, i) => allSourced(v, `${path}[${i}]`));
  const o = obj as Record<string, unknown>;
  if ('value' in o && 'provenance' in o) return [{ path, s: o as unknown as ExoSourced<unknown> }];
  return Object.entries(o).flatMap(([k, v]) => allSourced(v, path ? `${path}.${k}` : k));
}

describe('trappist-1.json schema', () => {
  it('passes validateSystem', () => {
    expect(validateSystem(load())).toEqual([]);
  });

  it('describes TRAPPIST-1 with a retrieval date and a live planet count', () => {
    expect(sys.id).toBe('trappist-1');
    expect(sys.name).toBe('TRAPPIST-1');
    expect(sys.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sys.exoplanetCount.value).toBeGreaterThan(5000);
    expect(sys.exoplanetCount.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sys.exoplanetCount.source).toContain('pscomppars');
  });

  it('has the seven planets b..h with ids, names and letters', () => {
    expect(sys.planets.map((p) => p.letter)).toEqual(LETTERS);
    for (const p of sys.planets) {
      expect(p.id).toBe(`trappist-1${p.letter}`);
      expect(p.name).toBe(`TRAPPIST-1 ${p.letter}`);
      expect(p.defaultParameterSet.citation).toBe('agol2021');
    }
  });

  it('orders orbital periods b < c < d < e < f < g < h, and semi-major axes likewise', () => {
    const periods = sys.planets.map((p) => p.measured.periodDays.value);
    const axes = sys.planets.map((p) => p.measured.semiMajorAxisAu.value);
    for (let i = 1; i < periods.length; i++) {
      expect(periods[i]!).toBeGreaterThan(periods[i - 1]!);
      expect(axes[i]!).toBeGreaterThan(axes[i - 1]!);
    }
    expect(periods[0]).toBeCloseTo(1.510826, 6);
    expect(periods[6]).toBeCloseTo(18.772866, 6);
  });

  it('gives every catalogued field a provenance, source, unit, uncertainty and a resolvable citation', () => {
    // Derived by the source (T_eff from L and R, R from the transit density and a mass relation, the age from empirical
    // indicators) or computed here (distance = 1/parallax): Inferred, with a note saying how (D-036).
    const derived = new Set(['star.teffK', 'star.radiusSun', 'star.massSun', 'star.ageGyr', 'position.distancePc']);
    const measured = [
      ...sys.planets.flatMap((p) => MEASURED_FIELDS.map((k) => ({ path: `${p.id}.${k}`, s: p.measured[k] }))),
      ...Object.entries(sys.star).map(([k, s]) => ({ path: `star.${k}`, s: s as ExoSourced<unknown> })),
      ...Object.entries(sys.position).map(([k, s]) => ({ path: `position.${k}`, s: s as ExoSourced<unknown> })),
    ];
    expect(measured.length).toBe(7 * 7 + 12 + 3);
    for (const { path, s } of measured) {
      expect(s.provenance, path).toBe(derived.has(path) ? 'inferred' : 'measured');
      if (derived.has(path)) expect(s.note?.length ?? 0, `${path} note`).toBeGreaterThan(20);
      expect(s.citation, path).toMatch(/^[a-z0-9-]+$/);
      expect(sys.citations[s.citation], `${path} citation ${s.citation}`).toBeDefined();
      expect(s.source.length, path).toBeGreaterThan(10);
      expect(typeof s.unit, path).toBe('string');
      if (typeof s.value === 'number' && !path.endsWith('gaiaDr3Id')) expect(s.uncertainty, `${path} uncertainty`).toBeDefined();
    }
  });

  it('labels inferred values inferred and the generated orientation generated; nothing generated poses as measured', () => {
    for (const p of sys.planets) {
      for (const k of INFERRED_FIELDS) {
        expect(p.inferred[k].provenance).toBe('inferred');
        expect(p.inferred[k].note ?? '', `${p.id}.${k} needs a note with its assumptions`).not.toBe('');
      }
      expect(p.generated.provenance).toBe('generated');
      expect(p.generated.rationale.length).toBeGreaterThan(40);
    }
    expect(sys.orbitalPlane.nodeDeg.provenance).toBe('generated');
    expect(sys.orbitalPlane.inclinationDeg.provenance).toBe('inferred');
    for (const { path, s } of allSourced(sys)) {
      expect(sys.citations[s.citation], `${path}: ${s.citation}`).toBeDefined();
      if (s.provenance === 'measured') expect(path, path).not.toMatch(/generated|inferred|orbitalPlane/);
    }
  });

  it('lists every citation with a year, a venue and a DOI or URL', () => {
    const keys = Object.keys(sys.citations);
    expect(keys).toEqual(expect.arrayContaining(['agol2021', 'nasa-exoplanet-archive', 'greene2023', 'zieba2023', 'turbet2018', 'vinson2019']));
    for (const [k, c] of Object.entries(sys.citations)) {
      expect(c.year, k).toBeGreaterThan(1990);
      expect(c.doi ?? c.url, k).toBeTruthy();
      if (c.doi) expect(c.doi, k).toMatch(/^10\.\d{4,5}\//);
    }
  });

  it('uses only known class codes, with i18n labels for each', () => {
    for (const p of sys.planets) {
      expect(COMPOSITIONS).toContain(p.inferred.composition.value);
      expect(ATMOSPHERES).toContain(p.inferred.atmosphere.value);
      expect(TERRAINS).toContain(p.generated.terrain);
    }
    for (const c of COMPOSITIONS) expect(hasKey(compositionLabelKey(c)), c).toBe(true);
    for (const a of ATMOSPHERES) expect(hasKey(atmosphereLabelKey(a)), a).toBe(true);
    for (const t of TERRAINS) expect(hasKey(terrainLabelKey(t)), t).toBe(true);
  });

  it('records the JWST results for b and c and leaves the others unknown', () => {
    const atm = Object.fromEntries(sys.planets.map((p) => [p.letter, p.inferred.atmosphere]));
    expect(atm['b']!.value).toBe('thick-co2-disfavoured');
    expect(atm['b']!.citation).toBe('greene2023');
    expect(atm['c']!.value).toBe('thick-co2-disfavoured');
    expect(atm['c']!.citation).toBe('zieba2023');
    for (const l of ['d', 'e', 'f', 'g', 'h']) expect(atm[l]!.value, l).toBe('unknown');
    // Hedged as the sources are: Gillon et al. 2026 disfavour >= 1 bar atmospheres *with efficient greenhouse effects*.
    for (const l of ['b', 'c']) expect(atm[l]!.note, l).toContain('1 bar or more and efficient greenhouse effects');
    expect(t(atmosphereLabelKey('thick-co2-disfavoured'))).toMatch(/disfavoured/i);
  });

  it('flags tidal locking as likely, with the Vinson et al. 2019 caveat for d, e and f', () => {
    for (const p of sys.planets) {
      const note = p.inferred.tidallyLocked.note ?? '';
      expect(note, p.id).toContain('Vinson et al. 2019');
      expect(note, p.id).toContain(['d', 'e', 'f'].includes(p.letter) ? 'may not keep exactly one face' : 'did not model this planet');
    }
    expect(t('exo.bool.true')).toMatch(/likely/i);
    // The tholin tint is presented as our design choice, not as Turbet et al.'s finding.
    for (const p of sys.planets.filter((x) => x.generated.rationale.includes('tholin'))) {
      expect(p.generated.rationale, p.id).toContain('As a design choice');
    }
  });

  it('derives the generated seed from the planet id and keeps generated values in range', () => {
    for (const p of sys.planets) {
      const g = p.generated;
      expect(g.seed).toBe(hashString(p.id));
      expect(g.palette).toHaveLength(5);
      for (const c of g.palette) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      for (const v of [g.albedo, g.iceCoverage, g.nightSideGlow]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    // Causal rules: no ice inside the runaway-greenhouse limit; ice grows outward.
    const ice = sys.planets.map((p) => p.generated.iceCoverage);
    expect(ice.slice(0, 3)).toEqual([0, 0, 0]);
    for (let i = 4; i < ice.length; i++) expect(ice[i]!).toBeGreaterThanOrEqual(ice[i - 1]!);
  });
});

describe('inferred values match their formulas', () => {
  const st = sys.star;

  it('equilibrium temperature at albedo 0 and 0.3', () => {
    for (const p of sys.planets) {
      const a = p.measured.semiMajorAxisAu.value;
      const t0 = equilibriumTemp(st.teffK.value, st.radiusSun.value, a, 0);
      const t30 = equilibriumTemp(st.teffK.value, st.radiusSun.value, a, 0.3);
      expect(Math.abs(t0 - p.inferred.equilibriumTempK_A0.value), p.id).toBeLessThan(0.11);
      expect(Math.abs(t30 - p.inferred.equilibriumTempK_A030.value), p.id).toBeLessThan(0.11);
      expect(p.inferred.equilibriumTempK_A0.unit).toBe('K');
    }
  });

  it('agrees with the archive (Ducrot et al. 2020) equilibrium temperatures within a kelvin', () => {
    const ducrot = [397.6, 339.7, 286.2, 249.7, 217.7, 197.3, 171.7];
    sys.planets.forEach((p, i) => {
      expect(Math.abs(p.inferred.equilibriumTempK_A0.value - ducrot[i]!), p.id).toBeLessThan(1);
    });
  });

  it('insolation S = L / a^2 within 0.1%, and the published Agol et al. 2021 values within 0.5%', () => {
    const agol = [4.153, 2.214, 1.115, 0.646, 0.373, 0.252, 0.144];
    sys.planets.forEach((p, i) => {
      const s = insolation(st.luminositySun.value, p.measured.semiMajorAxisAu.value);
      expect(Math.abs(s / p.inferred.insolationEarth.value - 1), p.id).toBeLessThan(1e-3);
      expect(Math.abs(s / agol[i]! - 1), p.id).toBeLessThan(5e-3);
    });
  });

  it('density, gravity and escape velocity from mass and radius', () => {
    for (const p of sys.planets) {
      const m = p.measured.massEarth.value;
      const r = p.measured.radiusEarth.value;
      expect(p.inferred.densityRelEarth.value).toBeCloseTo(m / r ** 3, 3);
      expect(p.inferred.surfaceGravityG.value).toBeCloseTo(m / r ** 2, 3);
      expect(p.inferred.escapeVelocityKms.value).toBeCloseTo(11.186 * Math.sqrt(m / r), 2);
      expect(p.inferred.tidallyLocked.value).toBe(true);
    }
  });

  it('reproduces Earth: 1 L_sun at 1 au gives S = 1 and Teq of 278 K (A = 0) and 255 K (A = 0.3)', () => {
    expect(insolation(1, 1)).toBe(1);
    expect(equilibriumTemp(5772, 1, 1, 0)).toBeCloseTo(278.3, 1); // (1361 W/m^2 / 4 sigma)^(1/4)
    expect(equilibriumTemp(5772, 1, 1, 0.3)).toBeCloseTo(254.6, 1);
  });

  it('luminosity is 10^logL', () => {
    expect(st.luminositySun.value / Math.pow(10, st.luminosityLogSun.value)).toBeCloseTo(1, 3);
  });
});

describe('orbital positions', () => {
  const b = sys.planets[0]!;
  const h = sys.planets[6]!;
  const t0 = (p: typeof b): number => bjdToTdbSeconds(p.inferred.ephemerisTransitMidBJD.value);

  it('converts BJD_TDB to TDB seconds since J2000', () => {
    expect(bjdToTdbSeconds(J2000_JD)).toBe(0);
    expect(bjdToTdbSeconds(J2000_JD + 1)).toBe(DAY_S);
  });

  it('puts the planet on +x (toward the Solar System) at transit and on +y a quarter period later', () => {
    for (const p of [b, h]) {
      const a = p.measured.semiMajorAxisAu.value * AU_M;
      const P = p.inferred.ephemerisPeriodDays.value * DAY_S;
      const at0 = orbitalPosition(p, t0(p));
      expect(at0.x / a).toBeCloseTo(1, 9);
      expect(at0.y / a).toBeCloseTo(0, 9);
      expect(at0.z).toBe(0);
      const q = orbitalPosition(p, t0(p) + P / 4);
      expect(q.x / a).toBeCloseTo(0, 6);
      expect(q.y / a).toBeCloseTo(1, 6);
      // Many orbits later (a later transit) it is back at +x, and the radius is always a.
      const later = orbitalPosition(p, t0(p) + 1000 * P);
      expect(later.x / a).toBeCloseTo(1, 6);
      for (const dt of [0.1, 0.37, 0.9]) expect(orbitalPosition(p, t0(p) + dt * P).length() / a).toBeCloseTo(1, 12);
    }
  });

  it('phases orbits with a mean ephemeris close to the catalogued period, anchored near 2026', () => {
    const jan2026 = 2461041.5;
    for (const p of sys.planets) {
      const eph = p.inferred.ephemerisPeriodDays;
      expect(eph.provenance).toBe('inferred');
      expect(eph.citation).toBe('agol2024');
      expect(Math.abs(eph.value / p.measured.periodDays.value - 1), p.id).toBeLessThan(5e-4);
      // The epoch is the mean-ephemeris transit nearest 2026-01-01.
      expect(Math.abs(p.inferred.ephemerisTransitMidBJD.value - jan2026), p.id).toBeLessThanOrEqual(eph.value / 2 + 1e-6);
    }
  });

  it('phase is in [0, 2pi) before and after the epoch', () => {
    for (const dt of [-1e9, -1, 0, 1, 3.3e8]) {
      const ph = orbitalPhase(b, t0(b) + dt);
      expect(ph).toBeGreaterThanOrEqual(0);
      expect(ph).toBeLessThan(2 * Math.PI);
    }
  });

  it('writes into a supplied vector', () => {
    const out = orbitalPosition(b, 0);
    expect(orbitalPosition(b, 1234, out)).toBe(out);
  });

  it('implies Kepler-consistent speeds (b about 80 km/s)', () => {
    expect(orbitalSpeed(b) / 1000).toBeGreaterThan(75);
    expect(orbitalSpeed(b) / 1000).toBeLessThan(85);
    // a^3 / P^2 is the same for all planets (same star) to within the measurement errors.
    const k = sys.planets.map((p) => p.measured.semiMajorAxisAu.value ** 3 / p.measured.periodDays.value ** 2);
    for (const v of k) expect(Math.abs(v / k[0]! - 1)).toBeLessThan(0.03);
  });

  it('builds a right-handed orbital frame in ICRS with x leaning toward the Sun by sin(i)', () => {
    const { x, y, z } = orbitalFrameToIcrs(sys);
    for (const v of [x, y, z]) expect(v.length()).toBeCloseTo(1, 12);
    expect(x.dot(y)).toBeCloseTo(0, 12);
    expect(y.dot(z)).toBeCloseTo(0, 12);
    expect(x.clone().cross(y).distanceTo(z)).toBeLessThan(1e-12);
    const ra = (sys.position.raDeg.value * Math.PI) / 180;
    const dec = (sys.position.decDeg.value * Math.PI) / 180;
    const toSun = { x: -Math.cos(dec) * Math.cos(ra), y: -Math.cos(dec) * Math.sin(ra), z: -Math.sin(dec) };
    const inc = (sys.orbitalPlane.inclinationDeg.value * Math.PI) / 180;
    expect(x.x * toSun.x + x.y * toSun.y + x.z * toSun.z).toBeCloseTo(Math.sin(inc), 12);
    expect(z.x * toSun.x + z.y * toSun.y + z.z * toSun.z).toBeCloseTo(Math.cos(inc), 12);
    // The ascending node (+y) lies in the sky plane.
    expect(y.x * toSun.x + y.y * toSun.y + y.z * toSun.z).toBeCloseTo(0, 12);
  });

  it('computes the light travel time (about 40.5 years)', () => {
    const years = lightTimeSeconds(sys) / (365.25 * DAY_S);
    expect(years).toBeCloseTo((sys.position.distancePc.value * PARSEC_M) / SPEED_OF_LIGHT_M_PER_S / (365.25 * DAY_S), 9);
    expect(years).toBeGreaterThan(40);
    expect(years).toBeLessThan(41);
  });
});

describe('helpers', () => {
  it('sigma and toCoreSourced collapse asymmetric errors to the larger side', () => {
    expect(sigma(undefined)).toBeUndefined();
    expect(sigma(0.2)).toBe(0.2);
    expect(sigma([0.012, 0.014])).toBe(0.014);
    const r = sys.planets[0]!.measured.radiusEarth;
    const core = toCoreSourced(r);
    expect(core.uncertainty).toBe(0.014);
    expect(core.provenance).toBe('measured');
    expect(core.citation).toBe('agol2021');
    expect(core.unit).toBe('R_earth');
  });
});

describe('validateSystem catches broken data', () => {
  const mutate = (fn: (s: Record<string, unknown>) => void): string[] => {
    const s = JSON.parse(raw) as Record<string, unknown>;
    fn(s);
    return validateSystem(s);
  };
  type P = { measured: Record<string, Record<string, unknown>>; inferred: Record<string, Record<string, unknown>>; generated: Record<string, unknown> };
  const planet0 = (s: Record<string, unknown>): P => (s['planets'] as P[])[0]!;

  it('flags a missing citation, an unknown citation key and a missing field', () => {
    expect(mutate((s) => (planet0(s).measured['massEarth']!['citation'] = ''))).toEqual(['planets[0].measured.massEarth.citation is empty']);
    expect(mutate((s) => (planet0(s).measured['massEarth']!['citation'] = 'nobody2099'))).toEqual([
      "planets[0].measured.massEarth.citation 'nobody2099' is not in citations",
    ]);
    expect(mutate((s) => delete planet0(s).measured['periodDays'])).toEqual(['planets[0].measured.periodDays is missing']);
  });

  it('flags generated or inferred values labelled measured', () => {
    expect(mutate((s) => (planet0(s).inferred['insolationEarth']!['provenance'] = 'measured'))).toEqual([
      "planets[0].inferred.insolationEarth.provenance must be 'inferred', not 'measured'",
    ]);
    expect(
      mutate((s) => (((s['orbitalPlane'] as Record<string, Record<string, unknown>>)['nodeDeg']!)['provenance'] = 'measured')),
    ).toEqual(["orbitalPlane.nodeDeg.provenance must be 'generated', not 'measured'"]);
    expect(mutate((s) => (planet0(s).generated['provenance'] = 'measured'))).toEqual(["planets[0].generated.provenance must be 'generated'"]);
  });

  it('flags bad values', () => {
    expect(mutate((s) => (planet0(s).measured['radiusEarth']!['uncertainty'] = [-1, 2]))).toEqual([
      'planets[0].measured.radiusEarth.uncertainty must be a number or [lower, upper]',
    ]);
    expect(mutate((s) => (planet0(s).generated['palette'] = ['red']))).toEqual(['planets[0].generated.palette must be hex colours']);
    expect(mutate((s) => (planet0(s).generated['iceCoverage'] = 1.5))).toEqual(['planets[0].generated.iceCoverage must be in [0, 1]']);
    expect(validateSystem(null)).toEqual(['system file is not an object']);
  });

  type Count = Record<string, unknown>;
  const count = (s: Record<string, unknown>): Count => s['exoplanetCount'] as Count;
  const dps = (s: Record<string, unknown>): Record<string, unknown> =>
    (s['planets'] as Record<string, Record<string, unknown>>[])[0]!['defaultParameterSet']!;

  it('resolves the planet-count and default-parameter-set citations', () => {
    expect(mutate((s) => (count(s)['citation'] = 'bogus-key'))).toEqual(['exoplanetCount.citation does not resolve']);
    expect(mutate((s) => delete count(s)['citation'])).toEqual(['exoplanetCount.citation does not resolve']);
    expect(mutate((s) => (dps(s)['citation'] = 'also-bogus'))).toEqual(['planets[0].defaultParameterSet.citation does not resolve']);
    expect(mutate((s) => (dps(s)['citation'] = 'toString'))).toEqual(['planets[0].defaultParameterSet.citation does not resolve']);
    expect(mutate((s) => delete (s['planets'] as Record<string, unknown>[])[2]!['defaultParameterSet'])).toEqual([
      'planets[2].defaultParameterSet needs label, citation and published',
    ]);
  });

  it('requires a positive whole planet count with a date', () => {
    expect(mutate((s) => (count(s)['value'] = -3.5))).toEqual(['exoplanetCount.value must be a positive integer']);
    expect(mutate((s) => (count(s)['value'] = 0))).toEqual(['exoplanetCount.value must be a positive integer']);
    expect(mutate((s) => (count(s)['asOf'] = 'last week'))).toEqual(['exoplanetCount.asOf must be YYYY-MM-DD']);
  });

  it('requires unique planet ids of the form <system id><letter>', () => {
    const planets = (s: Record<string, unknown>): Record<string, unknown>[] => s['planets'] as Record<string, unknown>[];
    expect(mutate((s) => (planets(s)[1]!['id'] = 'trappist-1b'))).toEqual([
      "planets[1].id 'trappist-1b' is not unique",
      "planets[1].id must be 'trappist-1c'",
    ]);
    expect(mutate((s) => (planets(s)[3]!['id'] = 'trappist-1-e'))).toEqual(["planets[3].id must be 'trappist-1e'"]);
  });

  it('requires planets sorted by strictly increasing catalogued and mean period', () => {
    const reversed = mutate((s) => {
      s['planets'] = (s['planets'] as unknown[]).reverse();
      for (const p of s['planets'] as Record<string, unknown>[]) p['id'] = `trappist-1${String(p['letter'])}`;
    });
    expect(reversed).toContain('planets[1]: planets must be sorted by strictly increasing period');
    expect(reversed).toContain('planets[1]: planets must be sorted by strictly increasing mean period');
    expect(reversed).toHaveLength(12);
    const p = (s: Record<string, unknown>, i: number): P => (s['planets'] as P[])[i]!;
    expect(mutate((s) => (p(s, 2).inferred['ephemerisPeriodDays']!['value'] = 2.4))).toEqual([
      'planets[2]: planets must be sorted by strictly increasing mean period',
    ]);
  });

  it('rejects non-positive periods, axes, sizes and masses that would break the formulas', () => {
    expect(mutate((s) => (planet0(s).measured['periodDays']!['value'] = 0))).toEqual(['planets[0].measured.periodDays.value must be > 0']);
    expect(mutate((s) => (planet0(s).inferred['ephemerisPeriodDays']!['value'] = -1.5))).toEqual([
      'planets[0].inferred.ephemerisPeriodDays.value must be > 0',
    ]);
    expect(mutate((s) => (planet0(s).measured['semiMajorAxisAu']!['value'] = -1))).toEqual([
      'planets[0].measured.semiMajorAxisAu.value must be > 0',
    ]);
    expect(mutate((s) => (planet0(s).measured['radiusEarth']!['value'] = 0))).toEqual(['planets[0].measured.radiusEarth.value must be > 0']);
    expect(mutate((s) => (planet0(s).measured['massEarth']!['value'] = -0.2))).toEqual(['planets[0].measured.massEarth.value must be > 0']);
    const star = (s: Record<string, unknown>): Record<string, Record<string, unknown>> => s['star'] as Record<string, Record<string, unknown>>;
    expect(mutate((s) => (star(s)['teffK']!['value'] = 0))).toEqual(['star.teffK.value must be > 0']);
    expect(mutate((s) => (star(s)['radiusSun']!['value'] = -0.1))).toEqual(['star.radiusSun.value must be > 0']);
    expect(
      mutate((s) => ((s['position'] as Record<string, Record<string, unknown>>)['distancePc']!['value'] = 0)),
    ).toEqual(['position.distancePc.value must be > 0']);
  });
});

describe('loadSystem', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches systems/<id>.json and validates it', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(url.endsWith('systems/trappist-1.json') ? raw : '', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const s = await loadSystem('trappist-1');
    expect(s.planets).toHaveLength(7);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/data\/systems\/trappist-1\.json$/));
  });

  it('rejects bad ids, broken files and missing files', async () => {
    await expect(loadSystem('../secrets')).rejects.toThrow(/invalid system id/);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"id":"x"}', { status: 200 }))));
    await expect(loadSystem('x')).rejects.toThrow(/systems\/x\.json/);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 404 }))));
    await expect(loadSystem('nowhere')).rejects.toThrow(/404/);
  });
});
