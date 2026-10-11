/**
 * Starfield camera precision: the shader computes star - camera in float32. With the camera as one float32 vector,
 * a star the ship has just arrived at lands degrees away from its true direction (the visited star's "phantom").
 * With the hi/lo split of setCameraPc, the same float32 arithmetic keeps it on target. Emulates the shader with
 * Math.fround over every named star within 31 pc, at its hyperspeed arrival point (D-026).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AU_M, PARSEC_M } from '../../src/core/constants';
import { Starfield } from '../../src/render/starfield';
import { inferStar } from '../../src/world/starCatalog';

const bin = readFileSync('public/data/stars.bin');
const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
const named = (JSON.parse(readFileSync('public/data/stars.json', 'utf8')) as { named: Record<string, { name: string; bv: number }> }).named;
const f = Math.fround;

function angleDeg(a: number[], b: number[]): number {
  const la = Math.hypot(a[0]!, a[1]!, a[2]!);
  const lb = Math.hypot(b[0]!, b[1]!, b[2]!);
  if (la === 0) return 180;
  const c = (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (la * lb);
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
}

describe('Starfield camera position (float32 hi/lo split)', () => {
  it('stores the float32-rounded position and the remainder', () => {
    const s = new Starfield();
    const x = -0.472263992;
    const y = -0.3614509;
    const z = -1.15121901;
    s.setCameraPc(x, y, z);
    expect(s.camPc.value.x).toBe(f(x));
    expect(s.camPc.value.x + s.camPcLo.value.x).toBe(x);
    expect(s.camPc.value.y + s.camPcLo.value.y).toBe(y);
    expect(s.camPc.value.z + s.camPcLo.value.z).toBe(z);
  });

  it('keeps every nearby named star on its true direction at its arrival point', () => {
    const s = new Starfield();
    let worstOld = { deg: 0, name: '' };
    let worstNew = { deg: 0, name: '' };
    let checked = 0;
    for (const [k, info] of Object.entries(named)) {
      const i = Number(k);
      const p = [dv.getFloat32(i * 20, true), dv.getFloat32(i * 20 + 4, true), dv.getFloat32(i * 20 + 8, true)];
      const r = Math.hypot(p[0]!, p[1]!, p[2]!);
      if (r > 31 || r < 1e-6) continue;
      const inf = inferStar(dv.getFloat32(i * 20 + 12, true), info.bv);
      const arrivalPc = Math.max(1.6 * Math.sqrt(inf.luminositySun) * AU_M, 120 * inf.radiusM) / PARSEC_M;
      // Approach along the Sun-star line, stopping at the arrival distance (float64, as the game's SystemPos is).
      const cam = p.map((x) => x * (1 - arrivalPc / r));
      const exact = p.map((x, j) => x - cam[j]!);
      const old = p.map((x, j) => f(x - f(cam[j]!)));
      s.setCameraPc(cam[0]!, cam[1]!, cam[2]!);
      const hi = [s.camPc.value.x, s.camPc.value.y, s.camPc.value.z];
      const lo = [s.camPcLo.value.x, s.camPcLo.value.y, s.camPcLo.value.z];
      const split = p.map((x, j) => f(f(x - f(hi[j]!)) - f(lo[j]!)));
      const dOld = angleDeg(old, exact);
      const dNew = angleDeg(split, exact);
      if (dOld > worstOld.deg) worstOld = { deg: dOld, name: info.name };
      if (dNew > worstNew.deg) worstNew = { deg: dNew, name: info.name };
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
    // One float32 vector: up to 90 degrees off (or a zero vector) for faint dwarfs, 8 degrees for Proxima Centauri.
    expect(worstOld.deg).toBeGreaterThan(5);
    // Hi/lo split: well under a pixel (1 px is ~0.1 degree at 1080p and 60 degrees field of view).
    expect(worstNew.deg, worstNew.name).toBeLessThan(1e-3);
  });
});
