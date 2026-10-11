/**
 * Loads real exoplanet systems from public/data/systems/<id>.json (built offline from the NASA Exoplanet Archive by
 * tools/pipeline/exoplanets.py) and adapts them to ExoSystemSpec. Missing or malformed files are skipped with a
 * warning: the rest of the game does not depend on them.
 */
import { fetchJson } from '../../data/assets';
import { ExoSystem, type ExoPalette, type ExoPlanetSpec, type ExoSystemSpec } from './exoSystem';

/** Systems shipped with the game. */
export const SYSTEM_IDS = ['trappist-1'] as const;

type Json = Record<string, unknown>;

/** A number from a plain number or a Sourced value ({ value }). */
function num(x: unknown): number | null {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (x && typeof x === 'object' && 'value' in x) return num((x).value);
  return null;
}

function pick(obj: unknown, keys: readonly string[]): number | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = num((obj as Json)[k]);
    if (v !== null) return v;
  }
  return null;
}

function citationOf(x: unknown, fallback: string): string {
  if (x && typeof x === 'object' && typeof (x as Json)['citation'] === 'string') return (x as Json)['citation'] as string;
  return fallback;
}

/** Surface palette from the inferred equilibrium temperature (no-albedo case); every palette is Generated. */
export function paletteForTeq(teqK: number | null): ExoPalette {
  if (teqK === null) return 'temperate';
  if (teqK > 330) return 'basalt';
  if (teqK > 230) return 'temperate';
  return 'ice';
}

function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** Adapt the archive JSON to ExoSystemSpec; null when required values are missing. */
export function fromSystemJson(j: Json): ExoSystemSpec | null {
  const id = typeof j['id'] === 'string' ? j['id'] : null;
  const name = typeof j['name'] === 'string' ? j['name'] : id;
  const pos = j['position'] as Json | undefined;
  const star = j['star'] as Json | undefined;
  const plane = j['orbitalPlane'] as Json | undefined;
  const ra = pick(pos, ['raDeg', 'ra']);
  const dec = pick(pos, ['decDeg', 'dec']);
  const dist = pick(pos, ['distancePc', 'distance']);
  const radius = pick(star, ['radiusSun', 'radius', 'radiusSolar']);
  const mass = pick(star, ['massSun', 'mass', 'massSolar']);
  const teff = pick(star, ['teffK', 'teff', 'effectiveTemperatureK', 'effectiveTemperature']);
  let lum = pick(star, ['luminositySun', 'luminosity']);
  const logLum = pick(star, ['logLuminositySun', 'logLuminosity', 'luminosityLog']);
  if (lum === null && logLum !== null) lum = 10 ** logLum;
  if (!id || !name || ra === null || dec === null || dist === null || radius === null || mass === null || teff === null || lum === null) return null;
  const planetsRaw = Array.isArray(j['planets']) ? (j['planets'] as Json[]) : [];
  const planets: ExoPlanetSpec[] = [];
  for (const p of planetsRaw) {
    const m = p['measured'] as Json | undefined;
    const inf = p['inferred'] as Json | undefined;
    const gen = p['generated'] as Json | undefined;
    const pid = typeof p['id'] === 'string' ? p['id'] : null;
    const period = pick(m, ['periodDays', 'orbitalPeriodDays']);
    const a = pick(m, ['semiMajorAxisAu']);
    const r = pick(m, ['radiusEarth']);
    const mm = pick(m, ['massEarth']);
    const t0 = pick(m, ['transitMidBJD', 'transitMidpointBJD']);
    const inc = pick(m, ['inclinationDeg']) ?? 90;
    if (!pid || period === null || a === null || r === null || mm === null || t0 === null) continue;
    const teq = pick(inf, ['equilibriumTempK_A0', 'equilibriumTempK']);
    const terrainRaw = gen && typeof gen['terrain'] === 'string' ? gen['terrain'] : 'cratered';
    const terrain = (['cratered', 'volcanic', 'icy', 'mixed'] as const).find((x) => x === terrainRaw) ?? 'cratered';
    const locked = inf?.['tidallyLocked'];
    planets.push({
      id: pid,
      name: typeof p['name'] === 'string' ? p['name'] : pid,
      radiusEarth: r,
      massEarth: mm,
      periodDays: period,
      semiMajorAxisAu: a,
      transitMidBJD: t0,
      inclinationDeg: inc,
      palette: paletteForTeq(teq),
      seed: pick(gen, ['seed']) ?? hashId(pid),
      terrain,
      geometricAlbedo: pick(gen, ['albedo']) ?? 0.2,
      tidallyLocked: locked === false || (locked && typeof locked === 'object' && (locked as Json)['value'] === false) ? false : true,
      citation: citationOf(m?.['radiusEarth'], 'nasa-exoplanet-archive'),
    });
  }
  return {
    id,
    name,
    raDeg: ra,
    decDeg: dec,
    distancePc: dist,
    nodeDeg: pick(plane, ['nodeDeg']) ?? 0,
    star: {
      radiusSun: radius,
      massSun: mass,
      teffK: teff,
      luminositySun: lum,
      rotationPeriodDays: pick(star, ['rotationPeriodDays']),
      citation: citationOf(star?.['radiusSun'] ?? star?.['radius'], 'nasa-exoplanet-archive'),
    },
    planets: planets.sort((x, y) => x.periodDays - y.periodDays),
  };
}

export async function loadExoSystems(): Promise<ExoSystem[]> {
  const out: ExoSystem[] = [];
  for (const id of SYSTEM_IDS) {
    try {
      const spec = fromSystemJson(await fetchJson<Json>(`systems/${id}.json`));
      if (spec) out.push(new ExoSystem(spec));
      else console.warn(`systems/${id}.json: missing required values`);
    } catch (e) {
      console.warn(`systems/${id}.json not available`, e);
    }
  }
  return out;
}
