/**
 * Real exoplanet systems built offline by tools/pipeline/exoplanets.py (NASA Exoplanet Archive) into
 * public/data/systems/<id>.json. Every value carries its provenance:
 * - `measured`: catalogued values (archive parameters with their per-parameter reference),
 * - `inferred`: computed from measured values with stated formulas and assumptions (see each `note`),
 * - `generated`: rule-based surface parameters for rendering, never shown as fact.
 * Formulas, rules and the orbital-frame convention are documented in docs/EXO_TRAPPIST1.md.
 */
import { AU_M, DAY_S, J2000_JD, PARSEC_M, SPEED_OF_LIGHT_M_PER_S, SUN_RADIUS_M } from '../../core/constants';
import type { CitationKey, Provenance, Sourced } from '../../core/provenance';
import { Vec3d } from '../../core/vec3d';
import { fetchJson } from '../../data/assets';

/** One-sigma uncertainty: symmetric, or [lower, upper] magnitudes (value - lower ... value + upper). */
export type Uncertainty = number | readonly [lower: number, upper: number];

/** A value with its provenance, as stored in the system files. */
export interface ExoSourced<T> {
  readonly value: T;
  readonly uncertainty?: Uncertainty;
  /** Unit symbol ('' for dimensionless values, codes and text). */
  readonly unit: string;
  readonly provenance: Provenance;
  /** Dataset or method, e.g. "NASA Exoplanet Archive pscomppars (pl_orbper); Agol et al. 2021". */
  readonly source: string;
  readonly citation: CitationKey;
  /** Caveats and assumptions for the "How do we know this?" panel. */
  readonly note?: string;
}

export type Terrain = 'cratered' | 'volcanic' | 'icy' | 'mixed';
/** Inferred bulk composition class (from density; degenerate, see the note). */
export type CompositionClass = 'rocky' | 'rocky-or-water-rich';
/** What observations say about an atmosphere. */
export type AtmosphereClass = 'thick-co2-disfavoured' | 'unknown';

export const TERRAINS: readonly Terrain[] = ['cratered', 'volcanic', 'icy', 'mixed'];
export const COMPOSITIONS: readonly CompositionClass[] = ['rocky', 'rocky-or-water-rich'];
export const ATMOSPHERES: readonly AtmosphereClass[] = ['thick-co2-disfavoured', 'unknown'];

export interface ExoStar {
  readonly teffK: ExoSourced<number>;
  readonly radiusSun: ExoSourced<number>;
  readonly massSun: ExoSourced<number>;
  /** log10(L / L_sun), as the archive stores it. */
  readonly luminosityLogSun: ExoSourced<number>;
  readonly luminositySun: ExoSourced<number>;
  readonly ageGyr: ExoSourced<number>;
  readonly metallicityFeH: ExoSourced<number>;
  readonly spectralType: ExoSourced<string>;
  readonly vMag: ExoSourced<number>;
  readonly jMag: ExoSourced<number>;
  readonly kMag: ExoSourced<number>;
  readonly gaiaDr3Id: ExoSourced<string>;
}

export interface ExoPosition {
  /** ICRS right ascension; the epoch is stated in the note. */
  readonly raDeg: ExoSourced<number>;
  readonly decDeg: ExoSourced<number>;
  readonly distancePc: ExoSourced<number>;
}

export interface ExoOrbitalPlane {
  /** Inclination of the common orbital plane to the sky plane (90 = edge-on). */
  readonly inclinationDeg: ExoSourced<number>;
  /** Position angle of the ascending node, east of north. Not constrained by transits: always 'generated'. */
  readonly nodeDeg: ExoSourced<number>;
}

export interface ExoPlanetMeasured {
  readonly periodDays: ExoSourced<number>;
  readonly semiMajorAxisAu: ExoSourced<number>;
  readonly radiusEarth: ExoSourced<number>;
  readonly massEarth: ExoSourced<number>;
  readonly inclinationDeg: ExoSourced<number>;
  readonly eccentricity: ExoSourced<number>;
  /** Reference transit midpoint, BJD_TDB (a model epoch; see its note). */
  readonly transitMidBJD: ExoSourced<number>;
}

