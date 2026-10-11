/**
 * TRAPPIST-1 data lab (exo.html): the system file loads and validates in a real browser, every value shown carries a
 * provenance mark that does not rely on colour, screen readers hear each value's provenance, orbit positions follow
 * the transit ephemeris (planet b sits on the line of sight to the Sun at its transit epoch), the generated surface
 * preview renders without blocking the page, and the layout holds at tablet and phone widths.
 */
import { test, expect, type Page } from '@playwright/test';

interface Dot {
  letter: string;
  x: number;
  y: number;
}
interface ExoHooks {
  system: {
    planets: { letter: string; name: string; inferred: { ephemerisTransitMidBJD: { value: number }; ephemerisPeriodDays: { value: number } } }[];
    exoplanetCount: { value: number; asOf: string };
  };
  select(i: number): void;
  setTime(t: number): void;
  pause(): void;
  dots(): Dot[];
  selected(): number;
  previewReady(): Promise<void>;
  previewMs(): number;
  maxPreviewSliceMs(): number;
  cachedPreviews(): number[];
  orbitDraws(): number;
}

const PROV_LABEL = { measured: 'Measured', inferred: 'Inferred', generated: 'Generated' } as const;
type Prov = keyof typeof PROV_LABEL;

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

  test('marks every table column with its provenance, in shape and text, not colour alone', async ({ page }) => {
    const errors: string[] = [];
    await open(page, errors);
    const table = page.locator('.ptable');
    // One group header per tier, each a badge with a shape mark and the tier's name.
    const groups = table.locator('thead th[scope="colgroup"]');
    await expect(groups).toHaveCount(3);
    for (const p of Object.keys(PROV_LABEL) as Prov[]) {
      const g = table.locator(`th#pt-g-${p}`);
      await expect(g.locator(`.exo-prov[data-prov="${p}"] .exo-prov-mark`)).toHaveCount(1);
      await expect(g).toHaveText(PROV_LABEL[p]);
    }
    // Every value column header names its tier for assistive technology, and every value cell points at it.
    const cols = table.locator('thead th[scope="col"][data-prov]');
    await expect(cols).toHaveCount(6);
    const colInfo = await cols.evaluateAll((ths) => ths.map((th) => ({ id: th.id, prov: th.getAttribute('data-prov') })));
    for (const c of colInfo) {
      const prov = c.prov as Prov;
      await expect(table.locator(`th#${c.id}`)).toHaveAccessibleName(new RegExp(`${PROV_LABEL[prov]}$`));
    }
    await expect(table.getByRole('columnheader', { name: /Mean period.*Inferred/ })).toHaveCount(1);
    await expect(table.getByRole('columnheader', { name: /T eq \(A.=.0\).*Inferred/ })).toHaveCount(1);
    await expect(table.getByRole('columnheader', { name: /Surface.*Generated/ })).toHaveCount(1);
    const cells = await table.locator('tbody td').evaluateAll((tds) =>
      tds.map((td) => ({ prov: td.getAttribute('data-prov'), headers: (td.getAttribute('headers') ?? '').split(' ') })),
    );
    expect(cells).toHaveLength(7 * 6);
    for (const c of cells) {
      expect(c.prov).toMatch(/^(measured|inferred|generated)$/);
      expect(c.headers).toContain(`pt-g-${c.prov}`);
      expect(colInfo.some((h) => c.headers.includes(h.id) && h.prov === c.prov)).toBe(true);
    }
    // Planets are chosen with real buttons; the selected one is exposed as current.
    await expect(table.getByRole('button', { name: 'TRAPPIST-1 b' })).toHaveAttribute('aria-current', 'true');
    await table.getByRole('button', { name: 'TRAPPIST-1 e' }).click();
    await expect(page.locator('.planet-card h3')).toHaveText('TRAPPIST-1 e');
    await expect(table.getByRole('button', { name: 'TRAPPIST-1 e' })).toHaveAttribute('aria-current', 'true');
    await expect(table.getByRole('button', { name: 'TRAPPIST-1 b' })).not.toHaveAttribute('aria-current', 'true');
    expect(errors).toEqual([]);
  });

  test('gives screen readers the provenance of every value and announces the detail panel', async ({ page }) => {
    const errors: string[] = [];
    await open(page, errors);
    const vrows = page.locator('.vrow');
    const n = await vrows.count();
    for (let i = 0; i < n; i++) {
      const row = vrows.nth(i);
      const prov = (await row.getAttribute('data-prov')) as Prov;
      await expect(row).toHaveAccessibleName(new RegExp(` ${PROV_LABEL[prov]}$`));
    }
    await expect(page.getByRole('button', { name: /^Orbital plane orientation 0° Generated$/ })).toHaveCount(1);
    await expect(page.locator('.detail')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('.vrow[aria-current="true"]')).toHaveCount(1);
    const orbit = page.locator('canvas.orbits');
    await expect(orbit).toHaveAttribute('role', 'img');
    await expect(orbit).toHaveAccessibleName(/Selected: TRAPPIST-1 b/);
    expect(errors).toEqual([]);
  });

  test('formats uncertainties with units, in the same order as the value rows', async ({ page }) => {
    const errors: string[] = [];
    await open(page, errors);
    const detail = page.locator('.detail');
    const uncertainty = detail.locator('dd').first();
    await page.locator('.sec-measured .vrow', { hasText: 'Radius' }).click();
    await expect(uncertainty).toHaveText('+0.014 / −0.012 R⊕');
    await page.locator('.vrow', { hasText: 'Luminosity' }).click();
    await expect(detail.locator('.detail-value')).toHaveText('(5.53 ± 0.19) × 10⁻⁴ L☉');
    await expect(uncertainty).toHaveText('± 0.19 × 10⁻⁴ L☉');
    await page.locator('.vrow', { hasText: 'Right ascension' }).click();
    await expect(uncertainty).toHaveText(/^± 3\.0 × 10⁻⁸°$/);
    await page.locator('.vrow', { hasText: 'Distance' }).click();
    await expect(uncertainty).toHaveText('± 0.019 pc');
    await page.locator('.vrow', { hasText: 'Reference transit' }).click();
    await expect(uncertainty).toHaveText(/^\+0\.\d+ \/ −0\.\d+ days$|^± 0\.\d+ days$/);
    await expect(page.locator('.clock')).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2} UTC$/);
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

  test('does not redraw the orbits while paused', async ({ page }) => {
    const errors: string[] = [];
    await open(page, errors);
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => (window as unknown as { __ksExo: ExoHooks }).__ksExo.orbitDraws());
    await page.waitForTimeout(1000);
    const after = await page.evaluate(() => (window as unknown as { __ksExo: ExoHooks }).__ksExo.orbitDraws());
    expect(after).toBe(before);
    // Playing redraws every frame.
    await page.locator('.controls .chip-btn').first().click();
    await page.waitForTimeout(500);
    const playing = await page.evaluate(() => (window as unknown as { __ksExo: ExoHooks }).__ksExo.orbitDraws());
    expect(playing).toBeGreaterThan(after);
    expect(errors).toEqual([]);
  });

  test('renders a generated surface preview for every planet without blocking the page', async ({ page }, info) => {
    const errors: string[] = [];
    await open(page, errors);
    for (let i = 0; i < 7; i++) {
      const stats = await page.evaluate(async (idx) => {
        const ks = (window as unknown as { __ksExo: ExoHooks }).__ksExo;
        const t0 = performance.now();
        ks.select(idx);
        const selectMs = performance.now() - t0;
        await ks.previewReady();
        const cv = document.querySelector<HTMLCanvasElement>('canvas.preview')!;
        const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
        let opaque = 0;
        let lit = 0;
        for (let p = 0; p < d.length; p += 4) {
          if (d[p + 3]! > 200) opaque++;
          if (d[p]! + d[p + 1]! + d[p + 2]! > 60) lit++;
        }
        return { opaque: opaque / (d.length / 4), lit: lit / (d.length / 4), selected: ks.selected(), selectMs, previewMs: ks.previewMs() };
      }, i);
      expect(stats.selected).toBe(i);
      // A disc fills pi/4 of the square; part of it is in daylight.
      expect(stats.opaque).toBeGreaterThan(0.7);
      expect(stats.opaque).toBeLessThan(0.8);
      expect(stats.lit).toBeGreaterThan(0.2);
      expect(stats.previewMs).toBeGreaterThan(0);
      // Selecting re-renders the card but leaves the preview to short slices.
      expect(stats.selectMs).toBeLessThan(250);
    }
    // Slices aim at 8 ms; the bound leaves room for a busy CI machine but catches a return to one 400-900 ms block.
    const slice = await page.evaluate(() => (window as unknown as { __ksExo: ExoHooks }).__ksExo.maxPreviewSliceMs());
    expect(slice).toBeLessThan(200);
    // Previews are cached: going back to b is immediate.
    const cached = await page.evaluate(() => {
      const ks = (window as unknown as { __ksExo: ExoHooks }).__ksExo;
      ks.select(0);
      return ks.cachedPreviews();
    });
    expect(cached).toEqual([0, 1, 2, 3, 4, 5, 6]);
    await expect(page.locator('.planet-card h3')).toHaveText('TRAPPIST-1 b');
    await page.screenshot({ path: info.outputPath('exo-lab.png'), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('keeps the detail in view and every label readable on tablets and phones', async ({ browser }) => {
    // 1024 px: the detail panel sits below the card, so a click brings it into view.
    const tablet = await browser.newContext({ viewport: { width: 1024, height: 700 }, reducedMotion: 'reduce' });
    const page = await tablet.newPage();
    await page.goto('/exo.html');
    await page.waitForFunction(() => (window as unknown as { __ksExo?: unknown }).__ksExo !== undefined, null, { timeout: 60_000 });
    const wrapOverflow = await page.locator('.table-wrap').evaluate((w) => w.scrollWidth - w.clientWidth);
    expect(wrapOverflow).toBeLessThanOrEqual(1);
    await page.locator('.sec-inferred .vrow').nth(2).click();
    const box = await page.locator('.how').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(701);
    await tablet.close();

    // 375 px: no value label is cut off; the table scrolls sideways with the planet column pinned.
    const phone = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const p2 = await phone.newPage();
    await p2.goto('/exo.html');
    await p2.waitForFunction(() => (window as unknown as { __ksExo?: unknown }).__ksExo !== undefined, null, { timeout: 60_000 });
    const truncated = await p2.locator('.vrow .k, .vrow .v').evaluateAll((ns) => ns.filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent));
    expect(truncated).toEqual([]);
    const pageOverflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(pageOverflow).toBeLessThanOrEqual(0);
    await expect(p2.locator('.table-scroll')).toHaveClass(/more/);
    await expect(p2.locator('.ptable tbody th.pl').first()).toHaveCSS('position', 'sticky');
    await phone.close();
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
