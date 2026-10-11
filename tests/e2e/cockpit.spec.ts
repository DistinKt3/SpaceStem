/**
 * Cockpit demo on both backends: boots without console errors, stays within the cockpit budget (<= 40 draw calls,
 * <= 60k triangles, measured by rendering the same frame with and without the cockpit pass), produces a non-black
 * in-page capture, shows the displays in the accent colour after tone mapping, keeps their brightness when the
 * renderer exposure changes (bindExposure), and the displays respond to CockpitState (an alert turns the instrument
 * cluster warm and pulses, except under reduced motion).
 */
import { test, expect, type Page } from '@playwright/test';

interface Stats {
  backend: string;
  cockpitDrawCalls: number;
  cockpitTriangles: number;
  cockpitStatic: { drawCalls: number; triangles: number };
}

interface CockpitKs {
  info: { backend: string };
  preset(name: string): void;
  set(patch: Record<string, unknown>): void;
  stats(): Stats;
  capture(type?: string): string;
  relocalize(code: string, messages: Record<string, string>): void;
}

interface Region {
  /** Fraction of pixels brighter than near-black. */
  lit: number;
  r: number;
  g: number;
  b: number;
  /** Median hue (0..1), saturation and value (HSV) of the bright pixels (value > 0.75), and how many there are. */
  brightHue: number;
  brightSat: number;
  brightVal: number;
  brightCount: number;
}