export interface ExoPlanetInferred {
  readonly equilibriumTempK_A0: ExoSourced<number>;
  readonly equilibriumTempK_A030: ExoSourced<number>;
  readonly insolationEarth: ExoSourced<number>;
  readonly densityRelEarth: ExoSourced<number>;
  readonly surfaceGravityG: ExoSourced<number>;
  readonly escapeVelocityKms: ExoSourced<number>;
  /** Mean period of a linear transit ephemeris fitted to the Agol et al. 2024 forecast (used for orbit phase). */
  readonly ephemerisPeriodDays: ExoSourced<number>;
  /** Mid-transit epoch (BJD_TDB) of that mean ephemeris, near 2026-01-01. */
  readonly ephemerisTransitMidBJD: ExoSourced<number>;
  readonly tidallyLocked: ExoSourced<boolean>;
  readonly composition: ExoSourced<CompositionClass>;
  readonly atmosphere: ExoSourced<AtmosphereClass>;
}

/** Rule-based rendering parameters. The whole block is 'generated'; `rationale` explains each rule that fired. */
export interface ExoPlanetGenerated {
  /** hashString(planet.id) from core/rng.ts: seeds terrain noise. */
  readonly seed: number;
  readonly terrain: Terrain;
  /** Bond albedo used for shading, 0..1. */
  readonly albedo: number;
  /** Surface reflectance colours (sRGB hex, dark to light) under white light. */
  readonly palette: readonly string[];
  /** Fraction of the surface drawn as ice, 0..1. */
  readonly iceCoverage: number;
  /** Strength of a night-side incandescent glow, 0..1. */
  readonly nightSideGlow: number;
  readonly rationale: string;
  readonly provenance: 'generated';
  readonly source: string;
  readonly citation: CitationKey;
}

export interface ExoPlanet {
  /** e.g. 'trappist-1b' */
  readonly id: string;
  /** e.g. 'TRAPPIST-1 b' (catalogue designation; not translated) */
  readonly name: string;
  readonly letter: string;
  /** The archive's default parameter set for this planet. */
  readonly defaultParameterSet: { readonly label: string; readonly citation: CitationKey; readonly published: string };
  readonly measured: ExoPlanetMeasured;
  readonly inferred: ExoPlanetInferred;
  readonly generated: ExoPlanetGenerated;
}

/** Same fields as core/provenance Citation, keyed by citation key. */
export interface ExoCitation {
  readonly authors: string;
  readonly year: number;
  readonly title: string;
  readonly venue: string;
  readonly doi?: string;
  readonly url?: string;
}

export interface ExoSystem {
  readonly id: string;
  readonly name: string;
  /** Date (UTC, YYYY-MM-DD) the archive was queried. */
  readonly retrieved: string;
  readonly source: string;
  /** Live confirmed-exoplanet count recorded when the data was built. */
  readonly exoplanetCount: { readonly value: number; readonly asOf: string; readonly source: string; readonly citation: CitationKey };
  readonly star: ExoStar;
  readonly position: ExoPosition;
  readonly orbitalPlane: ExoOrbitalPlane;
  /** Sorted by orbital period. */
  readonly planets: readonly ExoPlanet[];
  /** Every citation key used in this file (to merge into public/data/citations.json). */
  readonly citations: Readonly<Record<CitationKey, ExoCitation>>;
}

