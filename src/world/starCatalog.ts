/**
 * The known-star catalogue (HYG v4.1): positions and magnitudes come from the starfield buffer; names and
 * designations from stars.json. Also builds "star bodies" for stars the player travels to: the star becomes a real,
 * lit sphere whose radius and luminosity are Inferred from its catalogued magnitude and colour.
 */
import { PARSEC_M, SUN_RADIUS_M, SUN_TEFF_K } from '../core/constants';
import { Vec3d } from '../core/vec3d';
import { fetchJson } from '../data/assets';
import type { BodyDef } from './catalog';

export interface NamedStar {
  name: string;
  designation: string;
  hip: number | null;
  spect: string;
  distPc: number;
  mag: number;
  absmag: number;
  bv: number;
  con: string;
}

interface StarsJson {
  count: number;
  source: string;
  named: Record<string, NamedStar>;
  nearby: number[];
}

/** B-V -> effective temperature, Ballesteros (2012). */
export function bvToTeff(bv: number): number {
  const b = Math.max(-0.4, Math.min(2, bv));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

/**
 * Bolometric correction BC_V(T_eff) from Flower (1996, ApJ 469, 355) with the corrected coefficients of Torres (2010,
 * AJ 140, 1158, Table 1). Valid roughly 2,900-50,000 K; the input is clamped to that range.
 */
export function bolometricCorrectionV(teffK: number): number {
  const x = Math.log10(Math.max(2900, Math.min(50000, teffK)));
  const c =
    x < 3.7
      ? [-0.190537291496456e5, 0.155144866764412e5, -0.421278819301717e4, 0.381476328422343e3]
      : x < 3.9
        ? [-0.370510203809015e5, 0.385672629965804e5, -0.150651486316025e5, 0.261724637119416e4, -0.170623810323864e3]
        : [-0.118115450538963e6, 0.137145973583929e6, -0.636233812100225e5, 0.147412923562646e5, -0.170587278406872e4, 0.78873172180499e2];
  let bc = 0;
  for (let i = c.length - 1; i >= 0; i--) bc = bc * x + c[i]!;
  return bc;
}

/** Nominal solar absolute bolometric magnitude (IAU 2015 Resolution B2). */
const M_BOL_SUN = 4.74;

/**
 * Inferred bolometric luminosity (L_sun) and radius (m) from absolute visual magnitude and B-V colour:
 * T_eff from B-V (Ballesteros 2012), M_bol = M_V + BC_V(T_eff), L = 10^(-0.4 (M_bol - 4.74)),
 * R = sqrt(L) (T_sun / T_eff)^2 R_sun (Stefan-Boltzmann). B-V saturates for M dwarfs, so their T_eff is overestimated
 * and radii underestimated (Proxima Centauri: ~0.07 vs 0.15 R_sun measured); results are labelled Inferred.
 */
export function inferStar(absMagV: number, bv: number): { luminositySun: number; radiusM: number; teffK: number } {
  const teffK = bvToTeff(bv);
  const luminositySun = Math.pow(10, -0.4 * (absMagV + bolometricCorrectionV(teffK) - M_BOL_SUN));
  const radiusM = Math.sqrt(luminositySun) * (SUN_TEFF_K / teffK) ** 2 * SUN_RADIUS_M;
  return { luminositySun, radiusM, teffK };
}

export class StarCatalog {
  private named = new Map<number, NamedStar>();
  nearby: number[] = [];
  source = '';

  constructor(
    readonly positions: Float32Array,
    readonly absMags: Float32Array,
  ) {}

  async load(): Promise<void> {
    const j = await fetchJson<StarsJson>('stars.json');
    for (const [k, v] of Object.entries(j.named)) this.named.set(Number(k), v);
    this.nearby = j.nearby;
    this.source = j.source;
  }

  get count(): number {
    return this.absMags.length;
  }

  info(i: number): NamedStar | undefined {
    return this.named.get(i);
  }

  name(i: number): string {
    const n = this.named.get(i);
    return n?.name || n?.designation || `HYG ${i}`;
  }

  positionPc(i: number, out: Vec3d): Vec3d {
    return out.set(this.positions[i * 3]!, this.positions[i * 3 + 1]!, this.positions[i * 3 + 2]!);
  }

  /** Heliocentric position in metres (the Sun's offset from the SSB is added by the caller if needed). */
  positionM(i: number, out: Vec3d): Vec3d {
    return this.positionPc(i, out).scale(PARSEC_M);
  }

  /** Named or nearby stars within maxPc of a heliocentric position (pc), nearest first. */
  destinations(fromPc: Vec3d, maxPc: number, limit = 40): number[] {
    const out: { i: number; d: number }[] = [];
    const p = new Vec3d();
    for (const i of this.named.keys()) {
      const d = this.positionPc(i, p).distanceTo(fromPc);
      if (d <= maxPc && d > 1e-4) out.push({ i, d });
    }
    return out
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map((x) => x.i);
  }

  /** BodyDef for a star the player has travelled to (rendered as a lit sphere). */
  bodyDef(i: number): BodyDef {
    const n = this.named.get(i);
    const absmag = this.absMags[i]!;
    const inf = inferStar(absmag, n?.bv ?? 0.65);
    return {
      id: `*${i}`,
      key: `star-${i}`,
      name: this.name(i),
      kind: 'star',
      parent: null,
      ephemerisId: `*${i}`,
      radiiM: [inf.radiusM, inf.radiusM, inf.radiusM],
      radiusM: inf.radiusM,
      gmM3S2: 1.327e20 * Math.max(0.08, Math.min(30, Math.pow(inf.luminositySun, 1 / 3.5))),
      rotation: { poleRa: [], poleDec: [], pm: [] },
      geometricAlbedo: 1,
      albedoScale: 1,
      surface: { type: 'star', teffK: inf.teffK },
      luminositySun: inf.luminositySun,
      provenance: 'measured',
      source: `${this.source}; radius and luminosity inferred from magnitude and colour`,
      citation: 'hyg-v41',
    };
  }
}
