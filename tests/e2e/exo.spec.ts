/**
 * TRAPPIST-1 data lab (exo.html): the system file loads and validates in a real browser, every value shown carries a
 * provenance mark and a resolvable reference, orbit positions follow the transit ephemeris (planet b sits on the line
 * of sight to the Sun at its transit epoch), and the generated surface preview renders.
 */
import { test, expect, type Page } from '@playwright/test';

interface Dot {
  letter: string;
  x: number;
  y: number;
}
interface ExoHooks {
  system: {
    planets: { letter: string; inferred: { ephemerisTransitMidBJD: { value: number }; ephemerisPeriodDays: { value: number } } }[];
    exoplanetCount: { value: number; asOf: string };
  };
  select(i: number): void;
  setTime(t: number): void;
  pause(): void;
  dots(): Dot[];
  selected(): number;
  previewMs(): number;
}

async function open(page: Page, errors: string[]): Promise<void> {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/exo.html');
  await page.waitForFunction(() => (window as unknown as { __ksExo?: unknown }).__ksExo !== undefined, null, { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as { __ksExo: ExoHooks }).__ksExo.pause());
}

test.describe('TRAPPIST-1 data lab', () => {
  test('loads the system with provenance on every value', async ({ page }) => {
    const errors: string[] = [];
    await open(page, errors);
    await expect(page.locator('h1')).toHaveText('TRAPPIST-1');
    await expect(page.locator('.ptable tbody tr')).toHaveCount(7);
    const count = await page.evaluate(() => (window as unknown as { __ksExo: ExoHooks }).__ksExo.system.exoplanetCount);
    expect(count.value).toBeGreaterThan(5000);
    await expect(page.locator('.pill.on')).toContainText(count.asOf);

    // Planet card: 4 generated, 7 measured and 11 inferred rows, each with its own mark.
    const card = page.locator('.planet-card');
    await expect(card.locator('h3')).toHaveText('TRAPPIST-1 b');
    await expect(card.locator('.sec-measured .vrow .dot-measured')).toHaveCount(7);
    await expect(card.locator('.sec-inferred .vrow .dot-inferred')).toHaveCount(11);
    await expect(card.locator('.sec-generated .vrow .dot-generated')).toHaveCount(4);
    // Every value row anywhere on the page has exactly one provenance mark.
    const rows = await page.locator('.vrow').count();
    const marked = await page.locator('.vrow .dot').count();
    expect(rows).toBeGreaterThan(30);
    expect(marked).toBe(rows);

    // "How do we know this?": an inferred value shows its source, a DOI link and the formula note.
    await card.locator('.sec-inferred .vrow').first().click();
    const detail = page.locator('.detail');
    await expect(detail.locator('[data-prov="inferred"]')).toBeVisible();
    await expect(detail).toContainText('Teq = Teff');
    await expect(detail.locator('a[href^="https://doi.org/10."]')).toHaveCount(1);

    // The generated rows explain their rule-based origin.
    await card.locator('.sec-generated .vrow').first().click();
    await expect(detail.locator('[data-prov="generated"]')).toBeVisible();
    await expect(detail).toContainText('runaway-greenhouse');
    expect(errors).toEqual([]);
  });

  test('places planet b on the line of sight at its transit epoch', async ({ page }) => {
    const errors: string[] = [];
    await open(page, errors);
    const res = await page.evaluate(() => {
      const ks = (window as unknown as { __ksExo: ExoHooks }).__ksExo;
      const bjd = ks.system.planets[0]!.inferred.ephemerisTransitMidBJD.value;
      ks.setTime((bjd - 2451545) * 86400);
      const c = document.querySelector('canvas.orbits')!.getBoundingClientRect();
      return { dots: ks.dots(), cx: c.width / 2, cy: c.height / 2 };
    });
    const b = res.dots.find((d) => d.letter === 'b')!;
    expect(b.x).toBeGreaterThan(res.cx + 5);
    expect(Math.abs(b.y - res.cy)).toBeLessThan(1);
    // A quarter period later it has moved a quarter turn counter-clockwise (up on screen).
    const later = await page.evaluate(() => {
      const ks = (window as unknown as { __ksExo: ExoHooks }).__ksExo;
      const eph = ks.system.planets[0]!.inferred;
      const bjd = eph.ephemerisTransitMidBJD.value;
      ks.setTime((bjd - 2451545) * 86400 + eph.ephemerisPeriodDays.value * 86400 * 0.25);
      return ks.dots().find((d) => d.letter === 'b')!;
    });
    expect(Math.abs(later.x - res.cx)).toBeLessThan(1);
    expect(later.y).toBeLessThan(res.cy - 5);
    expect(errors).toEqual([]);
  });

  test('renders a generated surface preview for every planet', async ({ page }, info) => {
    const errors: string[] = [];
    await open(page, errors);
    for (let i = 0; i < 7; i++) {
      const stats = await page.evaluate((idx) => {
        const ks = (window as unknown as { __ksExo: ExoHooks }).__ksExo;
        ks.select(idx);
        const cv = document.querySelector<HTMLCanvasElement>('canvas.preview')!;
        const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
        let opaque = 0;
        let lit = 0;
        for (let p = 0; p < d.length; p += 4) {
          if (d[p + 3]! > 200) opaque++;
          if (d[p]! + d[p + 1]! + d[p + 2]! > 60) lit++;
        }
        return { opaque: opaque / (d.length / 4), lit: lit / (d.length / 4), selected: ks.selected() };
      }, i);
      expect(stats.selected).toBe(i);
      // A disc fills pi/4 of the square; part of it is in daylight.
      expect(stats.opaque).toBeGreaterThan(0.7);
      expect(stats.opaque).toBeLessThan(0.8);
      expect(stats.lit).toBeGreaterThan(0.2);
    }
    await expect(page.locator('.planet-card h3')).toHaveText('TRAPPIST-1 h');
    await page.screenshot({ path: info.outputPath('exo-lab.png'), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('starts paused under reduced motion', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 800, height: 450 } });
    const page = await context.newPage();
    await page.goto('/exo.html');
    await page.waitForFunction(() => (window as unknown as { __ksExo?: unknown }).__ksExo !== undefined, null, { timeout: 60_000 });
    await expect(page.locator('.controls .chip-btn').first()).toHaveAttribute('aria-pressed', 'false');
    await context.close();
  });
});