// --- Loading and validation -------------------------------------------------------------------------------------

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Load and validate public/data/systems/<id>.json. Throws if the file is missing or breaks the schema. */
export async function loadSystem(id: string): Promise<ExoSystem> {
  if (!ID_RE.test(id)) throw new Error(`invalid system id: ${JSON.stringify(id)}`);
  const data = await fetchJson<unknown>(`systems/${id}.json`);
  const problems = validateSystem(data);
  if (problems.length > 0) throw new Error(`systems/${id}.json: ${problems.slice(0, 5).join('; ')}`);
  const sys = data as ExoSystem;
  if (sys.id !== id) throw new Error(`systems/${id}.json describes ${sys.id}`);
  return sys;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const PROVENANCES: readonly string[] = ['measured', 'inferred', 'generated'];
const HEX_RE = /^#[0-9a-f]{6}$/i;

function checkUncertainty(u: unknown, path: string, out: string[]): void {
  if (u === undefined) return;
  if (typeof u === 'number') {
    if (!(Number.isFinite(u) && u >= 0)) out.push(`${path}.uncertainty must be a finite number >= 0`);
    return;
  }
  if (Array.isArray(u) && u.length === 2 && u.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)) return;
  out.push(`${path}.uncertainty must be a number or [lower, upper]`);
}

function checkSourced(
  v: unknown,
  path: string,
  kind: 'number' | 'string' | 'boolean',
  provenance: Provenance | null,
  citations: Json,
  out: string[],
): void {
  if (!isObj(v)) {
    out.push(`${path} is missing`);
    return;
  }
  const value = v['value'];
  if (kind === 'number' ? !(typeof value === 'number' && Number.isFinite(value)) : typeof value !== kind) {
    out.push(`${path}.value must be a ${kind}`);
  }
  if (typeof v['unit'] !== 'string') out.push(`${path}.unit must be a string`);
  const p = v['provenance'];
  if (typeof p !== 'string' || !PROVENANCES.includes(p)) out.push(`${path}.provenance is invalid`);
  else if (provenance !== null && p !== provenance) out.push(`${path}.provenance must be '${provenance}', not '${p}'`);
  if (typeof v['source'] !== 'string' || v['source'] === '') out.push(`${path}.source is empty`);
  const c = v['citation'];
  if (typeof c !== 'string' || c === '') out.push(`${path}.citation is empty`);
  else if (!Object.hasOwn(citations, c)) out.push(`${path}.citation '${c}' is not in citations`);
  if (v['note'] !== undefined && typeof v['note'] !== 'string') out.push(`${path}.note must be a string`);
  checkUncertainty(v['uncertainty'], path, out);
}

const STAR_FIELDS: readonly [keyof ExoStar, 'number' | 'string'][] = [
  ['teffK', 'number'],
  ['radiusSun', 'number'],
  ['massSun', 'number'],
  ['luminosityLogSun', 'number'],
  ['luminositySun', 'number'],
  ['ageGyr', 'number'],
  ['metallicityFeH', 'number'],
  ['spectralType', 'string'],
  ['vMag', 'number'],
  ['jMag', 'number'],
  ['kMag', 'number'],
  ['gaiaDr3Id', 'string'],
];
export const MEASURED_FIELDS: readonly (keyof ExoPlanetMeasured)[] = [
  'periodDays',
  'semiMajorAxisAu',
  'radiusEarth',
  'massEarth',
  'inclinationDeg',
  'eccentricity',
  'transitMidBJD',
];
export const INFERRED_FIELDS: readonly (keyof ExoPlanetInferred)[] = [
  'equilibriumTempK_A0',
  'equilibriumTempK_A030',
  'insolationEarth',
  'densityRelEarth',
  'surfaceGravityG',
  'escapeVelocityKms',
  'ephemerisPeriodDays',
  'ephemerisTransitMidBJD',
  'tidallyLocked',
  'composition',
  'atmosphere',
];

/**
 * Schema and provenance checks: every displayed value has a provenance, a non-empty source and a citation that
 * resolves in the file's citation list; measured/inferred/generated blocks hold only their own tier. Returns a list of
 * problems (empty when valid).
 */
