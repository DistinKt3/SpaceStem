import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ephemeris, type EphemerisFile } from '../../src/world/ephemeris';
import { bodyToIcrf, type RotationModel } from '../../src/world/rotation';
import { Mat3d, Vec3d } from '../../src/core/vec3d';
import { unixMsToTdbSecondsSinceJ2000 } from '../../src/core/time';
import { AU_M } from '../../src/core/constants';

const meta = JSON.parse(readFileSync('public/data/ephemeris.json', 'utf8')) as EphemerisFile;
const bin = readFileSync('public/data/ephemeris.bin');
const eph = new Ephemeris(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const checks = JSON.parse(readFileSync('tests/fixtures/ephemeris_check.json', 'utf8')) as Record<
  string,
  { t: number; p: [number, number, number] }[]
>;
const bodies = (JSON.parse(readFileSync('public/data/bodies.json', 'utf8')) as {
  bodies: { id: string; name: string; rotation: RotationModel }[];
}).bodies;

describe('ephemeris (Chebyshev fit of JPL Horizons)', () => {
  it('reproduces independent Horizons samples within each series tolerance', () => {
    for (const s of meta.bodies) {
      const list = checks[s.id] ?? [];
      expect(list.length).toBeGreaterThan(0);
      for (const c of list) {
        const p = eph.relative(s.id, c.t, new Vec3d());
        const err = Math.hypot(p.x - c.p[0], p.y - c.p[1], p.z - c.p[2]);
        expect(err, `${s.name} at t=${c.t}`).toBeLessThan(Math.max(1, s.maxHeldOutErrorMeters * 1.5));
      }
    }
  });
  it('Earth-Moon distance stays within the known 356,000-407,000 km range', () => {
    for (let d = 0; d < 365 * 5; d += 3) {
      const t = unixMsToTdbSecondsSinceJ2000(Date.UTC(2026, 0, 2) + d * 86_400_000);
      const r = eph.between('301', '399', t, new Vec3d()).length() / 1000;
      expect(r).toBeGreaterThan(356_000);
      expect(r).toBeLessThan(407_000);
    }
  });
  it('Earth-Sun distance is 0.983-1.017 au', () => {
    const t = unixMsToTdbSecondsSinceJ2000(Date.UTC(2027, 6, 4));
    const r = eph.between('399', '10', t, new Vec3d()).length() / AU_M;
    expect(r).toBeGreaterThan(0.983);
    expect(r).toBeLessThan(1.017);
  });
  it('between() agrees with ssb() differences', () => {
    const t = unixMsToTdbSecondsSinceJ2000(Date.UTC(2028, 2, 1));
    const a = eph.between('501', '399', t, new Vec3d());
    const b = eph.ssb('501', t, new Vec3d()).sub(eph.ssb('399', t, new Vec3d()));
    expect(a.distanceTo(b)).toBeLessThan(1); // metres at ~6e11 m
  });
});

describe('rotation models (IAU WGCCRE via NAIF pck00011)', () => {
  const rot = (id: string): RotationModel => bodies.find((b) => b.id === id)!.rotation;
  it("Earth's body-fixed +z maps to the ICRF pole (within precession since J2000)", () => {
    const m = bodyToIcrf(rot('399'), unixMsToTdbSecondsSinceJ2000(Date.UTC(2026, 9, 11)), new Mat3d());
    const z = new Vec3d(0, 0, 1).applyMat3(m);
    expect(z.z).toBeGreaterThan(Math.cos((0.2 * Math.PI) / 180));
  });
  it('the Moon keeps its near side (lon 0) toward Earth, within libration', () => {
    for (let d = 0; d < 60; d += 5) {
      const t = unixMsToTdbSecondsSinceJ2000(Date.UTC(2026, 0, 1) + d * 86_400_000);
      const m = bodyToIcrf(rot('301'), t, new Mat3d());
      const toEarth = eph.between('399', '301', t, new Vec3d()).normalize().applyMat3Transpose(m);
      const lon = (Math.atan2(toEarth.y, toEarth.x) * 180) / Math.PI;
      const lat = (Math.asin(toEarth.z) * 180) / Math.PI;
      expect(Math.abs(lon)).toBeLessThan(9);
      expect(Math.abs(lat)).toBeLessThan(8);
    }
  });
});
