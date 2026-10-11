/**
 * Fuel lab (fuel.html): the hyper-fuel model and its HUD gauge, DOM only (no WebGPU canvas, so page screenshots
 * work). The page starts paused (paused=1) and tests advance game time through window.__ksFuel.advance(), so every
 * state below is deterministic. Screenshots go to test-results/fuel-shots/ for visual review.
 */
import { test, expect, type Page } from '@playwright/test';

const SHOTS = 'test-results/fuel-shots';

interface Hooks {
  advance(seconds: number): string[];
  events(): string[];
  fuel: { hyperFuel: number; heat: number; heatState: string; scooping: boolean };
  state: { radii: number; star: number };
}

async function open(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`/fuel.html?paused=1&${query}`);
  await page.waitForFunction(() => (window as unknown as { __ksFuel?: unknown }).__ksFuel !== undefined);
  return errors;
}

const advance = (page: Page, s: number): Promise<string[]> =>
  page.evaluate((secs) => (window as unknown as { __ksFuel: Hooks }).__ksFuel.advance(secs), s);
const snapshot = (page: Page): Promise<{ hyperFuel: number; radii: number; events: string[] }> =>
  page.evaluate(() => {
    const h = (window as unknown as { __ksFuel: Hooks }).__ksFuel;
    return { hyperFuel: h.fuel.hyperFuel, radii: h.state.radii, events: h.events() };
  });

const gauge = (page: Page) => page.locator('section.ks-fuel');
const live = (page: Page) => gauge(page).locator('[role="status"][aria-live="polite"]');
/** Slider value for a distance in stellar radii (the page maps 1.05..100 radii logarithmically onto 0..1000). */
const radiiSlider = (r: number): string => String(Math.round((1000 * Math.log10(r / 1.05)) / Math.log10(100 / 1.05)));