export function validateSystem(data: unknown): string[] {
  const out: string[] = [];
  if (!isObj(data)) return ['system file is not an object'];
  for (const k of ['id', 'name', 'retrieved', 'source'] as const) {
    if (typeof data[k] !== 'string' || data[k] === '') out.push(`${k} is missing`);
  }
  if (typeof data['retrieved'] === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(data['retrieved'])) out.push('retrieved must be YYYY-MM-DD');
  const citations = data['citations'];
  if (!isObj(citations)) return [...out, 'citations is missing'];
  for (const [key, c] of Object.entries(citations)) {
    if (!isObj(c) || typeof c['authors'] !== 'string' || typeof c['title'] !== 'string' || typeof c['venue'] !== 'string') {
      out.push(`citations.${key} needs authors, title and venue`);
    } else if (typeof c['year'] !== 'number') out.push(`citations.${key}.year must be a number`);
    else if (typeof c['doi'] !== 'string' && typeof c['url'] !== 'string') out.push(`citations.${key} needs a DOI or URL`);
  }
  const count = data['exoplanetCount'];
  if (!isObj(count) || typeof count['value'] !== 'number' || typeof count['asOf'] !== 'string' || typeof count['source'] !== 'string') {
    out.push('exoplanetCount needs value, asOf and source');
  }
  const star = data['star'];
  if (!isObj(star)) out.push('star is missing');
  else for (const [k, kind] of STAR_FIELDS) checkSourced(star[k], `star.${k}`, kind, 'measured', citations, out);
  const pos = data['position'];
  if (!isObj(pos)) out.push('position is missing');
  else for (const k of ['raDeg', 'decDeg', 'distancePc']) checkSourced(pos[k], `position.${k}`, 'number', 'measured', citations, out);
  const plane = data['orbitalPlane'];
  if (!isObj(plane)) out.push('orbitalPlane is missing');
  else {
    checkSourced(plane['inclinationDeg'], 'orbitalPlane.inclinationDeg', 'number', null, citations, out);
    checkSourced(plane['nodeDeg'], 'orbitalPlane.nodeDeg', 'number', 'generated', citations, out);
  }
  const planets = data['planets'];
  if (!Array.isArray(planets) || planets.length === 0) return [...out, 'planets is missing'];
  planets.forEach((p: unknown, i) => {
    const at = `planets[${i}]`;
    if (!isObj(p)) {
      out.push(`${at} is not an object`);
      return;
    }
    for (const k of ['id', 'name', 'letter'] as const) if (typeof p[k] !== 'string' || p[k] === '') out.push(`${at}.${k} is missing`);
    const m = p['measured'];
    const inf = p['inferred'];
    const g = p['generated'];
    if (!isObj(m) || !isObj(inf) || !isObj(g)) {
      out.push(`${at} needs measured, inferred and generated blocks`);
      return;
    }
    for (const k of MEASURED_FIELDS) checkSourced(m[k], `${at}.measured.${k}`, 'number', 'measured', citations, out);
    for (const k of INFERRED_FIELDS) {
      const kind = k === 'tidallyLocked' ? 'boolean' : k === 'composition' || k === 'atmosphere' ? 'string' : 'number';
      checkSourced(inf[k], `${at}.inferred.${k}`, kind, 'inferred', citations, out);
    }
    const comp = isObj(inf['composition']) ? inf['composition']['value'] : undefined;
    if (!(COMPOSITIONS as readonly unknown[]).includes(comp)) out.push(`${at}.inferred.composition has an unknown class`);
    const atm = isObj(inf['atmosphere']) ? inf['atmosphere']['value'] : undefined;
    if (!(ATMOSPHERES as readonly unknown[]).includes(atm)) out.push(`${at}.inferred.atmosphere has an unknown class`);
    if (g['provenance'] !== 'generated') out.push(`${at}.generated.provenance must be 'generated'`);
    if (typeof g['citation'] !== 'string' || !Object.hasOwn(citations, g['citation'])) out.push(`${at}.generated.citation does not resolve`);
    if (typeof g['seed'] !== 'number' || !Number.isInteger(g['seed']) || g['seed'] < 0 || g['seed'] > 0xffff_ffff) {
      out.push(`${at}.generated.seed must be a uint32`);
    }
    if (!(TERRAINS as readonly unknown[]).includes(g['terrain'])) out.push(`${at}.generated.terrain is invalid`);
    for (const k of ['albedo', 'iceCoverage', 'nightSideGlow'] as const) {
      const v = g[k];
      if (typeof v !== 'number' || !(v >= 0 && v <= 1)) out.push(`${at}.generated.${k} must be in [0, 1]`);
    }
    const pal = g['palette'];
    if (!Array.isArray(pal) || pal.length === 0 || !pal.every((c) => typeof c === 'string' && HEX_RE.test(c))) {
      out.push(`${at}.generated.palette must be hex colours`);
    }
    if (typeof g['rationale'] !== 'string' || g['rationale'] === '') out.push(`${at}.generated.rationale is empty`);
  });
  return out;
}

