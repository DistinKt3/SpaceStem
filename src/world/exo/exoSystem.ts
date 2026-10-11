/**
 * A real exoplanet system at runtime: body definitions for the star and its planets, and positions/velocities for
 * the SolarSystem's external-anchor hooks. Values come from an ExoSystemSpec (built from the archive JSON by
 * fromSystemJson); orbits use SystemFrame (circular, transit-phased, node angle Generated).
 */
import { AU_M, PARSEC_M, SUN_RADIUS_M } from '../../core/constants';
import type { Provenance } from '../../core/provenance';
import { Vec3d } from '../../core/vec3d';
import type { BodyDef } from '../catalog';
import { SystemFrame, bjdToTdbSeconds, radecToUnit, type CircularOrbit } from './orbitFrame';

/** Earth radius and mass (IAU 2015 Resolution B3 nominal values). */
const EARTH_RADIUS_M = 6.3781e6;
const EARTH_GM = 3.986004e14;
const SUN_GM = 1.3271244e20;

export type ExoPalette = 'basalt' | 'temperate' | 'ice';

export interface ExoPlanetSpec {
  id: string;
  name: string;
  radiusEarth: number;
  massEarth: number;
  periodDays: number;
  semiMajorAxisAu: number;
  transitMidBJD: number;
  inclinationDeg: number;
  /** Generated surface: a named palette, or colours from the data (linear RGB, rock to ice) with ice cover. */
  palette: ExoPalette | { colors: [number, number, number][]; iceCoverage: number };
  seed: number;
  terrain: 'cratered' | 'volcanic' | 'icy' | 'mixed';
  /** Geometric albedo used for exposure and point brightness (Generated unless measured). */
  geometricAlbedo: number;
  /** Linear multiplier taking the palette to the planet's (generated) mean albedo. */
  albedoScale?: number;
  tidallyLocked: boolean;
  citation: string;
}

export interface ExoSystemSpec {
  id: string;
  name: string;
  raDeg: number;
  decDeg: number;
  distancePc: number;
  /** Generated: position angle of the orbits' node on the sky. */
  nodeDeg: number;
  star: { radiusSun: number; massSun: number; teffK: number; luminositySun: number; rotationPeriodDays: number | null; citation: string };
  planets: ExoPlanetSpec[];
}

export class ExoSystem {
  readonly spec: ExoSystemSpec;
  /** Heliocentric position of the star (m, ICRF). */
  readonly helio: Vec3d;
  readonly frames = new Map<string, SystemFrame>();
  readonly orbits = new Map<string, CircularOrbit>();
  private readonly ids: Set<string>;

  constructor(spec: ExoSystemSpec) {
    this.spec = spec;
    const los = radecToUnit(spec.raDeg, spec.decDeg);
    this.helio = los.clone().scale(spec.distancePc * PARSEC_M);
    for (const p of spec.planets) {
      // Each planet has its own measured inclination; all share the generated node angle.
      this.frames.set(p.id, new SystemFrame(los, p.inclinationDeg, spec.nodeDeg));
      this.orbits.set(p.id, { aM: p.semiMajorAxisAu * AU_M, periodS: p.periodDays * 86_400, t0: bjdToTdbSeconds(p.transitMidBJD) });
    }
    this.ids = new Set([spec.id, ...spec.planets.map((p) => p.id)]);
  }

  owns(anchor: string): boolean {
    return this.ids.has(anchor);
  }

  /** Position of an owned anchor relative to the star (m, ICRF). */
  local(anchor: string, t: number, out: Vec3d): Vec3d {
    const f = this.frames.get(anchor);
    const o = this.orbits.get(anchor);
    if (!f || !o) return out.set(0, 0, 0);
    return f.position(o, t, out);
  }

  localVelocity(anchor: string, t: number, out: Vec3d): Vec3d {
    const f = this.frames.get(anchor);
    const o = this.orbits.get(anchor);
    if (!f || !o) return out.set(0, 0, 0);
    return f.velocity(o, t, out);
  }

  /** a − b for two owned anchors, without leaving the system's local frame. */
  relative(a: string, b: string, t: number, out: Vec3d): Vec3d {
    return this.local(a, t, out).sub(this.local(b, t, new Vec3d()));
  }

  relativeVelocity(a: string, b: string, t: number, out: Vec3d): Vec3d {
    return this.localVelocity(a, t, out).sub(this.localVelocity(b, t, new Vec3d()));
  }

  /** SSB position of an owned anchor, given the Sun's SSB position. */
  ssb(anchor: string, t: number, sunSsb: Vec3d, out: Vec3d): Vec3d {
    return this.local(anchor, t, out).add(this.helio).add(sunSsb);
  }

  /** Body definitions: the star first, then the planets. */
  bodyDefs(): BodyDef[] {
    const s = this.spec;
    const starR = s.star.radiusSun * SUN_RADIUS_M;
    const firstFrame = this.frames.values().next().value;
    const pole = firstFrame ? firstFrame.poleRaDec() : { ra: 0, dec: 90 };
    const measured: Provenance = 'measured';
    const star: BodyDef = {
      id: s.id,
      key: s.id,
      name: s.name,
      kind: 'star',
      parent: null,
      ephemerisId: s.id,
      radiiM: [starR, starR, starR],
      radiusM: starR,
      gmM3S2: s.star.massSun * SUN_GM,
      // Spin axis assumed aligned with the orbits (not measured); period from photometry when known.
      rotation: { poleRa: [pole.ra], poleDec: [pole.dec], pm: [0, s.star.rotationPeriodDays ? 360 / s.star.rotationPeriodDays : 0] },
      geometricAlbedo: 1,
      albedoScale: 1,
      surface: { type: 'star', teffK: s.star.teffK },
      // Radius and temperature are derived by the source (D-036), as for catalogue stars the game visits.
      provenance: 'inferred',
      source: 'NASA Exoplanet Archive',
      citation: s.star.citation,
      luminositySun: s.star.luminositySun,
    };
    const planets = s.planets.map((p): BodyDef => {
      const R = p.radiusEarth * EARTH_RADIUS_M;
      const o = this.orbits.get(p.id)!;
      const f = this.frames.get(p.id)!;
      const rotation = p.tidallyLocked ? f.tidallyLocked(o) : { poleRa: [f.poleRaDec().ra], poleDec: [f.poleRaDec().dec], pm: [0, 360] };
      return {
        id: p.id,
        key: p.id,
        name: p.name,
        kind: 'planet',
        parent: s.id,
        ephemerisId: p.id,
        radiiM: [R, R, R],
        radiusM: R,
        gmM3S2: p.massEarth * EARTH_GM,
        rotation,
        geometricAlbedo: p.geometricAlbedo,
        albedoScale: p.albedoScale ?? 1,
        surface: {
          type: 'terrain',
          terrain: p.terrain === 'mixed' ? 'cratered' : p.terrain,
          amplitude: p.terrain === 'icy' ? 1500 : 3000,
          generated: { palette: p.palette, seed: p.seed },
        },
        // Size, mass and orbit are measured; the surface is Generated (see the Codex entry).
        provenance: measured,
        source: 'NASA Exoplanet Archive (radius, mass, orbit); surface Generated',
        citation: p.citation,
      };
    });
    return [star, ...planets];
  }

  /** Surface gravity (m/s^2) of a planet, for tests and the Codex. */
  static gravity(p: ExoPlanetSpec): number {
    return (p.massEarth * EARTH_GM) / (p.radiusEarth * EARTH_RADIUS_M) ** 2;
  }
}
