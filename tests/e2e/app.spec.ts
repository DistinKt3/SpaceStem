/**
 * Game smoke tests (index.html): boot without errors, named views render lit pixels, the map lists destinations and
 * sets the target, and a hyperspeed jump to Proxima Centauri arrives at the star and lights it as a body.
 */
import { test, expect, type Page } from '@playwright/test';

interface Vec {
  x: number;
  y: number;
  z: number;
  length(): number;
}
interface KsApp {
  sys: { byId: Map<string, unknown>; views: { def: { id: string } }[] };
  catalog: { destinations(p: Vec, maxPc: number, limit: number): number[]; name(i: number): string } | null;
  map: { open(mode?: string): void; close(): void; isOpen: boolean; selectedId: string | null } | null;
  controller: {
    targetId: string | null;
    engageHyperspeed(): void;
    update(dt: number, app: KsApp): void;
    hyper: { phase: string };
    ship: { pos: { anchor: string; offset: Vec } };
  };
}
interface KS {
  app: KsApp;
  setView(name: string): void;
  capture(): string;
  pending(): number;
  stats(): Record<string, unknown>;
}

async function boot(page: Page, errors: string[]): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // The dev server has no favicon; everything else logged as an error is a failure.
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
  });
  await page.goto('/?msaa=0&bloom=0');
  await page.waitForFunction(() => (window as unknown as { __ks?: unknown }).__ks !== undefined, null, { timeout: 180_000 });
}

/** Mean luminance (0-255) of a captured frame, and the fraction of pixels brighter than 40. */
async function frameBrightness(page: Page): Promise<{ mean: number; lit: number }> {
  return page.evaluate(async () => {
    const ks = (window as unknown as { __ks: KS }).__ks;
    const url = ks.capture();
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 90;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
      sum += y;
      if (y > 40) lit++;
    }
    const n = d.length / 4;
    return { mean: sum / n, lit: lit / n };
  });
}

test('boots, shows the HUD and renders lit views', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  await expect(page.locator('.ks-hud-left')).toContainText('Earth');
  await expect(page.locator('.ks-hud-footer')).toContainText('UTC');
  for (const view of ['leo', 'moon-orbit', 'saturn']) {
    await page.evaluate((v) => (window as unknown as { __ks: KS }).__ks.setView(v), view);
    await page.waitForFunction(() => (window as unknown as { __ks: KS }).__ks.pending() === 0, null, { timeout: 120_000 });
    const b = await frameBrightness(page);
    expect(b.lit, `${view} has a lit body in frame`).toBeGreaterThan(0.002);
  }
  expect(errors).toEqual([]);
});

test('the catalogue starfield renders (regression: mirrored sprite quads were back-face culled)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Milky Way off and no cockpit, so only catalogue stars can light the sky.
  await page.goto('/?msaa=0&bloom=0&cockpit=0&mwGain=0');
  await page.waitForFunction(() => (window as unknown as { __ks?: unknown }).__ks !== undefined, null, { timeout: 180_000 });
  await page.evaluate(() => {
    const ks = (window as unknown as { __ks: KS }).__ks;
    // Deep space, far from any planet.
    ks.app.controller.ship.pos.offset.x = 3e12;
    ks.app.controller.ship.pos.offset.y = 1e12;
  });
  await page.waitForTimeout(1500);
  // Count lit pixels at full resolution (stars are 1-3 px; a downsample would average them away).
  const lit = await page.evaluate(async () => {
    const ks = (window as unknown as { __ks: KS }).__ks;
    const img = new Image();
    img.src = ks.capture();
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]! > 30) n++;
    return n;
  });
  // A broken starfield leaves this sky black (0); a working one shows hundreds of stars.
  expect(lit).toBeGreaterThan(200);
  expect(errors).toEqual([]);
});

test('map lists destinations and sets the target', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  await page.locator('canvas').click();
  await page.keyboard.press('KeyM');
  await expect(page.locator('.ks-map')).toBeVisible();
  await expect(page.locator('.ks-hud')).toBeHidden();
  await page.locator('.ks-map-entry', { hasText: 'Jupiter' }).click();
  expect(await page.evaluate(() => (window as unknown as { __ks: KS }).__ks.app.controller.targetId)).toBe('599');
  await page.locator('.ks-map-mode').click();
  await expect(page.locator('.ks-map-entry', { hasText: 'Proxima Centauri' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ks-map')).toBeHidden();
  await expect(page.locator('.ks-hud')).toBeVisible();
  expect(errors).toEqual([]);
});

test('hyperspeed to Proxima Centauri arrives and lights the star', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  const result = await page.evaluate(() => {
    const ks = (window as unknown as { __ks: KS }).__ks;
    const app = ks.app;
    const cat = app.catalog!;
    const here = { x: 0, y: 0, z: 0, length: () => 0 };
    const idx = cat.destinations(here, 2, 20).find((i) => cat.name(i) === 'Proxima Centauri');
    if (idx === undefined) throw new Error('Proxima Centauri not in catalogue');
    const c = app.controller;
    // Hyperspeed refuses to engage deep in a gravity well: start 2 million km from Earth.
    c.ship.pos.offset.x = 2e9;
    c.ship.pos.offset.y = 0;
    c.ship.pos.offset.z = 0;
    c.targetId = `*${idx}`;
    c.engageHyperspeed();
    const started = c.hyper.phase;
    // Step the simulation in 0.5 s increments (spool 3 s + transit ~24 s).
    for (let k = 0; k < 80 && c.hyper.phase !== 'idle'; k++) c.update(0.5, app);
    return { started, phase: c.hyper.phase, anchor: c.ship.pos.anchor, target: `*${idx}`, distM: c.ship.pos.offset.length() };
  });
  expect(result.started).toBe('spool');
  expect(result.phase).toBe('idle');
  expect(result.anchor).toBe(result.target);
  // Arrival distance: outside the star (R ~ 0.15 R_sun), inside 1 au for this dim M dwarf.
  expect(result.distM).toBeGreaterThan(1e8);
  expect(result.distM).toBeLessThan(1.5e11);
  // onArrive registers the star as a lit body.
  await page.waitForFunction((id) => (window as unknown as { __ks: KS }).__ks.app.sys.byId.has(id), result.target, { timeout: 60_000 });
  const b = await frameBrightness(page);
  expect(b.lit).toBeGreaterThan(0.001);
  expect(errors).toEqual([]);
});