// --- Physics helpers (pure) -------------------------------------------------------------------------------------

/** Nominal solar radius in au (IAU 2015 B3 / IAU 2012 B2). */
const SUN_RADIUS_AU = SUN_RADIUS_M / AU_M;

/**
 * Equilibrium temperature (K) for full day-night heat redistribution, emissivity 1 and no greenhouse effect:
 * Teq = Teff * sqrt(R* / (2a)) * (1 - A)^(1/4).
 */
export function equilibriumTemp(teffK: number, starRadiusSun: number, semiMajorAxisAu: number, bondAlbedo = 0): number {
  return teffK * Math.sqrt((starRadiusSun * SUN_RADIUS_AU) / (2 * semiMajorAxisAu)) * Math.pow(1 - bondAlbedo, 0.25);
}

/** Stellar flux at the planet in Earth units (1 = 1 L_sun at 1 au): S = L / a^2. */
export function insolation(luminositySun: number, semiMajorAxisAu: number): number {
  return luminositySun / (semiMajorAxisAu * semiMajorAxisAu);
}

/** Barycentric Julian Date (TDB) -> TDB seconds since J2000.0 (the game clock's time argument). */
export function bjdToTdbSeconds(bjd: number): number {
  return (bjd - J2000_JD) * DAY_S;
}

/**
 * Orbital phase angle (radians, [0, 2pi)) measured from the transit point: 0 at mid-transit, increasing at the mean
 * motion 2pi/P. Uses the mean linear ephemeris (inferred.ephemerisPeriodDays / ephemerisTransitMidBJD, fitted to the
 * Agol et al. 2024 transit forecast), not the archive's period and epoch: the archive period is an osculating N-body
 * element, and paired with the archive epoch it misses 2026 transits by 3 to 27 hours. The mean ephemeris follows
 * the forecast within 17 to 107 minutes (transit-timing variations) through mid-2027 and drifts slowly after.
 */
export function orbitalPhase(planet: ExoPlanet, tdbSecondsSinceJ2000: number): number {
  const periodS = planet.inferred.ephemerisPeriodDays.value * DAY_S;
  const dt = tdbSecondsSinceJ2000 - bjdToTdbSeconds(planet.inferred.ephemerisTransitMidBJD.value);
  const turns = dt / periodS;
  return 2 * Math.PI * (turns - Math.floor(turns));
}

/**
 * Planet position (metres, relative to the star) in the system's orbital frame, on a circular orbit of radius a:
 * +x points from the star toward the Solar System (projected onto the orbital plane), so the planet sits at +x at
 * transit; +z is the orbital angular momentum; +y = z cross x is the direction of motion at transit.
 *
 * Time is the TDB instant at which a Solar System barycentre observer sees the configuration (the convention of the
 * BJD_TDB transit epochs). The system's own "now" is lightTimeSeconds() later; add it to place planets at the instant
 * their light leaves. The transit epoch is a model reference (see orbitalPhase): positions are good to a few
 * degrees of orbital phase through mid-2027 and drift slowly beyond the forecast's end. Orbits are drawn circular
 * (e < 0.011).
 */
