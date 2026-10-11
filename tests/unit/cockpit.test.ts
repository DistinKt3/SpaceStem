import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  BOW_MID_Z,
  buildCockpitGeometry,
  pillarArchPoints,
  pillarLightStrips,
  sillPoints,
  spinePoints,
  strutProfile,
  sweepOnCanopy,
  triangleCount,
  type CockpitGeometry,
} from '../../src/render/cockpit/geometry';
import {
  CANOPY,
  DEG,
  HOLO_PANES,
  LIP_DEPRESSION_DEG,
  PILLAR,
  azElOf,
  canopyPoint,
  canopyTransmission,
  dirAzEl,
  frameClearanceDeg,
  frameDistance,
  pillarAz,
  pillarDistanceDeg,
  type V3,
} from '../../src/render/cockpit/layout';
import { buildGlassTexture } from '../../src/render/cockpit/glassTexture';
import { LAYOUT, MODE_KEYS } from '../../src/render/cockpit/displayAtlas';
import { ACCENT_EMISSION, ACCENT_HEX, attitudeMarker, panelLook, percentLayout } from '../../src/render/cockpit/state';
import { agx, displayedSrgb, emissionFor, hexToSrgb, hsv } from '../../src/render/cockpit/tone';
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

function vertices(g: THREE.BufferGeometry): V3[] {
  const p = positions(g);
  const out: V3[] = [];
  for (let i = 0; i < p.length; i += 3) out.push([p[i]!, p[i + 1]!, p[i + 2]!]);
  return out;
}

