/** Typed view of public/data/bodies.json (built by tools/pipeline/bodies.py from NAIF kernels). */
import type { Provenance } from '../core/provenance';
import type { AtmosphereSpec } from '../render/materials/planetShading';
import type { ProceduralKind } from './planet/heights';
import type { RotationModel } from './rotation';
import { fetchJson } from '../data/assets';

export type BodyKind = 'star' | 'planet' | 'dwarf' | 'moon';

export interface SurfaceDef {
  type: 'terrain' | 'gas' | 'star';
  texture?: string;
  tiles?: string;
  heights?: string;
  terrain?: ProceduralKind;
  amplitude?: number;
  seaLevel?: number;
  night?: string;
  clouds?: string;
  /** Texture channel holding cloud cover ('r' for a greyscale map, 'a' when packed with night lights). */
  cloudChannel?: 'r' | 'a';
  brdf?: 'lambert' | 'lunar';
  teffK?: number;
}

export interface RingsDef {
  texture: string;
  innerM: number;
  outerM: number;
  provenance: Provenance;
  source: string;
  citation: string;
}

export interface BodyDef {
  id: string;
  key: string;
  name: string;
  kind: BodyKind;
  parent: string | null;
  ephemerisId: string;
  radiiM: [number, number, number];
  radiusM: number;
  gmM3S2: number;
  rotation: RotationModel;
  /** Geometric albedo (NASA fact sheets). */
  geometricAlbedo: number;
  /** Linear multiplier applied to display-stretched albedo maps. */
  albedoScale: number;
  surface: SurfaceDef;
  atmosphere?: AtmosphereSpec & { provenance: Provenance; source: string; citation: string };
  rings?: RingsDef;
  provenance: Provenance;
  source: string;
  citation: string;
  /** Stars: luminosity in solar units (1 for the Sun). */
  luminositySun?: number;
  /** Stars: absolute visual magnitude (for drawing as a point when unresolved). */
  absMagV?: number;
}

export async function loadBodies(): Promise<BodyDef[]> {
  return (await fetchJson<{ bodies: BodyDef[] }>('bodies.json')).bodies;
}
