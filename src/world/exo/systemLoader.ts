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

/** sRGB hex colour ("#rrggbb") to linear RGB. */
export function hexToLinear(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  const lin = (h: string): number => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [lin(m[1]!), lin(m[2]!), lin(m[3]!)];
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
    // Prefer the mean ephemeris fitted to published transit forecasts (inferred) for orbital phase; the archive's
    // N-body osculating period drifts by hours per year when extrapolated (docs/EXO_TRAPPIST1.md).
    const period = pick(inf, ['ephemerisPeriodDays']) ?? pick(m, ['periodDays', 'orbitalPeriodDays']);
    const a = pick(m, ['semiMajorAxisAu']);
    const r = pick(m, ['radiusEarth']);
    const mm = pick(m, ['massEarth']);
    const t0 = pick(inf, ['ephemerisTransitMidBJD']) ?? pick(m, ['transitMidBJD', 'transitMidpointBJD']);
    const inc = pick(m, ['inclinationDeg']) ?? 90;
    if (!pid || period === null || a === null || r === null || mm === null || t0 === null) continue;
    const teq = pick(inf, ['equilibriumTempK_A0', 'equilibriumTempK']);
    const terrainRaw = gen && typeof gen['terrain'] === 'string' ? gen['terrain'] : 'cratered';
    const terrain = (['cratered', 'volcanic', 'icy', 'mixed'] as const).find((x) => x === terrainRaw) ?? 'cratered';
    const locked = inf?.['tidallyLocked'];
    const hexes = Array.isArray(gen?.['palette']) ? (gen['palette'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const colors = hexes.map(hexToLinear).filter((c): c is [number, number, number] => c !== null);
    const ice = pick(gen, ['iceCoverage']) ?? 0;
    const albedo = pick(gen, ['albedo']);
    let palette: ExoPlanetSpec['palette'] = paletteForTeq(teq);
    let albedoScale = 1;
    if (colors.length >= 5) {
      palette = { colors, iceCoverage: ice };
      // Scale so the palette's area-weighted mean matches the generated albedo.
      const lum = (c: [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const rock = (lum(colors[0]!) + lum(colors[1]!) + lum(colors[2]!)) / 3;
      const iceL = (lum(colors[3]!) + lum(colors[4]!)) / 2;
      const mean = (1 - ice) * rock + ice * iceL;
      if (albedo !== null && mean > 0) albedoScale = Math.max(0.3, Math.min(3, albedo / mean));
    }
    planets.push({
      id: pid,
      name: typeof p['name'] === 'string' ? p['name'] : pid,
      radiusEarth: r,
      massEarth: mm,
      periodDays: period,
      semiMajorAxisAu: a,
      transitMidBJD: t0,
      inclinationDeg: inc,
      palette,
      albedoScale,
      seed: pick(gen, ['seed']) ?? hashId(pid),
      terrain,
      geometricAlbedo: albedo ?? 0.2,
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