test.describe('fuel lab', () => {
  test('loads cleanly, labels the mechanic as fiction and exposes accessible meters', async ({ page }) => {
    const errors = await open(page, 'r=3&fuel=0.35&jump=4.37');
    const g = page.getByRole('region', { name: 'Hyper-fuel and hull heat (game mechanic)' });
    await expect(g).toBeVisible();
    await expect(g).toContainText('Game mechanic');
    await expect(page.locator('.pill')).toHaveText('Fiction: game mechanic');
    const fuelMeter = page.getByRole('meter', { name: 'Hyper-fuel' });
    await expect(fuelMeter).toHaveAttribute('aria-valuenow', '35');
    await expect(fuelMeter).toHaveAttribute('aria-valuetext', '35% of the tank; the next jump uses 16%');
    await expect(page.getByRole('meter', { name: 'Hull heat' })).toHaveAttribute('aria-valuetext', '0% of the hull limit, Normal');
    await expect(gauge(page)).toHaveAttribute('data-scooping', 'false');
    await expect(gauge(page).locator('.ks-fuel-scoop')).toBeHidden();
    // Real stars, cited.
    await expect(page.locator('.sources')).toContainText('Kervella et al. 2017');
    await expect(page.locator('.sources')).toContainText('Kopp & Lean 2011');
    await page.screenshot({ path: `${SHOTS}/start.png`, fullPage: true });
    expect(errors).toEqual([]);
  });

  test('scoops inside the band, warns on heat and climbs out at the hull limit', async ({ page }) => {
    const errors = await open(page, 'r=12&fuel=0.3&jump=none');
    // Outside the band (Sun at 12 radii): nothing happens.
    await advance(page, 2);
    await expect(page.locator('[data-ro="band"]')).toHaveAttribute('data-band', 'out');
    await expect(gauge(page)).toHaveAttribute('data-scooping', 'false');

    // Drive the distance slider into the band (3 radii): scooping starts and is announced once.
    await page.locator('#distance').fill(radiiSlider(3));
    await expect(page.locator('output[for="distance"]')).toHaveText(/^(2\.99|3\.00) stellar radii$/);
    await expect(page.locator('[data-ro="band"]')).toHaveAttribute('data-band', 'in');
    await advance(page, 2);
    await expect(gauge(page)).toHaveAttribute('data-scooping', 'true');
    await expect(gauge(page).locator('.ks-fuel-scoop')).toBeVisible();
    await expect(gauge(page).locator('.ks-fuel-scoop')).toContainText('Scooping');
    await expect(live(page)).toHaveText('Scooping fuel from the star.');
    expect((await snapshot(page)).hyperFuel).toBeGreaterThan(0.3);

    // Holding position at 3 radii the hull settles near 71%: a warning, shown as a word and icon.
    await advance(page, 60);
    await expect(gauge(page)).toHaveAttribute('data-heat', 'warning');
    await expect(gauge(page).locator('.ks-fuel-flag--heat')).toHaveText('Hot');
    await expect(page.locator('.log li[data-event="heat-warning"]')).toHaveCount(1);
    await expect(page.locator('.log li[data-event="tank-full"]')).toHaveCount(1);
    await expect(gauge(page)).toHaveAttribute('data-scooping', 'false');
    await page.screenshot({ path: `${SHOTS}/sun-warning.png`, fullPage: true });

    // Sirius A at 3 radii: far above the limit. The heat reaches 1.0, the emergency fires and the ship climbs out.
    await page.locator('#star').fill('3');
    await expect(page.locator('output[for="star"]')).toHaveText('Sirius A');
    await page.locator('#distance').fill(radiiSlider(3));
    await advance(page, 3);
    await expect(gauge(page)).toHaveAttribute('data-heat', 'emergency');
    await expect(gauge(page).locator('.ks-fuel-flag--heat')).toHaveText('Emergency');
    await expect(page.locator('.log li[data-event="heat-emergency"]')).toHaveCount(1);
    await expect(page.locator('.flash')).toHaveText('Hull at heat limit: emergency climb');
    await page.screenshot({ path: `${SHOTS}/sirius-emergency.png`, fullPage: true });
    await advance(page, 30);
    const after = await snapshot(page);
    expect(after.radii).toBeGreaterThan(10);
    await expect(gauge(page)).not.toHaveAttribute('data-heat', 'emergency');
    // Exactly one emergency event for one excursion.
    expect(after.events.filter((e) => e === 'heat-emergency')).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('shows the next jump cost, refuses a jump it cannot afford and spends fuel on one it can', async ({ page }) => {
    await open(page, 'r=40&fuel=0.12&jump=none');
    await page.getByRole('button', { name: 'Sirius · 8.60 ly' }).click();
    await expect(page.getByRole('button', { name: 'Sirius · 8.60 ly' })).toHaveAttribute('aria-pressed', 'true');
    await advance(page, 0.1);
    await expect(gauge(page)).toHaveAttribute('data-jump', 'short');
    await expect(gauge(page)).toHaveAttribute('data-low', 'true');
    await expect(gauge(page).locator('.ks-fuel-sub')).toHaveText('Next jump needs 27%');
    await expect(gauge(page).locator('.ks-fuel-flag--low')).toHaveText('Low');
    // The cost outline reaches to the cost (27%) when the tank is short.
    const m = await gauge(page).evaluate((el) => Number(getComputedStyle(el).getPropertyValue('--ks-fuel-m')));
    expect(m).toBeCloseTo(0.267, 2);
    await gauge(page).locator('.ks-fuel-bar').first().screenshot({ path: `${SHOTS}/bar-short.png` });

    // The jump button names the player's current binding for hyperspeed (the default here, J).
    const key = (await page.locator('#jump-btn kbd').textContent()) ?? '';
    expect(key.length).toBeGreaterThan(0);
    await page.keyboard.press(`Key${key.toUpperCase()}`);
    await expect(page.locator('.flash')).toHaveText('Jump refused: not enough hyper-fuel');
    await expect(page.locator('.flash')).toHaveClass(/bad/);

    await page.getByRole('button', { name: 'Fill tank' }).click();
    await expect(gauge(page)).toHaveAttribute('data-jump', 'ok');
    await expect(gauge(page).locator('.ks-fuel-sub')).toHaveText('Next jump 27% · leaves 73%');
    await expect(live(page)).toHaveText('Enough hyper-fuel for the selected jump.');
    const m2 = await gauge(page).evaluate((el) => Number(getComputedStyle(el).getPropertyValue('--ks-fuel-m')));
    expect(m2).toBeCloseTo(0.733, 2);
    await page.locator('#jump-btn').click();
    await expect(page.locator('.flash')).toHaveText('Jumped 8.60 ly (used 27% of the tank)');
    await expect(page.getByRole('meter', { name: 'Hyper-fuel' })).toHaveAttribute('aria-valuenow', '73');
    // Full range: a full tank reaches 50 ly, so after one Sirius jump it does not.
    await page.getByRole('button', { name: 'Full range · 50 ly' }).click();
    await expect(gauge(page)).toHaveAttribute('data-jump', 'short');
    await page.getByRole('button', { name: 'No target' }).click();
    await expect(gauge(page)).toHaveAttribute('data-jump', 'none');
    await expect(gauge(page).locator('.ks-fuel-sub')).toHaveText('No star targeted');
  });

  test('a dim M dwarf must be approached much closer, in stellar radii, than the Sun', async ({ page }) => {
    await open(page, 'r=3&fuel=0.5');
    await expect(page.locator('[data-ro="band"]')).toHaveAttribute('data-band', 'in');
    await page.locator('#star').fill('2');
    await expect(page.locator('output[for="star"]')).toHaveText('Proxima Centauri');
    await expect(page.locator('[data-ro="band"]')).toHaveAttribute('data-band', 'out');
    await expect(page.locator('[data-ro="band"] .v')).toContainText('closer than 1.81 radii');
    await page.locator('#distance').fill(radiiSlider(1.5));
    await expect(page.locator('[data-ro="band"]')).toHaveAttribute('data-band', 'in');
    await advance(page, 30);
    await expect(gauge(page)).toHaveAttribute('data-scooping', 'true');
    // Proxima cannot overheat the hull even at its photosphere.
    await expect(gauge(page)).toHaveAttribute('data-heat', 'nominal');
    // The table view lists the same model values.
    await page.locator('details.table summary').click();
    await expect(page.locator('details.table tbody tr')).toHaveCount(14);
    await expect(page.locator('details.table tbody tr[data-band="in"]').first()).toBeVisible();
  });

  test('is keyboard operable', async ({ page }) => {
    await open(page, 'r=3');
    await page.locator('#star').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('output[for="star"]')).toHaveText('α Centauri A');
    await expect(page.locator('#star')).toHaveAttribute('aria-valuetext', 'α Centauri A');
    await page.keyboard.press('Tab');
    await expect(page.locator('#distance')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.locator('output[for="distance"]')).toHaveText('100.0 stellar radii');
    await page.getByRole('button', { name: 'Run' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  });

  test('stays readable in colour-blind palettes, at 2x text and under reduced motion', async ({ page }) => {
    await open(page, 'star=siriusA&r=4.4&fuel=0.5&heat=0.85&jump=25&climb=0&colorblind=high-contrast&reducedMotion=1');
    await advance(page, 4);
    await expect(page.locator('html')).toHaveAttribute('data-colorblind', 'high-contrast');
    await expect(gauge(page)).toHaveAttribute('data-heat', /critical|emergency/);
    // State is carried by words and shapes, not colour alone.
    await expect(gauge(page).locator('.ks-fuel-flag--heat')).toHaveText(/Critical|Emergency/);
    await expect(gauge(page).locator('.ks-fuel-flag--heat svg')).toHaveCount(1);
    // Reduced motion: no animation on the scoop chip or the heat bar.
    const anims = await gauge(page).evaluate((el) =>
      ['.ks-fuel-scoop', '.ks-heat-fill', '.ks-fuel-fill'].map((s) => getComputedStyle(el.querySelector(s)!).animationName),
    );
    expect(anims).toEqual(['none', 'none', 'none']);
    await gauge(page).screenshot({ path: `${SHOTS}/gauge-high-contrast.png` });

    await open(page, 'r=3&fuel=0.6&jump=4.37&textScale=2');
    await advance(page, 4);
    const box = await gauge(page).boundingBox();
    const preview = await page.locator('.preview').boundingBox();
    expect(box && preview).toBeTruthy();
    // The gauge grows with the text but stays inside its container.
    expect(box!.width).toBeGreaterThan(14.5 * 16 * 1.5);
    expect(box!.x + box!.width).toBeLessThanOrEqual(preview!.x + preview!.width + 1);
    await page.screenshot({ path: `${SHOTS}/text-2x.png`, fullPage: true });
  });
});
