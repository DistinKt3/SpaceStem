/**
 * World and sky regressions: per-star glare at a visited star, no float32 "phantom" of the visited star in the
 * starfield (the star stays visible as a point once unresolved, and when dead ahead), body rotations refreshed before
 * ship physics, eye adaptation per second (not per frame), no stale cockpit in free-camera mode, and the startup
 * body order.
 */
import { test, expect, type Page } from '@playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
type Any = any;

async function boot(page: Page, errors: string[], query = 'msaa=0&bloom=0&cockpit=0'): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
  });
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => (window as unknown as { __ks?: unknown }).__ks !== undefined, null, { timeout: 180_000 });
}

/** Hyperspeed to Proxima Centauri (as in app.spec.ts); returns its catalogue index once it is a lit body. */
async function arriveAtProxima(page: Page): Promise<number> {
  const idx = await page.evaluate(() => {
    const app = (window as unknown as { __ks: Any }).__ks.app;
    const cat = app.catalog;
    const i = cat.destinations({ x: 0, y: 0, z: 0, length: () => 0 }, 2, 20).find((k: number) => cat.name(k) === 'Proxima Centauri');
    const c = app.controller;
    c.ship.pos.offset.x = 2e9;
    c.ship.pos.offset.y = 0;
    c.ship.pos.offset.z = 0;
    c.targetId = `*${i}`;
    c.engageHyperspeed();
    for (let k = 0; k < 80 && c.hyper.phase !== 'idle'; k++) c.update(0.5, app);
    return i as number;
  });
  await page.waitForFunction((id) => (window as unknown as { __ks: Any }).__ks.app.sys.byId.has(id), `*${idx}`, { timeout: 60_000 });
  return idx;
}

/**
 * Point the camera `offDeg` away from a world direction, capture a frame, and return the brightest luminance (0-255)
 * in a 13x13 px window where that direction lands, plus the number of pixels brighter than 100 within 120 px of it.
 */
async function lookNear(page: Page, dir: number[], offDeg: number): Promise<{ max: number; bright: number }> {
  return page.evaluate(
    async ([d, offDeg]) => {
      const ks = (window as unknown as { __ks: Any }).__ks;
      const app = ks.app;
      const n = Math.hypot(d[0]!, d[1]!, d[2]!);
      const t = [d[0]! / n, d[1]! / n, d[2]! / n];
      // Forward = the direction turned by offDeg about an axis perpendicular to it.
      const ax = Math.abs(t[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const u = [t[1]! * ax[2]! - t[2]! * ax[1]!, t[2]! * ax[0]! - t[0]! * ax[2]!, t[0]! * ax[1]! - t[1]! * ax[0]!];
      const un = Math.hypot(...u);
      const o = (offDeg * Math.PI) / 180;
      const f = [0, 1, 2].map((k) => t[k]! * Math.cos(o) + (u[k]! / un) * Math.sin(o));
      // Quaternion rotating -Z onto f.
      const q = [f[1]!, -f[0]!, 0, 1 - f[2]!];
      const l = Math.hypot(...q);
      const c = app.controller;
      c.autoAlign = false;
      c.ship.quat.set(q[0]! / l, q[1]! / l, q[2]! / l, q[3]! / l);
      ks.capture(); // settle (first frame after a large turn)
      const url = ks.capture() as string;
      const cam = app.frame.camera;
      const v = cam.position.clone().set(t[0]! * 1e6, t[1]! * 1e6, t[2]! * 1e6).project(cam) as { x: number; y: number };
      const img = new Image();
      img.src = url;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.width;
      cv.height = img.height;
      const g = cv.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      const px = Math.round(((v.x + 1) / 2) * img.width);
      const py = Math.round(((1 - v.y) / 2) * img.height);
      const lum = (a: Uint8ClampedArray, i: number): number => 0.2126 * a[i]! + 0.7152 * a[i + 1]! + 0.0722 * a[i + 2]!;
      const w = g.getImageData(px - 6, py - 6, 13, 13).data;
      let max = 0;
      for (let i = 0; i < w.length; i += 4) max = Math.max(max, lum(w, i));
      const all = g.getImageData(0, 0, img.width, img.height).data;
      let bright = 0;
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          if ((x - px) ** 2 + (y - py) ** 2 > 120 * 120) continue;
          if (lum(all, (y * img.width + x) * 4) > 100) bright++;
        }
      }
      return { max, bright };
    },
    [dir, offDeg] as const,
  );
}