/** Points along the outline of a holo pane (its quad's four edges). */
function paneOutline(g: THREE.BufferGeometry, n = 40): V3[] {
  const c = vertices(g); // PlaneGeometry 1x1 segments: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right
  const ring = [c[0]!, c[1]!, c[3]!, c[2]!];
  const out: V3[] = [];
  for (let e = 0; e < 4; e++) {
    const a = ring[e]!;
    const b = ring[(e + 1) % 4]!;
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
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
    let min = 180;
    for (const [x, y, z] of vertices(geos.high.frame)) min = Math.min(min, offAxisDeg(x, y, z));
    expect(min).toBeGreaterThanOrEqual(20);
  });

  it('has at least three holographic panes, all outside the central 40 degrees', () => {
    const holo = geos.high.panels.filter((p) => p.type === 'holo');
    expect(holo.map((p) => p.kind).sort()).toEqual(['attitude', 'speed', 'throttle']);
    for (const panel of holo) {
      for (const [x, y, z] of vertices(panel.geometry)) expect(offAxisDeg(x, y, z)).toBeGreaterThanOrEqual(20);
    }
  });

  it('keeps the attitude pane below the dashboard lip line', () => {
    const pane = geos.high.panels.find((p) => p.kind === 'attitude')!;
    for (const v of vertices(pane.geometry)) expect(azElOf(v)[1]).toBeLessThan(-LIP_DEPRESSION_DEG - 1.5);
  });

  it('keeps the holographic panes clear of the A-pillars (analytic centre line)', () => {
    for (const panel of geos.high.panels.filter((p) => p.type === 'holo')) {
      for (const v of paneOutline(panel.geometry)) {
        const [az, el] = azElOf(v);
        const r = Math.hypot(...canopyPoint(pillarAz(el) * Math.sign(az || 1), el));
        const halfWidthDeg = PILLAR.width / 2 / r / DEG;
        expect(pillarDistanceDeg(az, el), `${panel.kind} at az ${az.toFixed(1)} el ${el.toFixed(1)}`).toBeGreaterThan(halfWidthDeg + 1.5);
      }
    }
  });

  it('keeps the holographic panes clear of the A-pillar geometry and its light strip', () => {
    // The pillar as built (its 5 cm depth widens the silhouette seen from the eye) and the light strip on it.
    const pillar = [sweepOnCanopy(pillarArchPoints(140), strutProfile(PILLAR.width, PILLAR.depth, 14), true), ...pillarLightStrips()].flatMap(vertices);
    for (const kind of ['throttle', 'speed'] as const) {
      const pane = geos.high.panels.find((p) => p.kind === kind)!;
      const outline = paneOutline(pane.geometry).map(azElOf);
      const elMin = Math.min(...outline.map((o) => o[1]));
      const elMax = Math.max(...outline.map((o) => o[1]));
      const paneOuter = Math.max(...outline.map((o) => Math.abs(o[0])));
      let pillarInner = 180;
      for (const v of pillar) {
        const [az, el] = azElOf(v);
        if (el < elMin - 1 || el > elMax + 1 || Math.sign(az) !== Math.sign(HOLO_PANES[kind].az)) continue;
        pillarInner = Math.min(pillarInner, Math.abs(az));
      }
      expect(pillarInner - paneOuter, kind).toBeGreaterThan(1.5);
    }
  });

  it('puts the dashboard top edge about 18 degrees below the forward horizon', () => {
    let top = -90;
    for (const [x, y, z] of vertices(geos.high.shell)) {
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

  it('ends frame members inside their neighbours (no stubs)', () => {
    // The spine starts on the arch apex and ends on the rear bow's centre plane; so do the side sills.
    const spine = spinePoints(40);
    expect(azElOf(spine[0]!.toArray())[1]).toBeCloseTo(PILLAR.apexEl, 1);
    expect(spine[spine.length - 1]!.z).toBeCloseTo(BOW_MID_Z, 4);
    for (const sign of [1, -1] as const) {
      const sill = sillPoints(sign, 40);
      expect(sill[sill.length - 1]!.z).toBeCloseTo(BOW_MID_Z, 4);
      // Starts inside the A-pillar.
      const [az0] = azElOf(sill[0]!.toArray());
      expect(Math.abs(az0)).toBeLessThan(pillarAz(CANOPY.sillEl));
    }
  });

  it('builds the same geometry every time (deterministic)', () => {
    const again = buildCockpitGeometry('low');
    expect(Array.from(positions(again.frame).slice(0, 300))).toEqual(Array.from(positions(geos.low.frame).slice(0, 300)));
    expect(triangleCount(again.shell)).toBe(triangleCount(geos.low.shell));
  });
});

describe('canopy light model (shared by the CPU and the shaders)', () => {
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

  it('measures the distance to the A-pillar accurately, including near the apex', () => {
    // Brute force: great-circle distance to the densely sampled centre line (both pillars).
    const curve: V3[] = [];
    for (let i = 0; i <= 6000; i++) {
      const el = PILLAR.baseEl - 6 + ((PILLAR.apexEl - PILLAR.baseEl + 6) * i) / 6000;
      curve.push(dirAzEl(pillarAz(el), el), dirAzEl(-pillarAz(el), el));
    }
    const trueDist = (az: number, el: number): number => {
      const d = dirAzEl(az, el);
      let best = 1;
      for (const c of curve) best = Math.min(best, Math.acos(Math.min(1, d[0] * c[0] + d[1] * c[1] + d[2] * c[2])));
      return best / DEG;
    };
    const els = [-18, -10, 0, 15, 30, 40, 46, 50, 51, 51.5, 51.9, 51.99, 52, 52.5, 54, 60, 75];
    for (const el of els) {
      for (let az = 0; az <= 90; az += 2.5) {
        const est = pillarDistanceDeg(az, el);
        const tru = trueDist(az, el);
        const at = `az ${az} el ${el}: model ${est.toFixed(2)} true ${tru.toFixed(2)}`;
        // Never reports a strut (or the glass edge tint, ~3 degrees wide) where there is none...
        if (tru > 4) expect(est, at).toBeGreaterThan(2.5);
        // ...and is accurate close to the strut, where shadows and the tint are drawn.
        if (tru <= 3) expect(Math.abs(est - tru), at).toBeLessThan(0.3 * tru + 0.05);
      }
    }
  });

  it('draws no false strut shadow or edge band across the overhead glass below the apex', () => {
    // Directions on the overhead glass away from the arch, just below the apex elevation (where the pillar curve
    // runs horizontally): sunlight passes and the glass is untinted.
    for (let el = 50.5; el <= 52.2; el += 0.1) {
      for (let az = 20; az <= 80; az += 5) {
        const q = canopyPoint(az, el);
        expect(frameDistance(q), `az ${az} el ${el}`).toBeGreaterThan(0.055);
        expect(canopyTransmission([0, 0, 0], dirAzEl(az, el)), `az ${az} el ${el}`).toBeGreaterThan(0.99);
      }
    }
  });
});

describe('cockpit state logic', () => {
  const A = LAYOUT.attitude;

  it('places attitude markers on a nose-centred polar plot', () => {
    const at = (x: number, y: number, z: number): [number, number] => attitudeMarker({ x, y, z }, A)!;
    const [cx, cy] = at(0, 0, -1);
    expect(cx).toBeCloseTo(A.cx, 6);
    expect(cy).toBeCloseTo(A.cy, 6);
    // Right of the nose: to the right on the display, on the 90 degree ring.
    const right = at(1, 0, 0);
    expect(right[0]).toBeCloseTo(A.cx + A.r90, 6);
    expect(right[1]).toBeCloseTo(A.cy, 6);
    // Above: up on the display (y down).
    const upM = at(0, 1, 0);
    expect(upM[0]).toBeCloseTo(A.cx, 6);
    expect(upM[1]).toBeCloseTo(A.cy - A.r90, 6);
    // 45 degrees left: halfway to the 90 degree ring.
    const left45 = at(-Math.SQRT1_2, 0, -Math.SQRT1_2);
    expect(left45[0]).toBeCloseTo(A.cx - A.r90 / 2, 6);
    // Straight behind: just inside the outer ring; magnitude does not matter.
    const behind = at(0.001, 0, 5);
    expect(Math.hypot(behind[0] - A.cx, behind[1] - A.cy)).toBeCloseTo(A.rMax - 4, 1);
    expect(attitudeMarker({ x: 0, y: 0, z: 0 }, A)).toBeNull();
  });

  it('shows the accent when calm and turns warm with an alert', () => {
    const calm = panelLook(0, 3, false);
    expect(calm.emission).toEqual(ACCENT_EMISSION);
    expect(calm.gain).toBe(1);
    const alarm = panelLook(1, 3, false);
    expect(alarm.toAlert).toBe(1);
    expect(alarm.emission[0]).toBeGreaterThan(alarm.emission[2] + 0.3);
    expect(alarm.light[0]).toBeGreaterThan(alarm.light[2]);
    // Clamped input.
    expect(panelLook(2, 3, false)).toEqual(alarm);
    expect(panelLook(-1, 3, false)).toEqual(calm);
    expect(panelLook(Number.NaN, 3, false)).toEqual(calm);
  });

  it('pulses the alert only when motion is allowed', () => {
    const a = panelLook(0.9, 1.0, true);
    const b = panelLook(0.9, 1.45, true);
    expect(b).toEqual(a);
    const c = panelLook(0.9, 1.0, false);
    const d = panelLook(0.9, 1.45, false);
    expect(Math.abs(c.gain - d.gain)).toBeGreaterThan(0.1);
    expect(Math.abs(c.emission[1] - d.emission[1])).toBeGreaterThan(1e-3);
  });

  it('lays out percent readouts per locale pattern', () => {
    expect(percentLayout('{value}%')).toEqual({ unit: '%', before: false, gap: false });
    expect(percentLayout('{value} %')).toEqual({ unit: '%', before: false, gap: true });
    expect(percentLayout('%{value}')).toEqual({ unit: '%', before: true, gap: false });
    expect(percentLayout('% {value}')).toEqual({ unit: '%', before: true, gap: true });
    expect(percentLayout('broken')).toEqual({ unit: '%', before: false, gap: false });
  });
});

describe('display colour through AgX', () => {
  it('ports three.js AgX (black stays black, brighter stays brighter)', () => {
    expect(agx([0, 0, 0])).toEqual([0, 0, 0]);
    let prev = -1;
    for (const k of [0.01, 0.1, 0.5, 1, 4, 16]) {
      const g = agx([k, k, k])[1];
      expect(g).toBeGreaterThan(prev);
      prev = g;
    }
  });

  it('emits the accent so that it displays with the accent hue and saturation', () => {
    const want = hsv(hexToSrgb(ACCENT_HEX));
    const got = hsv(displayedSrgb(ACCENT_EMISSION));
    expect(Math.abs(got.h - want.h)).toBeLessThan(0.01);
    expect(Math.abs(got.s - want.s)).toBeLessThan(0.05);
    expect(got.v).toBeGreaterThan(0.8);
    // Plain linear emission of the accent (what AgX washed out before) is far less saturated.
    expect(hsv(displayedSrgb(hexToSrgb(ACCENT_HEX).map((v) => Math.pow(v, 2.2) * 1.35) as [number, number, number])).s).toBeLessThan(0.3);
  });

  it('converges for warm alert colours', () => {
    for (const hex of ['#ffb03a', '#ff3b30']) {
      const shown = hsv(displayedSrgb(emissionFor(hex, 0.66)));
      expect(shown.h).toBeLessThan(0.1);
      expect(shown.s).toBeGreaterThan(0.5);
    }
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
      'cockpit.percent',
      ...MODE_KEYS.map((m) => `cockpit.mode.${m}`),
    ];
    for (const k of keys) expect(hasKey(k), k).toBe(true);
  });
});
