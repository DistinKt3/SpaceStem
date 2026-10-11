/**
 * Geometry of a transiting planetary system in ICRF axes, for circular orbits.
 *
 * Transits fix the orbit's inclination to the line of sight (i, ~90° when edge-on) and each planet's phase (the
 * transit midpoint T0: the planet is between the star and the Solar System). They do not fix the orientation of the
 * orbit around the line of sight (the position angle of the node, Ω), so Ω is a Generated, documented choice.
 *
 * Frame at the star: ŝ = unit vector from the Sun to the star; toward the observer is −ŝ. Sky-plane axes:
 * east ê = normalize(ẑ × ŝ), north n̂ = ŝ × ê (ICRF ẑ = celestial north pole). Node direction û = cos Ω n̂ + sin Ω ê.
 * Orbit normal: cos i·(−ŝ) + sin i·(û × (−ŝ)), perpendicular to û, so i = 90° puts the line of sight in the plane.
 * In-plane axes: x = û, y = normal × x; position r(θ) = a (cos θ x + sin θ y) with θ = θ_T + 2π (t − T0) / P, where
 * θ_T is the in-plane angle closest to the observer direction.
 *
 * Transit epochs are observed (barycentric) times; no light-time correction is applied for the star's distance, so
 * the phases are a model reference, and long-range extrapolation drifts with the period uncertainty.
 */
import { Vec3d } from '../../core/vec3d';
import type { RotationModel } from '../rotation';

const DEG = Math.PI / 180;

export interface CircularOrbit {
  /** Semi-major axis (m). */
  aM: number;
  /** Orbital period (s). */
  periodS: number;
  /** Transit midpoint, TDB seconds since J2000. */
  t0: number;
}

/** BJD_TDB (days) -> TDB seconds since J2000. */
export function bjdToTdbSeconds(bjd: number): number {
  return (bjd - 2_451_545.0) * 86_400;
}

/** Unit vector (ICRF) toward right ascension / declination in degrees. */
export function radecToUnit(raDeg: number, decDeg: number, out = new Vec3d()): Vec3d {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  return out.set(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
}

export class SystemFrame {
  /** Unit vector from the star toward the Solar System (observer). */
  readonly toObserver: Vec3d;
  readonly normal: Vec3d;
  readonly xAxis: Vec3d;
  readonly yAxis: Vec3d;

  /**
   * @param lineOfSight unit vector from the Sun toward the star (ICRF)
   * @param inclinationDeg orbit inclination to the sky plane (90 = edge-on)
   * @param nodeDeg position angle of the ascending node on the sky, east of north (Generated for transiting systems)
   */
  constructor(lineOfSight: Vec3d, inclinationDeg: number, nodeDeg: number) {
    const s = lineOfSight.clone().normalize();
    this.toObserver = s.clone().scale(-1);
    const z = new Vec3d(0, 0, 1);
    let east = z.clone().cross(s);
    // Degenerate at the celestial poles: any perpendicular works.
    if (east.length() < 1e-9) east = new Vec3d(1, 0, 0).cross(s);
    east.normalize();
    const north = s.clone().cross(east).normalize();
    const node = north.clone().scale(Math.cos(nodeDeg * DEG)).add(east.clone().scale(Math.sin(nodeDeg * DEG)));
    const i = inclinationDeg * DEG;
    this.normal = this.toObserver
      .clone()
      .scale(Math.cos(i))
      .add(node.clone().cross(this.toObserver).scale(Math.sin(i)))
      .normalize();
    this.xAxis = node;
    this.yAxis = this.normal.clone().cross(node).normalize();
  }

  /** In-plane angle of the transit (closest approach to the observer direction). */
  get transitAngle(): number {
    return Math.atan2(this.toObserver.dot(this.yAxis), this.toObserver.dot(this.xAxis));
  }

  /** Orbital angle at time t (rad). */
  angle(o: CircularOrbit, t: number): number {
    return this.transitAngle + (2 * Math.PI * (t - o.t0)) / o.periodS;
  }

  /** Planet position relative to the star (m, ICRF). */
  position(o: CircularOrbit, t: number, out = new Vec3d()): Vec3d {
    const th = this.angle(o, t);
    return out
      .copy(this.xAxis)
      .scale(o.aM * Math.cos(th))
      .addScaled(this.yAxis, o.aM * Math.sin(th));
  }

  /** Planet velocity relative to the star (m/s, ICRF). */
  velocity(o: CircularOrbit, t: number, out = new Vec3d()): Vec3d {
    const th = this.angle(o, t);
    const v = (2 * Math.PI * o.aM) / o.periodS;
    return out
      .copy(this.xAxis)
      .scale(-v * Math.sin(th))
      .addScaled(this.yAxis, v * Math.cos(th));
  }

  /** Pole of the orbit as right ascension / declination (deg). */
  poleRaDec(): { ra: number; dec: number } {
    const n = this.normal;
    return { ra: Math.atan2(n.y, n.x) / DEG, dec: Math.asin(Math.max(-1, Math.min(1, n.z))) / DEG };
  }

  /**
   * Rotation model for a synchronously rotating (tidally locked) planet on this orbit: pole along the orbit normal,
   * spin period = orbital period, and body-fixed +x (longitude 0) always facing the star.
   */
  tidallyLocked(o: CircularOrbit): RotationModel {
    const { ra, dec } = this.poleRaDec();
    const n = this.normal;
    // IAU convention: W is measured from the node Q of the body equator on the ICRF equator, Q = (−sin α, cos α, 0).
    const q = new Vec3d(-Math.sin(ra * DEG), Math.cos(ra * DEG), 0);
    const nq = n.clone().cross(q);
    const toStar = this.position(o, 0).scale(-1).normalize();
    const w0 = Math.atan2(toStar.dot(nq), toStar.dot(q)) / DEG;
    const ratePerDay = (360 * 86_400) / o.periodS;
    return { poleRa: [ra], poleDec: [dec], pm: [w0, ratePerDay] };
  }
}
