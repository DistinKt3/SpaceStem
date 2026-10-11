import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { buildCockpitGeometry, triangleCount, type CockpitGeometry } from '../../src/render/cockpit/geometry';
import {
  CANOPY,
  LIP_DEPRESSION_DEG,
  PILLAR,
  azElOf,
  canopyPoint,
  canopyTransmission,
  dirAzEl,
  frameClearanceDeg,
  pillarAz,
  type V3,
} from '../../src/render/cockpit/layout';
import { buildGlassTexture } from '../../src/render/cockpit/glassTexture';
import { MODE_KEYS } from '../../src/render/cockpit/displayAtlas';
import { hasKey } from '../../src/game/i18n';

const geos: Record<'high' | 'low', CockpitGeometry> = {
  high: buildCockpitGeometry('high'),
  low: buildCockpitGeometry('low'),
};

/** Every mesh the cockpit draws, one draw call each (all cockpit materials are single pass). */
function meshGeometries(g: CockpitGeometry): THREE.BufferGeometry[] {
  return [g.frame, g.shell, g.skin, g.glass, g.trim, g.lights, g.controls, g.buttons, g.glassBand, ...g.panels.map((p) => p.geometry)];
}

/** Angle (degrees) between a point seen from the eye and straight ahead (-Z). */
function offAxisDeg(x: number, y: number, z: number): number {
  return (Math.acos(-z / Math.hypot(x, y, z)) * 180) / Math.PI;
}

function positions(g: THREE.BufferGeometry): Float32Array {
  return (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
}

describe('cockpit geometry', () => {
  for (const q of ['high', 'low'] as const) {
    it(`stays within the draw-call and triangle budget (${q})`, () => {
      const meshes = meshGeometries(geos[q]);
      const tris = meshes.reduce((s, g) => s + triangleCount(g), 0);
      expect(meshes.length).toBeLessThanOrEqual(40);
      expect(tris).toBeLessThanOrEqual(60_000);
      expect(tris).toBeGreaterThan(5_000);
    });
  }

  it('keeps the central 40 degrees clear of canopy struts', () => {
    expect(frameClearanceDeg()).toBeGreaterThanOrEqual(20);
    const p = positions(geos.high.frame);
    let min = 180;
    for (let i = 0; i < p.length; i += 3) min = Math.min(min, offAxisDeg(p[i]!, p[i + 1]!, p[i + 2]!));
    expect(min).toBeGreaterThanOrEqual(20);
  });

  it('keeps the holographic panes outside the central 40 degrees', () => {
    for (const panel of geos.high.panels.filter((p) => p.type === 'holo')) {
      const p = positions(panel.geometry);
      for (let i = 0; i < p.length; i += 3) expect(offAxisDeg(p[i]!, p[i + 1]!, p[i + 2]!)).toBeGreaterThanOrEqual(20);
    }
  });

  it('puts the dashboard top edge about 18 degrees below the forward horizon', () => {
    const p = positions(geos.high.shell);
    let top = -90;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!;
      const y = p[i + 1]!;
      const z = p[i + 2]!;
      if (Math.abs(x) > 0.05 || z > 0) continue;
      top = Math.max(top, (Math.atan2(y, Math.hypot(x, z)) * 180) / Math.PI);
    }
    expect(top).toBeGreaterThan(-LIP_DEPRESSION_DEG - 1);
    expect(top).toBeLessThan(-LIP_DEPRESSION_DEG + 1);
  });

  it('places displays that face the pilot', () => {
    const kinds = geos.high.panels.map((p) => p.kind).sort();
    expect(kinds).toEqual(['attitude', 'mode', 'speed', 'status', 'throttle']);
    for (const panel of geos.high.panels) {
      const toEye = panel.center.clone().negate().normalize();
      expect(panel.normal.dot(toEye)).toBeGreaterThan(0.5);
      expect(panel.width).toBeGreaterThan(0.08);
    }
  });

  it('builds the same geometry every time (deterministic)', () => {
    const again = buildCockpitGeometry('low');
    expect(Array.from(positions(again.frame).slice(0, 300))).toEqual(Array.from(positions(geos.low.frame).slice(0, 300)));
    expect(triangleCount(again.shell)).toBe(triangleCount(geos.low.shell));
  });
});

describe('canopy light model', () => {
  const dash: V3 = [0, -0.26, -0.6];

  it('passes light through clear glass and blocks it behind the hull', () => {
    expect(canopyTransmission(dash, dirAzEl(0, 45))).toBeCloseTo(1, 3);
    expect(canopyTransmission(dash, dirAzEl(180, -30))).toBe(0);
    // Below the side sill.
    expect(canopyTransmission([0, -0.25, -0.3], dirAzEl(90, -45))).toBe(0);
  });

  it('casts a strut shadow where the ray crosses an A-pillar', () => {
    // Aim from the dashboard at a point on the right pillar centre line.
    const el = 10;
    const target = canopyPoint(pillarAz(el), el);
    const d: V3 = [target[0] - dash[0], target[1] - dash[1], target[2] - dash[2]];
    const len = Math.hypot(...d);
    const dir: V3 = [d[0] / len, d[1] / len, d[2] / len];
    expect(canopyTransmission(dash, dir)).toBeLessThan(0.05);
    // A few degrees to the side the light gets through.
    const [az, e] = azElOf(dir);
    expect(canopyTransmission(dash, dirAzEl(az + 6, e))).toBeGreaterThan(0.95);
  });

  it('has pillars that converge above the forward view', () => {
    expect(pillarAz(PILLAR.baseEl)).toBeCloseTo(PILLAR.baseAz, 6);
    expect(pillarAz(PILLAR.apexEl)).toBe(0);
    expect(pillarAz(30)).toBeGreaterThan(15);
    expect(CANOPY.sillEl).toBeLessThan(-LIP_DEPRESSION_DEG);
  });
});

describe('canopy wear texture', () => {
  it('is deterministic and contains scratches and smudges', () => {
    const a = buildGlassTexture(256, 7);
    const b = buildGlassTexture(256, 7);
    const c = buildGlassTexture(256, 8);
    expect(a.data.length).toBe(256 * 256 * 4);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(Buffer.from(a.data).equals(Buffer.from(c.data))).toBe(false);
    let scratched = 0;
    let smudgeSum = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i]! > 40) scratched++;
      smudgeSum += a.data[i + 3]!;
    }
    const n = a.data.length / 4;
    expect(scratched / n).toBeGreaterThan(0.01);
    expect(scratched / n).toBeLessThan(0.4);
    expect(smudgeSum / n / 255).toBeGreaterThan(0.03);
    expect(smudgeSum / n / 255).toBeLessThan(0.5);
  });
});

describe('cockpit strings', () => {
  it('has every display label in the locale files', () => {
    const keys = [
      'cockpit.throttle',
      'cockpit.speed',
      'cockpit.mode',
      'cockpit.ofModeLimit',
      'cockpit.attitude',
      'cockpit.sun',
      'cockpit.planet',
      'cockpit.drive',
      'cockpit.status',
      'cockpit.sunlight',
      'cockpit.alertLevel',
      'cockpit.nominal',
      'cockpit.alert',
      ...MODE_KEYS.map((m) => `cockpit.mode.${m}`),
    ];
    for (const k of keys) expect(hasKey(k), k).toBe(true);
  });
});
