/**
 * The guided opening on onboarding.html (DOM and a 2D canvas, no WebGPU, so page screenshots work): the tour card over
 * a simulated ship, the real HUD layout, Settings and InputManager. Screenshots go to test-results/onboarding-shots/.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';

const SHOTS = 'test-results/onboarding-shots';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface KsWindow {
  __ks: {
    onboarding: { stepId: string | null; active: boolean };
    settings: { data: { bindings: Record<string, unknown[]> }; set(patch: Record<string, unknown>): void };
    input: { activeDevice: 'kbm' | 'pad' };
    sim: {
      looked: number;
      throttle: number;
      mode: string;
      landed: boolean;
      moonDist: number;
      aligned: boolean;
      mapOpen: boolean;
      target: { id: string } | null;
      hyperPhase: string;
      altitude: number;
    };
    stepLog: string[];
    t(key: string, params?: Record<string, string | number>): string;
  };
}

async function open(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // The dev server has no favicon; everything else counts.
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`/onboarding.html?reset=1${query ? `&${query}` : ''}`);
  await page.waitForFunction(() => (window as unknown as Partial<KsWindow>).__ks !== undefined);
  return errors;
}

const card = (page: Page): Locator => page.locator('section.ks-onb');
const goal = (page: Page): Locator => page.locator('.ks-onb-goal-text');
const key = (page: Page, action: string): Locator => page.locator(`.ks-onb-hint kbd[data-action="${action}"]`);
const step = (page: Page): Promise<string | null> =>
  page.evaluate(() => (window as unknown as KsWindow).__ks.onboarding.stepId);
const sim = <T>(page: Page, fn: (s: KsWindow['__ks']['sim']) => T): Promise<T> =>
  page.evaluate<T>(`(${fn.toString()})(window.__ks.sim)`);

async function rect(loc: Locator): Promise<Rect> {
  return loc.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
}

const intersects = (a: Rect, b: Rect): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Mode presses one frame apart: like the game, the lab reads "next mode" once per frame. */
async function nextMode(page: Page, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
  }
}

async function fake(page: Page, what: string): Promise<void> {
  await page.locator(`button[data-fake="${what}"]`).click();
}