async function open(page: Page, backend: string, errors: string[]): Promise<void> {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/cockpit.html?backend=${backend}&ui=0&loop=0`);
  await page.waitForFunction(() => (window as unknown as { __ks?: unknown }).__ks !== undefined, null, { timeout: 180_000 });
}

/** Capture a frame in-page and measure the whole image and a sub-rectangle (fractions of width/height). */
async function measure(page: Page, rect: [number, number, number, number]): Promise<{ all: Region; part: Region }> {
  return page.evaluate(async (rect) => {
    const ks = (window as unknown as { __ks: CockpitKs }).__ks;
    const url = ks.capture('image/png');
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const stat = (x0: number, y0: number, x1: number, y1: number): Region => {
      const w = Math.max(1, Math.round((x1 - x0) * c.width));
      const h = Math.max(1, Math.round((y1 - y0) * c.height));
      const d = ctx.getImageData(Math.round(x0 * c.width), Math.round(y0 * c.height), w, h).data;
      let lit = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      const hues: number[] = [];
      const sats: number[] = [];
      const vals: number[] = [];
      for (let i = 0; i < d.length; i += 4) {
        const pr = d[i]!;
        const pg = d[i + 1]!;
        const pb = d[i + 2]!;
        if (pr + pg + pb > 30) lit++;
        r += pr;
        g += pg;
        b += pb;
        const max = Math.max(pr, pg, pb);
        const min = Math.min(pr, pg, pb);
        if (max > 0.75 * 255) {
          const dd = max - min;
          let h = 0;
          if (dd > 0) h = max === pr ? ((pg - pb) / dd + 6) % 6 : max === pg ? (pb - pr) / dd + 2 : (pr - pg) / dd + 4;
          hues.push(h / 6);
          sats.push(dd / max);
          vals.push(max / 255);
        }
      }
      const median = (a: number[]): number => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)]! : 0);
      const n = d.length / 4;
      return { lit: lit / n, r: r / n, g: g / n, b: b / n, brightHue: median(hues), brightSat: median(sats), brightVal: median(vals), brightCount: hues.length };
    };
    return { all: stat(0, 0, 1, 1), part: stat(rect[0], rect[1], rect[2], rect[3]) };
  }, rect);
}

/** The display cluster under the forward view (attitude, mode and status screens). */
const CLUSTER: [number, number, number, number] = [0.27, 0.82, 0.73, 1.0];
/** The throttle pane (left holographic pane). */
const THROTTLE_DIGITS: [number, number, number, number] = [0.21, 0.64, 0.34, 0.8];

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`cockpit renders within budget and responds to state: ${backend}`, async ({ page }) => {
    const errors: string[] = [];
    await open(page, backend, errors);
    const backendUsed = await page.evaluate(() => (window as unknown as { __ks: CockpitKs }).__ks.info.backend);
    expect(backendUsed).toBe(backend);

    await page.evaluate(() => {
      const ks = (window as unknown as { __ks: CockpitKs }).__ks;
      ks.preset('ahead');
      ks.set({ time: 2, reducedMotion: true });
    });
    const stats = await page.evaluate(() => (window as unknown as { __ks: CockpitKs }).__ks.stats());
    expect(stats.cockpitDrawCalls).toBeGreaterThan(5);
    expect(stats.cockpitDrawCalls).toBeLessThanOrEqual(40);
    expect(stats.cockpitTriangles).toBeLessThanOrEqual(60_000);
    expect(stats.cockpitDrawCalls).toBe(stats.cockpitStatic.drawCalls);

    const calm = await measure(page, CLUSTER);
    expect(calm.all.lit, 'capture is not black').toBeGreaterThan(0.25);
    // Calm displays are cyan: blue clearly above red.
    expect(calm.part.b).toBeGreaterThan(calm.part.r + 8);
    // ...and after AgX tone mapping their bright lines keep the accent #7fd4ff (hue 0.556, saturation 0.50), not the
    // washed-out steel blue plain linear emission gives (saturation ~0.3).
    expect(calm.part.brightCount, 'bright display pixels').toBeGreaterThan(50);
    expect(Math.abs(calm.part.brightHue - 0.556), `hue ${calm.part.brightHue}`).toBeLessThan(0.025);
    expect(calm.part.brightSat, `saturation ${calm.part.brightSat}`).toBeGreaterThan(0.4);

    // The instruments ignore the renderer exposure (the cockpit is bound to FrameRenderer.exposure). Measured over
    // a black backdrop, so only the cockpit pass contributes (the world rightly brightens with exposure).
    await page.evaluate(() => (window as unknown as { __ks: CockpitKs }).__ks.set({ backdropOn: false, exposure: 1 }));
    const lum = (x: Region): number => x.r + x.g + x.b;
    const ref = await measure(page, CLUSTER);
    for (const exposure of [0.02, 40]) {
      await page.evaluate((exposure) => (window as unknown as { __ks: CockpitKs }).__ks.set({ exposure }), exposure);
      const m = await measure(page, CLUSTER);
      expect(Math.abs(lum(m.part) / lum(ref.part) - 1), `cluster brightness at exposure ${exposure}`).toBeLessThan(0.05);
    }
    await page.evaluate(() => (window as unknown as { __ks: CockpitKs }).__ks.set({ backdropOn: true, exposure: 1 }));

    await page.evaluate(() => (window as unknown as { __ks: CockpitKs }).__ks.set({ alert: 1 }));
    const alarm = await measure(page, CLUSTER);
    // Alert pulls the instrument colour to amber/red.
    expect(alarm.part.r).toBeGreaterThan(alarm.part.b + 8);
    expect(alarm.part.r).toBeGreaterThan(calm.part.r + 8);

    // Reduced motion: the alert holds a steady colour (two different times render the same cluster)...
    await page.evaluate(() => (window as unknown as { __ks: CockpitKs }).__ks.set({ alert: 0.9, reducedMotion: true, time: 1.0 }));
    const still1 = await measure(page, CLUSTER);
    await page.evaluate(() => (window as unknown as { __ks: CockpitKs }).__ks.set({ time: 1.45 }));
    const still2 = await measure(page, CLUSTER);
    expect(Math.abs(still1.part.r - still2.part.r)).toBeLessThan(0.5);
    // ...while with motion allowed the alert pulses.
    await page.evaluate(() => (window as unknown as { __ks: CockpitKs }).__ks.set({ reducedMotion: false, time: 1.0 }));
    const pulse1 = await measure(page, CLUSTER);
    await page.evaluate(() => (window as unknown as { __ks: CockpitKs }).__ks.set({ time: 1.45 }));
    const pulse2 = await measure(page, CLUSTER);
    expect(Math.abs(pulse1.part.r - pulse2.part.r)).toBeGreaterThan(2);

    // A locale change redraws the displays: a pattern with the unit before the number moves the percent sign.
    await page.evaluate(() => (window as unknown as { __ks: CockpitKs }).__ks.set({ alert: 0, time: 2, reducedMotion: true }));
    const before = await measure(page, THROTTLE_DIGITS);
    await page.evaluate(() => (window as unknown as { __ks: CockpitKs }).__ks.relocalize('xx', { 'cockpit.percent': '%\u00a0{value}', 'cockpit.throttle': 'Gas' }));
    const after = await measure(page, THROTTLE_DIGITS);
    expect(Math.abs(after.part.b - before.part.b) + Math.abs(after.part.g - before.part.g), 'readout changed').toBeGreaterThan(1);

    expect(errors).toEqual([]);
  });
}
