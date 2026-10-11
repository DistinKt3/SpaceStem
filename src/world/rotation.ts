/**
 * IAU WGCCRE rotation models (Archinal et al. 2018) as distributed in NAIF pck00011.tpc. Produces the rotation from
 * body-fixed axes (+z north pole, +x prime meridian) to ICRF.
 */
import { Mat3d } from '../core/vec3d';

export interface RotationModel {
  poleRa: number[];
  poleDec: number[];
  pm: number[];
  nutRa?: number[];
  nutDec?: number[];
  nutPm?: number[];
  /** Pairs (deg, deg per Julian century). */
  nutAngles?: number[];
}

const DEG = Math.PI / 180;

/** Pole right ascension/declination and prime meridian angle (degrees) at TDB seconds since J2000. */
export function rotationAngles(rot: RotationModel, t: number): { ra: number; dec: number; w: number } {
  const d = t / 86_400;
  const T = d / 36_525;
  let ra = rot.poleRa[0]! + (rot.poleRa[1] ?? 0) * T + (rot.poleRa[2] ?? 0) * T * T;
  let dec = rot.poleDec[0]! + (rot.poleDec[1] ?? 0) * T + (rot.poleDec[2] ?? 0) * T * T;
  let w = rot.pm[0]! + (rot.pm[1] ?? 0) * d + (rot.pm[2] ?? 0) * d * d;
  const ang = rot.nutAngles;
  if (ang) {
    const n = ang.length / 2;
    for (let i = 0; i < n; i++) {
      const th = (ang[2 * i]! + ang[2 * i + 1]! * T) * DEG;
      const s = Math.sin(th);
      const c = Math.cos(th);
      ra += (rot.nutRa?.[i] ?? 0) * s;
      dec += (rot.nutDec?.[i] ?? 0) * c;
      w += (rot.nutPm?.[i] ?? 0) * s;
    }
  }
  return { ra, dec, w };
}

const tmpA = new Mat3d();
const tmpB = new Mat3d();

/** out = Rz(ra + 90°) · Rx(90° − dec) · Rz(W): body-fixed -> ICRF. */
export function bodyToIcrf(rot: RotationModel, t: number, out: Mat3d): Mat3d {
  const { ra, dec, w } = rotationAngles(rot, t);
  tmpA.rotationZ((ra + 90) * DEG);
  tmpB.rotationX((90 - dec) * DEG);
  out.multiplyMatrices(tmpA, tmpB);
  tmpA.copy(out);
  tmpB.rotationZ(w * DEG);
  return out.multiplyMatrices(tmpA, tmpB);
}
