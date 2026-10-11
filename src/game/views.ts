/** Named camera placements used by the onboarding, tests and screenshots. */
import * as THREE from 'three/webgpu';
import { Vec3d } from '../core/vec3d';
import type { SolarSystem, SystemPos } from '../world/solarSystem';

export interface Placement {
  pos: SystemPos;
  quat: THREE.Quaternion;
}

/** Quaternion for a camera at the origin looking along `dir` with `up` (world axes). */
export function lookQuat(dir: Vec3d, up: Vec3d): THREE.Quaternion {
  const cam = new THREE.PerspectiveCamera();
  cam.up.set(up.x, up.y, up.z);
  cam.lookAt(dir.x, dir.y, dir.z);
  return cam.quaternion.clone();
}

/** Body-fixed unit direction at (lat, lon) degrees. */
export function latLonDir(latDeg: number, lonDeg: number): Vec3d {
  const la = (latDeg * Math.PI) / 180;
  const lo = (lonDeg * Math.PI) / 180;
  return new Vec3d(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
}

/** Sub-solar point of a body (lat, lon degrees) at the current update. */
export function subSolar(sys: SolarSystem, id: string): [number, number] {
  const v = sys.byId.get(id)!;
  const s = v.uniforms.sunDir.value;
  const bf = new Vec3d(s.x, s.y, s.z).applyMat3Transpose(v.rotation);
  return [(Math.asin(bf.z) * 180) / Math.PI, (Math.atan2(bf.y, bf.x) * 180) / Math.PI];
}

/**
 * Camera above a body at (lat, lon), altitude above the local terrain, looking toward a heading along the horizon
 * pitched by `pitchDeg` (negative looks down).
 */
export function above(sys: SolarSystem, id: string, latDeg: number, lonDeg: number, altM: number, headingDeg = 0, pitchDeg = 0): Placement {
  const v = sys.byId.get(id)!;
  const bfDir = latLonDir(latDeg, lonDeg);
  const ground = v.def.radiusM + v.terrain.heightAtDir(bfDir.x, bfDir.y, bfDir.z);
  const up = bfDir.clone().applyMat3(v.rotation);
  const offset = up.clone().scale(ground + altM);
  // Local east/north in world axes.
  const north0 = new Vec3d(0, 0, 1).applyMat3(v.rotation);
  const east = north0.clone().cross(up).normalize();
  const north = up.clone().cross(east).normalize();
  const h = (headingDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  const fwd = north.clone().scale(Math.cos(h) * Math.cos(p)).addScaled(east, Math.sin(h) * Math.cos(p)).addScaled(up, Math.sin(p));
  return { pos: { anchor: id, offset }, quat: lookQuat(fwd, up) };
}

/** Camera at `distM` from a body's centre on the sunward side (phase angle `phaseDeg`), looking at it. */
export function facing(sys: SolarSystem, id: string, distM: number, phaseDeg = 40, elevationDeg = 15): Placement {
  const v = sys.byId.get(id)!;
  const s = v.uniforms.sunDir.value;
  // For the Sun itself, "sunward" is undefined: view it from Earth's direction instead.
  const sun =
    v.def.kind === 'star'
      ? sys.byId.get('399')!.rel.clone().sub(v.rel).normalize()
      : new Vec3d(s.x, s.y, s.z).normalize();
  const pole = new Vec3d(0, 0, 1).applyMat3(v.rotation);
  const side = sun.clone().cross(pole).normalize();
  const a = (phaseDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  const dir = sun.clone().scale(Math.cos(a) * Math.cos(e)).addScaled(side, Math.sin(a) * Math.cos(e)).addScaled(pole, Math.sin(e));
  const offset = dir.clone().scale(distM);
  return { pos: { anchor: id, offset }, quat: lookQuat(offset.clone().scale(-1), pole) };
}