test('at a visited star each star has its own glare and the starfield draws no phantom of it', async ({ page }) => {
  const errors: string[] = [];
  // No Milky Way glow, so only stars and glare light the sky.
  await boot(page, errors, 'msaa=0&bloom=0&cockpit=0&mwGain=0');
  const idx = await arriveAtProxima(page);
  const r = await page.evaluate((i) => {
    const app = (window as unknown as { __ks: Any }).__ks.app;
    app.tick();
    const AU = 1.495978707e11;
    const PC = 3.085677581491367e16;
    const sun = app.sys.byId.get('10');
    const star = app.sys.byId.get(`*${i}`);
    // Where a float32 starfield sprite lands: fround(star) - fround(camera), both heliocentric parsecs.
    const f = Math.fround;
    const cam = app.sys.toSsb(app.cam.pos, app.simTime, star.rel.clone()).sub(app.sys.ephemeris.ssb('10', app.simTime, star.rel.clone())).scale(1 / PC);
    const P = app.stars.positions;
    const rel = [f(P[i * 3] - f(cam.x)), f(P[i * 3 + 1] - f(cam.y)), f(P[i * 3 + 2] - f(cam.z))];
    const rl = Math.hypot(...rel);
    const sd = star.rel.clone().normalize();
    const phantomDeg = (Math.acos(Math.min(1, (rel[0]! * sd.x + rel[1]! * sd.y + rel[2]! * sd.z) / rl)) * 180) / Math.PI;
    const su = sun.rel.clone().normalize();
    return {
      sunGlare: sun.glare?.intensity.value,
      sunExpected: (AU / sun.rel.length()) ** 2,
      starGlare: star.glare?.intensity.value,
      starExpected: Math.min(50, star.def.luminositySun * (AU / star.rel.length()) ** 2),
      hidden: app.stars.hiddenIndex?.value,
      phantomDir: rel.map((x) => x / rl),
      phantomDeg,
      sunDir: [su.x, su.y, su.z],
    };
  }, idx);
  // Glare: the Sun 1.3 pc behind keeps its own ~1e-11, the local star gets L (1 au / d)^2 (~0.38 at arrival).
  expect(r.sunGlare).toBeLessThan(1e-9);
  expect(r.sunGlare! / r.sunExpected).toBeCloseTo(1, 6);
  expect(r.starGlare! / r.starExpected).toBeCloseTo(1, 6);
  expect(r.starGlare).toBeLessThan(1);
  // Looking back at the Sun: a bright point (magnitude ~0.4), not a 14 degree glare. Dead ahead on purpose: a star
  // at the streak vanishing point must not collapse to nothing.
  const sun = await lookNear(page, r.sunDir, 0);
  expect(sun.max).toBeGreaterThan(100);
  expect(sun.bright).toBeLessThan(200);
  // The visited star is drawn as a body, so its catalogue sprite is not drawn again: nothing bright where a float32
  // sprite would land, several degrees from the star (seen from 3 degrees away, off the streak vanishing point).
  // Before the fix that spot held a saturated sprite (~245); after it only faint background stars (~65).
  expect(r.hidden).toBe(idx);
  expect(r.phantomDeg).toBeGreaterThan(2);
  const phantom = await lookNear(page, r.phantomDir, 3);
  expect(phantom.max).toBeLessThan(150);
  expect(errors).toEqual([]);
});

test('a visited star stays in the sky as a point once it is too small to resolve', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  const idx = await arriveAtProxima(page);
  const r = await page.evaluate((i) => {
    const app = (window as unknown as { __ks: Any }).__ks.app;
    const c = app.controller;
    // 100 au out along the current direction (still anchored on the star).
    c.ship.pos.offset.normalize().scale(1.495978707e13);
    c.ship.vel.set(0, 0, 0);
    app.tick();
    const star = app.sys.byId.get(`*${i}`);
    const d = star.rel.length();
    const dir = star.rel.clone().scale(1 / d);
    const want = Number(app.catalog.absMags[i]) + 5 * Math.log10(d / 3.085677581491367e16) - 5;
    const st = app.stars;
    const n = st.planetMag.count;
    let best = { cos: -2, mag: 99 };
    for (let k = 0; k < n; k++) {
      const m = st.planetMag.getX(k);
      if (m > 90) continue;
      const [x, y, z] = [st.planetDir.getX(k), st.planetDir.getY(k), st.planetDir.getZ(k)];
      const cos = (x * dir.x + y * dir.y + z * dir.z) / Math.hypot(x, y, z); // float32 components: not unit length
      if (cos > best.cos) best = { cos, mag: m };
    }
    return { px: star.angularRadiusPx, hidden: st.hiddenIndex?.value, cos: best.cos, mag: best.mag, want };
  }, idx);
  expect(r.px).toBeLessThan(1.5);
  expect(r.hidden).toBe(idx);
  // Same direction as the body to float32 precision.
  expect(1 - r.cos, JSON.stringify(r)).toBeLessThan(1e-12);
  expect(r.mag).toBeCloseTo(r.want, 3);
  expect(errors).toEqual([]);
});