test.describe('guided opening', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('walks a pilot from Earth orbit to the stars with their own keys', async ({ page }) => {
    const errors = await open(page, 'fast=1');
    await expect(card(page)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Guided tour' })).toBeVisible();
    await expect(page.locator('.ks-onb-eyebrow')).toHaveText('Welcome aboard');
    await expect(goal(page)).toHaveText('Look around');
    await expect(page.locator('.ks-onb-count')).toHaveText('1 / 9');
    await expect(key(page, 'headLook')).toHaveText('Mouse R');
    await expect(key(page, 'yaw')).toHaveText('A / D');
    await expect(page.locator('.ks-onb-science')).toContainText('420 km above Earth');
    await page.screenshot({ path: `${SHOTS}/01-look.png` });

    // Look around: hold the right mouse button on the view and drag.
    await page.mouse.move(560, 520);
    await page.mouse.down({ button: 'right' });
    for (let i = 1; i <= 16; i++) await page.mouse.move(560 + i * 30, 520 - i * 4);
    await page.mouse.up({ button: 'right' });
    expect(await sim(page, (s) => s.looked)).toBeGreaterThan(1);
    await expect(goal(page)).toHaveText('Throttle up', { timeout: 10_000 });

    // "Hold" names only the key that raises the throttle (W), not the whole S / W pair (review).
    await expect(goal(page)).toHaveText('Throttle up');
    await expect(page.locator('.ks-onb-hint kbd[data-action="thrust"][data-half="+"]')).toHaveText('W');
    await expect(page.locator('.ks-onb-hint')).toContainText('or hold W.');
    // Throttle up with the throttle key (= by default).
    for (let i = 0; i < 5; i++) await page.keyboard.press('Equal');
    await expect(goal(page)).toHaveText('Target the Moon', { timeout: 10_000 });
    await expect(key(page, 'targetNext')).toHaveText('Tab');
    await expect(key(page, 'targetReticle')).toHaveText('T');
    // The Moon is already targeted: the step completes after its reading time.
    await expect(goal(page)).toHaveText('Point the nose at the Moon', { timeout: 15_000 });

    // Auto-align.
    await page.keyboard.press('KeyN');
    await expect(goal(page)).toHaveText('Switch to cruise', { timeout: 10_000 });
    await page.keyboard.press('Backspace'); // throttle to zero, so the next step has something to say
    await expect(page.locator('.ks-onb-hint')).toContainText('Thrusters, Impulse, Cruise');
    await nextMode(page, 2);
    await expect(goal(page)).toHaveText('Fly to the Moon', { timeout: 10_000 });
    await expect(page.locator('.ks-onb-nudge')).toContainText('Raise the throttle');
    await page.screenshot({ path: `${SHOTS}/02-approach-nudge.png` });
    for (let i = 0; i < 16; i++) await page.keyboard.press('Equal');
    await expect(page.locator('.ks-onb-nudge')).toBeHidden();

    // Within 20,000 km of the Moon: the optional landing.
    await expect(goal(page)).toHaveText('Land on the Moon', { timeout: 90_000 });
    await expect(page.locator('.ks-onb-optional')).toHaveText('Optional');
    await expect(page.getByRole('button', { name: 'Skip this step' })).toBeVisible();
    // The hint follows the flight model from the tour's attitude: thrust along the nose, then cut the throttle (review).
    await expect(page.locator('.ks-onb-hint')).toHaveText(
      'Nose on the Moon: near the surface the drive drops to thrusters. Ease down with W, then cut the throttle with Bksp on the ground.',
    );
    await expect.poll(() => sim(page, (s) => s.mode), { timeout: 60_000 }).toBe('thrusters');
    await expect(page.locator('.ks-onb-nudge')).toHaveText('Ease down toward the surface with W.');
    // Strafing "down" with the nose on the Moon slides along the surface: no closer.
    const before = await sim(page, (s) => s.moonDist);
    await page.keyboard.down('KeyF');
    await page.waitForTimeout(800);
    await page.keyboard.up('KeyF');
    expect(await sim(page, (s) => s.moonDist)).toBeGreaterThanOrEqual(before);
    // A little forward thrust brings the ship down; on the ground the card asks for the throttle cut.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyW');
    await expect(page.locator('.ks-onb-nudge')).toHaveText('You are on the ground: cut the throttle with Bksp to touch down.', {
      timeout: 60_000,
    });
    expect(await sim(page, (s) => s.landed)).toBe(false);
    await page.screenshot({ path: `${SHOTS}/02b-land-settle.png` });
    await page.keyboard.press('Backspace');
    await expect.poll(() => sim(page, (s) => s.landed), { timeout: 10_000 }).toBe(true);
    await expect(goal(page)).toHaveText('Open the map', { timeout: 10_000 });

    // The map: the card moves to the free bottom-left corner.
    await page.keyboard.press('KeyM');
    await expect(goal(page)).toHaveText('Choose a star and engage hyperspeed', { timeout: 10_000 });
    const onMap = await rect(card(page));
    expect(onMap.bottom).toBeGreaterThan(720 - 40);
    for (const sel of ['.ks-map-title', '.ks-map-list'])
      expect(intersects(onMap, await rect(page.locator(sel))), sel).toBe(false);
    await expect(page.locator('.ks-onb-nudge')).toContainText('“Show star map” lists the named stars nearby');
    await page.screenshot({ path: `${SHOTS}/03-map.png` });
    // On the star map the button reads "Show system map": the nudge points to the list instead (review).
    await page.getByRole('button', { name: 'Show star map' }).click();
    await expect(page.locator('.ks-onb-nudge')).toHaveText('Choose one of the named stars in the list.');
    // The Sun is listed, but hyperspeed refuses it inside the Solar System (review).
    await page.getByRole('button', { name: 'Sun' }).click();
    await expect(page.locator('.ks-onb-nudge')).toHaveText('Too close for a jump: Sun. Choose a more distant star.');
    await page.getByRole('button', { name: 'Proxima Centauri' }).click();
    await expect(page.locator('.ks-onb-nudge')).toContainText('Close the map with M, then press J.');
    await page.keyboard.press('KeyM');

    // Landed and deep in the Moon's gravity well: the card says what to do first, naming only the key that lifts off.
    await expect(page.locator('.ks-onb-nudge')).toHaveText('Lift off first: rise with R.');
    await page.keyboard.down('KeyR');
    await expect(page.locator('.ks-onb-nudge')).toHaveText(
      'Too deep in a gravity well for hyperspeed: climb to an altitude of 10,000 km first.',
    );
    await page.keyboard.up('KeyR');
    await nextMode(page, 2);
    for (let i = 0; i < 20; i++) await page.keyboard.press('Equal');
    await expect(page.locator('.ks-onb-nudge')).toBeHidden({ timeout: 60_000 });
    await page.keyboard.press('KeyJ');
    await expect(goal(page)).toHaveText('The sky is yours', { timeout: 10_000 });
    await expect(page.locator('.ks-onb-eyebrow')).toHaveText('Tour complete');
    await expect(page.locator('.ks-onb-count')).toHaveText('9 / 9');
    await page.screenshot({ path: `${SHOTS}/04-done.png` });

    const log = await page.evaluate(() => (window as unknown as KsWindow).__ks.stepLog);
    expect(log).toEqual([
      'look',
      'throttle',
      'target',
      'align',
      'cruise',
      'approach',
      'land',
      'map',
      'hyperspeed',
      'done',
    ]);
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('knownsky.onboarding') ?? '{}') as unknown),
    ).toMatchObject({ status: 'done' });
    // The closing card leaves by itself (fast timing: 4 s).
    await expect(card(page)).toBeHidden({ timeout: 15_000 });
    expect(errors).toEqual([]);
  });

  test('skip ends the tour, says where to restart it, and is remembered', async ({ page }) => {
    const errors = await open(page, 'fast=1');
    await expect(goal(page)).toHaveText('Look around');
    await page.getByRole('button', { name: 'Skip tour' }).click();
    await expect(goal(page)).toHaveText('Tour skipped');
    await expect(card(page)).toBeVisible();
    await page.waitForTimeout(1500);
    // The note stays readable for a few seconds before it fades.
    await expect(card(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skip tour' })).toBeHidden();
    await expect(page.locator('.ks-onb-hint')).toHaveText(
      'The sky is yours. Restart the tour any time from Settings (Esc).',
    );
    await expect(page.locator('.ks-onb-sr[role="status"]')).toHaveText(
      'Guided tour ended. Restart it any time from Settings.',
    );
    await page.screenshot({ path: `${SHOTS}/05-skipped.png` });
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('knownsky.onboarding') ?? '{}') as unknown),
    ).toMatchObject({ status: 'skipped' });
    await expect(card(page)).toBeHidden({ timeout: 10_000 });
    // Playing on never brings it back, and neither does a new session.
    await fake(page, 'look');
    await page.waitForTimeout(500);
    await expect(card(page)).toBeHidden();
    await page.goto('/onboarding.html');
    await page.waitForFunction(() => (window as unknown as Partial<KsWindow>).__ks !== undefined);
    await page.waitForTimeout(500);
    await expect(card(page)).toBeHidden();
    expect(await step(page)).toBeNull();
    // Restarting (as the Settings entry does) replays it from the first step.
    await page.locator('#lab-restart').click();
    await expect(card(page)).toBeVisible();
    await expect(goal(page)).toHaveText('Look around');
    expect(errors).toEqual([]);
  });

  test('the restart hint and the skip control are always on the card', async ({ page }) => {
    await open(page, 'step=align');
    await expect(page.locator('.ks-onb-restart')).toHaveText('Restart it any time from Settings (Esc).');
    await expect(page.locator('.ks-onb-restart kbd')).toHaveText('Esc');
    await expect(page.getByRole('button', { name: 'Skip tour' })).toBeVisible();
    // Not on the optional-step control unless the step is optional.
    await expect(page.getByRole('button', { name: 'Skip this step' })).toBeHidden();
  });

  test('key hints follow the player’s bindings and input device', async ({ page }) => {
    await open(page, 'step=target');
    await expect(goal(page)).toHaveText('Target the Moon');
    await fake(page, 'targetOther'); // keep the step open: the Moon is no longer the target
    await expect(key(page, 'targetNext')).toHaveText('Tab');
    // Rebind "next target" to O: the card updates without a reload, and O works.
    await page.evaluate(() => {
      const ks = (window as unknown as KsWindow).__ks;
      ks.settings.set({
        bindings: { ...ks.settings.data.bindings, targetNext: [{ type: 'key', code: 'KeyO' }, null] },
      });
    });
    await expect(key(page, 'targetNext')).toHaveText('O');
    await page.keyboard.press('KeyO');
    await expect.poll(() => sim(page, (s) => s.target?.id)).toBe('399');
    await expect(page.locator('.ks-onb-nudge')).toBeHidden(); // the target step has no nudge; it simply is not done
    await expect(card(page)).toHaveAttribute('data-phase', 'pending');
    // Unbound actions say so instead of naming a key.
    await page.evaluate(() => {
      const ks = (window as unknown as KsWindow).__ks;
      ks.settings.set({ bindings: { ...ks.settings.data.bindings, targetReticle: [null, null] } });
    });
    await expect(key(page, 'targetReticle')).toHaveText('Not bound');
    await expect(key(page, 'targetReticle')).toHaveClass(/is-unbound/);
    await page.screenshot({ path: `${SHOTS}/06-rebound.png` });
    // On a gamepad the card names pad buttons.
    await page.evaluate(() => ((window as unknown as KsWindow).__ks.input.activeDevice = 'pad'));
    const pad = await page.evaluate(() => {
      const ks = (window as unknown as KsWindow).__ks;
      return { right: ks.t('input.pad.xbox.b15'), a: ks.t('input.pad.xbox.b0') };
    });
    expect(pad.right).not.toBe('input.pad.xbox.b15');
    await expect(key(page, 'targetNext')).toHaveText(pad.right);
    await expect(key(page, 'targetReticle')).toHaveText(pad.a);
  });

  test('gamepad players get gamepad wording, and it follows a device switch', async ({ page }) => {
    await open(page, 'step=throttle&pad=1');
    await expect(goal(page)).toHaveText('Throttle up');
    await expect(page.locator('.ks-onb-hint')).toContainText('Hold');
    await expect(page.locator('.ks-onb-hint')).toContainText('to raise the throttle');
    await expect(page.locator('.ks-onb-hint kbd.is-unbound')).toHaveCount(0);
    // "Hold RT", not "Hold LT / RT": LT lowers the throttle (review).
    const rt = await page.evaluate(() => (window as unknown as KsWindow).__ks.t('input.pad.xbox.b7'));
    await expect(key(page, 'thrust')).toHaveText(rt);
    await expect(key(page, 'thrust')).toHaveAttribute('data-half', '+');
    await expect(key(page, 'throttleUp')).toHaveCount(0);
    // Back on the keyboard, the keyboard wording returns.
    await page.keyboard.press('KeyK');
    await expect(key(page, 'throttleUp')).toHaveText('=');
    await expect(page.locator('.ks-onb-hint')).toContainText('Raise the throttle with');
  });

  test('resumes at the remembered step after a reload, minimised if it was', async ({ page }) => {
    await open(page, 'fast=1');
    await fake(page, 'look');
    await expect(goal(page)).toHaveText('Throttle up', { timeout: 15_000 });
    await fake(page, 'throttle');
    await expect(goal(page)).toHaveText('Target the Moon', { timeout: 10_000 });
    await expect(goal(page)).toHaveText('Point the nose at the Moon', { timeout: 15_000 });
    const minimise = page.getByRole('button', { name: 'Minimise the guided tour' });
    await expect(minimise).toHaveAttribute('aria-expanded', 'true');
    await minimise.click();
    await expect(page.locator('.ks-onb-body')).toBeHidden();
    await expect(page.locator('.ks-onb-mini')).toHaveText('Point the nose at the Moon');
    await page.screenshot({ path: `${SHOTS}/07-minimised.png` });
    await page.goto('/onboarding.html');
    await page.waitForFunction(() => (window as unknown as Partial<KsWindow>).__ks !== undefined);
    await expect(card(page)).toBeVisible();
    expect(await step(page)).toBe('align');
    await expect(page.locator('.ks-onb-mini')).toHaveText('Point the nose at the Moon');
    const expand = page.getByRole('button', { name: 'Show the guided tour' });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expand.click();
    await expect(page.locator('.ks-onb-body')).toBeVisible();
    await expect(page.locator('.ks-onb-count')).toHaveText('4 / 9');
  });

  test('starts fresh when the stored progress is corrupt', async ({ page }) => {
    await page.goto('/onboarding.html?reset=1');
    await page.evaluate(() => localStorage.setItem('knownsky.onboarding', '{"v":1,"status":"active","step":42'));
    await page.goto('/onboarding.html');
    await page.waitForFunction(() => (window as unknown as Partial<KsWindow>).__ks !== undefined);
    await expect(goal(page)).toHaveText('Look around');
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('knownsky.onboarding') ?? '{}') as unknown),
    ).toMatchObject({ status: 'active', step: 'look' });
  });

  test('announces steps politely and exposes progress', async ({ page }) => {
    await open(page);
    const live = page.locator('.ks-onb-sr[role="status"]');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText(
      'Guided tour, step 1 of 9: Look around. Hold Mouse R and move the mouse to turn your head, or steer the ship with ↓ / ↑ and A / D.',
    );
    // The science tag and sentence are separate words for screen readers, not "Real scienceYou are..." (review).
    await expect(page.locator('.ks-onb-science')).toHaveText(/^Real science: You are 420 km above Earth/);
    const aria = await card(page).ariaSnapshot();
    expect(aria).not.toContain('Real scienceYou');
    expect(aria).toContain('paragraph: "Real science : You are 420 km above Earth');
    const bar = page.getByRole('progressbar', { name: 'Guided tour' });
    await expect(bar).toHaveAttribute('aria-valuetext', 'Step 1 of 9');
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
    await expect(page.locator('.ks-onb-goal')).toHaveRole('heading');
    await fake(page, 'look');
    // Done: the goal is ticked and announced, and stays for the grace delay before the next step.
    await expect(card(page)).toHaveAttribute('data-phase', 'complete', { timeout: 10_000 });
    await expect(page.locator('.ks-onb-mark-done')).toBeVisible();
    await expect(page.locator('.ks-onb-mark-pending')).toBeHidden();
    await expect(live).toHaveText('Done: Look around.');
    await page.screenshot({ path: `${SHOTS}/11-step-done.png` });
    await expect(live).toContainText('Guided tour, step 2 of 9: Throttle up.', { timeout: 10_000 });
    await expect(bar).toHaveAttribute('aria-valuenow', '1');
  });

  test('stays clear of the reticle and the HUD panels', async ({ page }) => {
    for (const s of ['look', 'approach', 'hyperspeed', 'done']) {
      await open(page, `step=${s}&lab=0`);
      await page.waitForTimeout(400);
      const c = await rect(card(page));
      expect(c.left).toBeGreaterThanOrEqual(0);
      expect(c.top).toBeGreaterThanOrEqual(0);
      for (const sel of ['.ks-hud-top', '.ks-hud-left', '.ks-hud-right', '.ks-reticle', '.ks-hud-footer']) {
        expect(intersects(c, await rect(page.locator(sel))), `${s}: ${sel}`).toBe(false);
      }
    }
    await page.screenshot({ path: `${SHOTS}/08-layout-done.png` });
  });

  // Shorter windows (review): 1280x600 is what a 1280x720 screen leaves after browser chrome. The card stops above
  // the HUD's left panel and scrolls; the goal and the key hint stay in view where there is room for them.
  for (const [w, h, hintInView] of [
    [1280, 600, true],
    [1024, 576, true],
    [1366, 650, true],
    [800, 450, false],
  ] as const) {
    test(`stays clear of the HUD panels at ${w}×${h}, with the hint in view`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      for (const s of ['look', 'throttle', 'target', 'align', 'cruise', 'approach', 'land', 'map', 'hyperspeed', 'done']) {
        await open(page, `step=${s}&lab=0`);
        await page.waitForTimeout(300);
        const c = await rect(card(page));
        expect(c.top).toBeGreaterThanOrEqual(0);
        for (const sel of ['.ks-hud-top', '.ks-hud-left', '.ks-hud-right', '.ks-reticle', '.ks-hud-footer']) {
          expect(intersects(c, await rect(page.locator(sel))), `${s}: ${sel}`).toBe(false);
        }
        // The goal is always in view; the hint too where the window leaves room for it.
        expect((await rect(goal(page))).bottom, `${s}: goal`).toBeLessThanOrEqual(c.bottom);
        if (hintInView) expect((await rect(page.locator('.ks-onb-hint'))).bottom, `${s}: hint`).toBeLessThanOrEqual(c.bottom);
        // Anything below the visible part is announced by the fade.
        const overflow = await card(page).evaluate((e) => e.scrollHeight - e.clientHeight > 2);
        if (!overflow) {
          expect(await card(page).getAttribute('data-more')).not.toBe('true');
          continue;
        }
        await expect(card(page)).toHaveAttribute('data-more', 'true');
        // ...and the rest is reachable by scrolling the card.
        await card(page).evaluate((e) => (e.scrollTop = e.scrollHeight));
        await expect(page.getByRole('button', { name: s === 'done' ? 'Close' : 'Skip tour' })).toBeInViewport();
        await expect(card(page)).toHaveAttribute('data-more', 'false');
      }
      await page.screenshot({ path: `${SHOTS}/08-layout-${w}x${h}.png` });
    });
  }

  test('warns when Earth hides the Moon, before the pilot flies into it', async ({ page }) => {
    await open(page, 'step=align');
    await fake(page, 'blocked');
    await expect(page.locator('.ks-onb-nudge')).toHaveText(
      'Earth is between you and the Moon. Steer away from Earth and climb clear of it, then turn back to the bracket.',
    );
    await page.keyboard.press('KeyN'); // auto-align on: it would hold the nose on the hidden Moon
    await expect(page.locator('.ks-onb-nudge')).toContainText('Turn auto-align off with N');
    await page.screenshot({ path: `${SHOTS}/12-blocked.png` });
  });

  test('honours reduced motion', async ({ page }) => {
    await open(page);
    await expect(card(page)).toHaveClass(/is-entering/);
    expect(await card(page).evaluate((e) => getComputedStyle(e).animationName)).toBe('ks-onb-in');
    await open(page, 'reduced=1');
    await expect(card(page)).toHaveAttribute('data-motion', 'reduced');
    expect(await card(page).evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
    expect(await page.locator('.ks-onb-dot').evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
  });
});

