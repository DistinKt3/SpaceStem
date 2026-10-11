/** Two-body orbit helpers (used for map orbit lines). */
import type { Vec3d } from '../core/vec3d';

/**
 * Points on the osculating two-body orbit through state (r, v) about a body with gravitational parameter mu
 * (m^3/s^2). Ellipses are closed; hyperbolic or degenerate states return just the current position.
 */
export function keplerOrbit(r: Vec3d, v: Vec3d, mu: number, n: number): Vec3d[] {
  const rLen = r.length();
  const h = r.clone().cross(v);
  const hLen = h.length();
  const energy = v.lengthSq() / 2 - mu / rLen;
  if (hLen === 0 || energy >= 0) return [r.clone()];
  const a = -mu / (2 * energy);
  // Eccentricity vector e = (v x h)/mu - r/|r| points to periapsis.
  const eVec = v.clone().cross(h).scale(1 / mu).sub(r.clone().scale(1 / rLen));
  const e = eVec.length();
  const P = e > 1e-9 ? eVec.clone().scale(1 / e) : r.clone().scale(1 / rLen);
  const Q = h.clone().scale(1 / hLen).cross(P);
  const p = a * (1 - e * e);
  const out: Vec3d[] = [];
  for (let k = 0; k <= n; k++) {
    const nu = (k / n) * Math.PI * 2;
    const rr = p / (1 + e * Math.cos(nu));
    out.push(P.clone().scale(rr * Math.cos(nu)).add(Q.clone().scale(rr * Math.sin(nu))));
  }
  return out;
}
