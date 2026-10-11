/**
 * Cockpit demo on both backends: boots without console errors, stays within the cockpit budget (<= 40 draw calls,
 * <= 60k triangles, measured by rendering the same frame with and without the cockpit pass), produces a non-black
 * in-page capture, and the displays respond to CockpitState (an alert turns the instrument cluster warm and pulses,
 * except under reduced motion).
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
}

interface Region {
  /** Fraction of pixels brighter than near-black. */
  lit: number;
  r: number;
  g: number;
  b: number;
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
      for (let i = 0; i < d.length; i += 4) {
        if (d[i]! + d[i + 1]! + d[i + 2]! > 30) lit++;
        r += d[i]!;
        g += d[i + 1]!;
        b += d[i + 2]!;
      }
      const n = d.length / 4;
      return { lit: lit / n, r: r / n, g: g / n, b: b / n };
    };
    return { all: stat(0, 0, 1, 1), part: stat(rect[0], rect[1], rect[2], rect[3]) };
  }, rect);
}

/** The display cluster under the forward view (attitude, mode and status screens). */
const CLUSTER: [number, number, number, number] = [0.27, 0.82, 0.73, 1.0];

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

    expect(errors).toEqual([]);
  });
}
