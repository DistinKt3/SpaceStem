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

interface HudLayoutResult {
  overlaps: { top: number; target: number; left: number; footer: number; warn: number };
  gaugeOnScreen: boolean;
  targetOnScreen: boolean;
}

/**
 * Replaces the lab with the game HUD (hud.css + Hud) holding a scooping, critical gauge, a target and a warning, runs
 * the layout pass the game uses, and measures the overlap (px²) between the gauge and each HUD panel.
 */
async function hudLayout(page: Page): Promise<HudLayoutResult> {
  return page.evaluate(async () => {
    document.getElementById('app')!.remove();
    document.body.className = 'ks-cockpit-on';
    // Modules from the dev server (typed through the source files).
    const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
    await load('/src/game/hud/hud.css');
    const { Hud } = await load<typeof import('../../src/game/hud/hud')>('/src/game/hud/hud.ts');
    const { FuelGauge } = await load<typeof import('../../src/game/ship/fuelGauge')>('/src/game/ship/fuelGauge.ts');
    const { FuelHudLayout } = await load<typeof import('../../src/game/ship/fuelLayout')>('/src/game/ship/fuelLayout.ts');
    const { Vec3d } = await load<typeof import('../../src/core/vec3d')>('/src/core/vec3d.ts');
    const hud = new Hud(document.body);
    const g = new FuelGauge(hud.root);
    g.update({ hyperFuel: 0.3, heat: 0.95, scooping: true, nextJumpCost: 0.267, secondsToFull: 20, heatState: 'critical' });
    (hud as unknown as { updatePanels(s: unknown): void }).updatePanels({
      mode: 'cruise',
      throttle: 1,
      speed: 3e5,
      speedLabel: 'drive',
      etaOverride: null,
      governorSpeed: 1e6,
      altitude: 1e9,
      verticalSpeed: 0,
      nearName: 'Sun',
      flightAssist: true,
      landed: false,
      velocityDir: null,
      target: { id: '*1', name: 'Proxima Centauri', rel: new Vec3d(8e16, 0, 0), radius: 1e9, provenance: 'measured', kind: 'star' },
      labels: [],
      utc: '2026-10-11 00:00:00 UTC',
      sunDistance: 1e9,
      sunName: 'Sun',
      howWeKnowKey: 'I',
      warnings: ['Emergency climb'],
      footer: '',
    });
    // Transitions off so the boxes are final.
    for (const e of document.querySelectorAll<HTMLElement>('.ks-fuel, .ks-fuel *')) e.style.transition = 'none';
    new FuelHudLayout(hud.root, g).update(performance.now(), 0);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const box = (e: Element): DOMRect => e.getBoundingClientRect();
    const ov = (a: DOMRect, b: DOMRect): number =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const q = (s: string): DOMRect => box(document.querySelector(s)!);
    const gb = box(g.root);
    const target = q('.ks-hud-right');
    return {
      overlaps: {
        top: ov(gb, q('.ks-hud-top')),
        target: ov(gb, target),
        left: ov(gb, q('.ks-hud-left')),
        footer: ov(gb, q('.ks-hud-footer')),
        warn: ov(gb, q('.ks-hud-warn')),
      },
      gaugeOnScreen: gb.top >= 0 && gb.left >= 0 && gb.bottom <= innerHeight && gb.right <= innerWidth,
      targetOnScreen: target.top >= 0 && target.bottom <= innerHeight,
    };
  });
}
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
    // The gauge says what happened to the hull, the page says what the ship does: no message is spoken twice.
    await expect(page.locator('.flash')).toHaveText('Emergency climb');
    await expect(live(page)).toContainText('Hull heat at its limit.');
    await expect(live(page)).not.toContainText(/climb/i);
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
    // Run/Pause names its action, so it is a plain button (a toggle's label must not change with aria-pressed).
    const run = page.getByRole('button', { name: 'Run' });
    await expect(run).not.toHaveAttribute('aria-pressed', /.*/);
    await run.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pause' })).not.toHaveAttribute('aria-pressed', /.*/);
  });

  test('a hull restored at its limit still climbs out (review: the emergency event never fired)', async ({ page }) => {
    await open(page, 'star=siriusA&r=3&heat=1&fuel=0.5&jump=none');
    await advance(page, 30);
    const after = await snapshot(page);
    expect(after.events).toContain('heat-emergency');
    expect(after.radii).toBeGreaterThan(10);
    await expect(gauge(page)).not.toHaveAttribute('data-heat', 'emergency');
  });

  test('parses the jump parameter like the slider: 0 is no target, the range is clamped', async ({ page }) => {
    await open(page, 'fuel=1&jump=0');
    await expect(page.locator('output[for="jump"]')).toHaveText('No target');
    await expect(gauge(page)).toHaveAttribute('data-jump', 'none');
    await page.locator('#jump-btn').click();
    await expect(page.locator('.flash')).toHaveText('Pick a jump distance first');
    await expect(page.getByRole('meter', { name: 'Hyper-fuel' })).toHaveAttribute('aria-valuenow', '100');
    await open(page, 'fuel=1&jump=70');
    await expect(page.locator('#jump')).toHaveValue('60');
    await expect(page.locator('output[for="jump"]')).toHaveText('60.00 ly');
  });

  test('the jump shortcut never takes keys a focused control needs (review: Enter on a button jumped)', async ({ page }) => {
    await open(page, 'fuel=0.35&jump=4.37&throttle=0.5');
    // Bind hyperspeed to Enter and ArrowRight, as a player could in the settings, then reload.
    await page.evaluate(async () => {
      const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
      const { Settings } = await load<typeof import('../../src/game/settings/settings')>('/src/game/settings/settings.ts');
      const st = new Settings();
      st.set({ bindings: { ...st.data.bindings, hyperspeed: [{ type: 'key', code: 'Enter' }, { type: 'key', code: 'ArrowRight' }] } });
    });
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __ksFuel?: unknown }).__ksFuel !== undefined);
    await expect(page.locator('#jump-btn kbd')).toHaveText('Enter');
    const fuelNow = (): Promise<number> => page.evaluate(() => (window as unknown as { __ksFuel: Hooks }).__ksFuel.fuel.hyperFuel);
    // Enter on a focused button activates that button, not the jump.
    await page.getByRole('button', { name: 'Fill tank' }).focus();
    await page.keyboard.press('Enter');
    expect(await fuelNow()).toBe(1);
    await expect(page.locator('.flash')).toHaveText('');
    // ArrowRight on the focused throttle slider moves the slider.
    await page.locator('#throttle').focus();
    const before = await page.locator('#throttle').inputValue();
    await page.keyboard.press('ArrowRight');
    expect(Number(await page.locator('#throttle').inputValue())).toBe(Number(before) + 1);
    expect(await fuelNow()).toBe(1);
    // With nothing focused the bound key jumps.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Enter');
    await expect(page.locator('.flash')).toHaveText(/^Jumped 4\.37 ly/);
    expect(await fuelNow()).toBeLessThan(1);
    await page.evaluate(() => localStorage.clear());
  });

  test('narrow screen at 2x text: nothing is cut off or covered (review: "Next jump…" was truncated)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'textScale=2&r=3&fuel=0.12&jump=8.6');
    await advance(page, 2);
    await expect(gauge(page).locator('.ks-fuel-sub')).toHaveText('Next jump needs 27%');
    await expect(gauge(page).locator('.ks-fuel-scoop')).toBeVisible();
    const m = await page.evaluate(() => {
      const g = document.querySelector('section.ks-fuel')!;
      const box = (e: Element): DOMRect => e.getBoundingClientRect();
      const sub = g.querySelector<HTMLElement>('.ks-fuel-sub')!;
      const tag = g.querySelector<HTMLElement>('.ks-fuel-tag')!;
      const chip = g.querySelector<HTMLElement>('.ks-fuel-scoop')!;
      const inside = (e: Element, c: Element): boolean => box(e).right <= box(c).right + 0.5 && box(e).left >= box(c).left - 0.5;
      const preview = document.querySelector('.preview')!;
      const note = document.querySelector('.preview-note')!;
      return {
        subFits: sub.scrollWidth <= sub.clientWidth + 1,
        tagInside: inside(tag, g),
        chipTextInside: [...chip.children].every((c) => inside(c, chip)) && inside(chip, g),
        gaugeInPreview: box(g).bottom <= box(preview).bottom + 0.5 && box(g).right <= box(preview).right + 0.5,
        noteBelow: box(note).top >= box(preview).bottom - 0.5,
        pageOverflowX: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(m).toEqual({ subFits: true, tagInside: true, chipTextInside: true, gaugeInPreview: true, noteBelow: true, pageOverflowX: false });
    await page.screenshot({ path: `${SHOTS}/narrow-390-text-2x.png`, fullPage: true });
  });

  test('gauge: a jump under way and a star too close are their own states (review: false "not enough fuel")', async ({ page }) => {
    await open(page, 'fuel=0.3');
    const run = (steps: object[]): Promise<{ jump: string; sub: string; said: string[]; describedBy: string }> =>
      page.evaluate(async (steps) => {
        const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
        const { FuelGauge } = await load<typeof import('../../src/game/ship/fuelGauge')>('/src/game/ship/fuelGauge.ts');
        const host = document.createElement('div');
        document.body.append(host);
        const g = new FuelGauge(host, { placement: 'inline' });
        const said: string[] = [];
        for (const s of steps) {
          g.update({ hyperFuel: 0.3, heat: 0, scooping: false, nextJumpCost: null, ...s });
          if (g.lastAnnouncement && said.at(-1) !== g.lastAnnouncement) said.push(g.lastAnnouncement);
        }
        const id = g.root.getAttribute('aria-describedby') ?? '';
        const out = {
          jump: g.root.dataset['jump'] ?? '',
          sub: g.root.querySelector('.ks-fuel-sub')!.textContent ?? '',
          said,
          describedBy: document.getElementById(id)?.textContent ?? '',
        };
        host.remove();
        return out;
      }, steps);
    // Sirius selected with 30 % (affordable), then the jump engages and pays 27 %: no "not enough" message.
    const engaged = await run([
      { nextJumpCost: 0.267 },
      { hyperFuel: 0.033, nextJumpCost: 0.267, jumpStatus: 'underway' },
      { hyperFuel: 0.033, nextJumpCost: 0.267, jumpStatus: 'underway' },
    ]);
    expect(engaged.jump).toBe('underway');
    expect(engaged.sub).toBe('Jump under way · used 27%');
    expect(engaged.said.join(' ')).not.toMatch(/Not enough/);
    // After arrival the star just reached is still selected: too close to jump to, not "No star targeted".
    const arrived = await run([
      { hyperFuel: 0.033, nextJumpCost: 0.267, jumpStatus: 'underway' },
      { hyperFuel: 0.033, jumpStatus: 'tooClose' },
    ]);
    expect(arrived).toMatchObject({ jump: 'tooClose', sub: 'Target star too close to jump to' });
    expect(arrived.said.join(' ')).not.toMatch(/hyper-fuel for the selected jump/);
    // The fiction note reaches assistive technology (it was a hover title on an element that ignores the pointer).
    expect(engaged.describedBy).toMatch(/game mechanics/);
    expect(engaged.describedBy).toMatch(/stellar flux they react to is real/);
  });

  // HUD layout: the real HUD (hud.css, Hud) with the gauge and the layout pass, on this DOM-only page.
  const sizes: [number, number, number][] = [
    [1280, 720, 1],
    [800, 450, 1],
    [1366, 768, 1.5],
    [1280, 720, 1.5],
    [1920, 1080, 2],
  ];
  for (const [w, h, scale] of sizes) {
    test(`HUD: the gauge keeps clear of the HUD panels at ${w}x${h}, text scale ${scale} (review: overlap at 1.5x and 2x)`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await open(page, `textScale=${scale}`);
      const r = await hudLayout(page);
      expect(r.overlaps).toEqual({ top: 0, target: 0, left: 0, footer: 0, warn: 0 });
      expect(r.gaugeOnScreen).toBe(true);
      expect(r.targetOnScreen).toBe(true);
      await page.screenshot({ path: `${SHOTS}/hud-${w}x${h}-x${scale}.png` });
    });
  }
  test('HUD: at 1280x720 and text scale 2 the gauge never covers the target panel', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page, 'textScale=2');
    const r = await hudLayout(page);
    // The HUD's own panels overlap each other at this size (40 x 22.5 rem); the gauge stays off the target panel.
    expect(r.overlaps.target).toBe(0);
    expect(r.gaugeOnScreen).toBe(true);
    await page.screenshot({ path: `${SHOTS}/hud-1280x720-x2.png` });
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