test.describe('guided opening at text scale 200%', () => {
  async function checkNoOverflow(page: Page, vw: number, vh: number, allowScroll: boolean): Promise<void> {
    const c = await rect(card(page));
    expect(c.left).toBeGreaterThanOrEqual(0);
    expect(c.top).toBeGreaterThanOrEqual(0);
    expect(c.right).toBeLessThanOrEqual(vw);
    expect(c.bottom).toBeLessThanOrEqual(vh);
    // Never across the reticle at the centre of the view.
    expect(intersects(c, await rect(page.locator('.ks-reticle')))).toBe(false);
    expect(c.right).toBeLessThan(vw / 2);
    // No text runs out sideways, and (where it fits) nothing is cut off at the bottom.
    const wide = await card(page).evaluate((root): string[] =>
      [root, ...root.querySelectorAll('*')]
        // Screen-reader-only text is clipped to 1 px on purpose.
        .filter((e) => !e.classList.contains('ks-onb-sr') && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1)
        .map((e) => e.getAttribute('class') ?? e.tagName),
    );
    expect(wide).toEqual([]);
    if (!allowScroll) expect(await card(page).evaluate((e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
  }

  test('1280×720: every step fits without overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    for (const s of [
      'look',
      'throttle',
      'target',
      'align',
      'cruise',
      'approach',
      'land',
      'map',
      'hyperspeed',
      'done',
    ]) {
      await open(page, `step=${s}&textScale=2&lab=0`);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('32px');
      // The landing happens where the drive drops out above the Moon (from Earth orbit the card would add a nudge).
      if (s === 'land') await page.evaluate(() => document.querySelector<HTMLElement>('button[data-fake="lowMoon"]')!.click());
      await page.waitForTimeout(300);
      await checkNoOverflow(page, 1280, 720, false);
      if (s === 'approach') await page.screenshot({ path: `${SHOTS}/09-text200-1280.png` });
    }
  });

  test('800×450: the card stays on screen and scrolls rather than spilling', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 450 });
    for (const s of ['look', 'approach', 'hyperspeed']) {
      await open(page, `step=${s}&textScale=2&lab=0`);
      await page.waitForTimeout(300);
      await checkNoOverflow(page, 800, 450, true);
    }
    await page.screenshot({ path: `${SHOTS}/10-text200-800.png` });
  });
});
