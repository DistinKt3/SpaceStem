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
 * Inferred luminosity (L_sun, visual-band approximation without bolometric correction) and radius (m) from absolute
 * magnitude and colour: L = 10^(-0.4 (M_V - 4.83)), R = sqrt(L) (T_sun / T)^2 R_sun.
 */
export function inferStar(absMagV: number, bv: number): { luminositySun: number; radiusM: number; teffK: number } {
  const luminositySun = Math.pow(10, -0.4 * (absMagV - 4.83));
  const teffK = bvToTeff(bv);
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