export function orbitalPosition(planet: ExoPlanet, tdbSecondsSinceJ2000: number, out: Vec3d = new Vec3d()): Vec3d {
  const theta = orbitalPhase(planet, tdbSecondsSinceJ2000);
  const a = planet.measured.semiMajorAxisAu.value * AU_M;
  return out.set(a * Math.cos(theta), a * Math.sin(theta), 0);
}

/** Circular orbital speed (m/s) implied by a and P: 2 pi a / P. */
export function orbitalSpeed(planet: ExoPlanet): number {
  return (2 * Math.PI * planet.measured.semiMajorAxisAu.value * AU_M) / (planet.measured.periodDays.value * DAY_S);
}

/** One-way light travel time from the system to the Solar System (s). */
export function lightTimeSeconds(system: ExoSystem): number {
  return (system.position.distancePc.value * PARSEC_M) / SPEED_OF_LIGHT_M_PER_S;
}

export interface FrameBasis {
  readonly x: Vec3d;
  readonly y: Vec3d;
  readonly z: Vec3d;
}

/**
 * Unit vectors of the orbital frame expressed in ICRS equatorial axes (the game's world axes). With o = the unit
 * vector from the star toward the Sun, n = the position angle of the ascending node (east of north) and i the
 * inclination: y = cos(n) North + sin(n) East (the ascending node, where the planet recedes from us),
 * w = o x y, z = cos(i) o + sin(i) w, x = sin(i) o - cos(i) w. ICRS position = star + px x + py y + pz z.
 */
export function orbitalFrameToIcrs(system: ExoSystem): FrameBasis {
  const ra = (system.position.raDeg.value * Math.PI) / 180;
  const dec = (system.position.decDeg.value * Math.PI) / 180;
  const inc = (system.orbitalPlane.inclinationDeg.value * Math.PI) / 180;
  const node = (system.orbitalPlane.nodeDeg.value * Math.PI) / 180;
  const toStar = new Vec3d(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
  const o = toStar.clone().scale(-1);
  const east = new Vec3d(-Math.sin(ra), Math.cos(ra), 0);
  const north = new Vec3d(-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec));
  const y = north.clone().scale(Math.cos(node)).addScaled(east, Math.sin(node));
  const w = o.clone().cross(y);
  const z = o.clone().scale(Math.cos(inc)).addScaled(w, Math.sin(inc));
  const x = o.clone().scale(Math.sin(inc)).addScaled(w, -Math.cos(inc));
  return { x, y, z };
}

// --- Display helpers --------------------------------------------------------------------------------------------

/** Symmetric one-sigma value for code that needs a single number (the larger side of an asymmetric error). */
export function sigma(u: Uncertainty | undefined): number | undefined {
  if (u === undefined) return undefined;
  return typeof u === 'number' ? u : Math.max(u[0], u[1]);
}

/** Convert to the core Sourced shape used by the provenance panel (asymmetric errors collapse to the larger side). */
export function toCoreSourced<T>(s: ExoSourced<T>): Sourced<T> {
  const u = sigma(s.uncertainty);
  return {
    value: s.value,
    provenance: s.provenance,
    source: s.source,
    citation: s.citation,
    unit: s.unit,
    ...(u !== undefined ? { uncertainty: u } : {}),
    ...(s.note !== undefined ? { note: s.note } : {}),
  };
}

/** i18n keys (src/game/locales/en.exo.json) for the class codes stored in the data. */
export const terrainLabelKey = (t: Terrain): string => `exo.terrain.${t}`;
export const compositionLabelKey = (c: CompositionClass): string => `exo.composition.${c}`;
export const atmosphereLabelKey = (a: AtmosphereClass): string => `exo.atmosphere.${a}`;