test('a landed ship stays fixed to the ground whatever the frame time (rotation refreshed before physics)', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  await page.evaluate(() => (window as unknown as { __ks: Any }).__ks.setView('earth-low'));
  const drift = await page.evaluate(() => {
    const app = (window as unknown as { __ks: Any }).__ks.app;
    const c = app.controller;
    const realNow = performance.now.bind(performance);
    let now = realNow();
    performance.now = () => now;
    try {
      now += 16;
      app.tick();
      const ship = c.ship;
      const [near] = app.sys.nearest(ship.pos, app.simTime);
      ship.land(app.sys, near, app.simTime);
      const view = app.sys.byId.get(ship.pos.anchor);
      const bf0 = ship.landedBf.clone();
      const out: number[] = [];
      for (const ms of [16.7, 16.7, 33.3, 100, 8.3, 16.7]) {
        now += ms;
        app.tick();
        // Body-fixed camera position with the rotation the frame was drawn with.
        out.push(app.cam.pos.offset.clone().applyMat3Transpose(view.rotation).distanceTo(bf0));
      }
      return { landed: ship.landed, anchor: ship.pos.anchor, out };
    } finally {
      performance.now = realNow;
    }
  });
  expect(drift.landed).toBe(true);
  expect(drift.anchor).toBe('399');
  // Before the fix the camera slid by omega * r * dt: ~7 m per 60 Hz frame and ~40 m on a 0.1 s frame.
  expect(Math.max(...drift.out)).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});

test('eye adaptation and sky dimming run per second, not per frame', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  const r = await page.evaluate(() => {
    const app = (window as unknown as { __ks: Any }).__ks.app;
    const realNow = performance.now.bind(performance);
    let now = realNow();
    performance.now = () => now;
    // Paused: sim time and the ship are frozen, so the targets stay fixed while frames keep rendering.
    app.paused = true;
    try {
      now += 16;
      app.tick();
      // The targets themselves (one very long step).
      app.updateExposure(1e9);
      app.updateSky(1e9);
      const target = { exposure: app.exposureState as number, sky: app.skyVisibility as number };
      const run = (hz: number, seconds: number): { exposure: number; sky: number } => {
        now += 1000 / hz;
        app.tick();
        app.exposureState = 10;
        app.skyVisibility = 0;
        for (let k = 0; k < Math.round(seconds * hz); k++) {
          now += 1000 / hz;
          app.tick();
        }
        return { exposure: app.exposureState, sky: app.skyVisibility };
      };
      return { target, hz30: run(30, 0.5), hz60: run(60, 0.5), hz120: run(120, 0.5) };
    } finally {
      app.paused = false;
      performance.now = realNow;
    }
  });
  for (const k of ['hz30', 'hz120'] as const) {
    expect(r[k].exposure / r.hz60.exposure, k).toBeCloseTo(1, 6);
    expect(r[k].sky / r.hz60.sky, k).toBeCloseTo(1, 6);
  }
  // Exposure: tau = 0.6 s. Sky visibility: tau = 0.16 s (the former 10% per frame at 60 fps).
  expect((r.hz60.exposure - r.target.exposure) / (10 - r.target.exposure)).toBeCloseTo(Math.exp(-0.5 / 0.6), 4);
  expect(r.target.sky).toBeGreaterThan(0.3);
  expect(r.hz60.sky / r.target.sky).toBeCloseTo(1 - Math.exp(-0.5 / 0.16), 4);
  expect(errors).toEqual([]);
});

test('free camera mode draws no cockpit', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors, 'free=1&msaa=0&bloom=0');
  const r = await page.evaluate(() => {
    const app = (window as unknown as { __ks: Any }).__ks.app;
    return { cockpit: app.cockpit !== null, enabled: app.frame.cockpitEnabled, bodyClass: document.body.classList.contains('ks-cockpit-on') };
  });
  expect(r).toEqual({ cockpit: false, enabled: false, bodyClass: false });
  expect(errors).toEqual([]);
});

test('bodies load in catalogue order with their spheres of influence', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  const r = await page.evaluate(async () => {
    const app = (window as unknown as { __ks: Any }).__ks.app;
    const json = (await (await fetch('data/bodies.json')).json()) as { bodies: { id: string }[] };
    const moon = app.sys.byId.get('301');
    const earth = app.sys.byId.get('399');
    const a = app.sys.ephemeris.between('301', '399', 0, moon.rel.clone()).length();
    return {
      want: json.bodies.map((b) => b.id),
      got: app.sys.views.map((v: Any) => v.def.id as string),
      byId: [...app.sys.byId.keys()],
      moonSoi: moon.soi as number,
      moonSoiWant: Math.max(3 * moon.def.radiusM, a * Math.pow(moon.def.gmM3S2 / earth.def.gmM3S2, 0.4)),
      sunSoiInfinite: app.sys.byId.get('10').soi === Infinity,
    };
  });
  expect(r.got).toEqual(r.want);
  expect(r.byId).toEqual(r.want);
  // Laplace sphere of influence, computed after every body is in: the Moon's is ~6.6e7 m.
  expect(r.moonSoi).toBe(r.moonSoiWant);
  expect(r.sunSoiInfinite).toBe(true);
  expect(errors).toEqual([]);
});
