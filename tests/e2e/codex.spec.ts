/**
 * Codex, "How do we know this?" and provenance badges on codex.html (DOM only, no WebGPU canvas, so page screenshots
 * work). Screenshots are written to test-results/codex-shots/ for visual review.
 */
import { test, expect, type Page } from '@playwright/test';

const SHOTS = 'test-results/codex-shots';

interface CodexHook {
  store: { discover(id: string): boolean; discovered(id: string): boolean; log(): { id: string; at: number }[] };
  ui: { howWeKnow: { showById(id: string): boolean } };
}
type HookWindow = Window & { __ksCodex: CodexHook };

const discover = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((i) => (window as unknown as HookWindow).__ksCodex.store.discover(i), id);
const discovered = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((i) => (window as unknown as HookWindow).__ksCodex.store.discovered(i), id);

async function open(page: Page, query = '', opts: { reset?: boolean } = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // The dev server has no favicon; everything else logged as an error is a failure.
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
  });
  const q = [opts.reset === false ? '' : 'reset=1', 'source=fixtures', query].filter(Boolean).join('&');
  await page.goto(`/codex.html?${q}`);
  await page.waitForFunction(() => (window as unknown as { __ksCodex?: unknown }).__ksCodex !== undefined);
  return errors;
}

const codex = (page: Page) => page.getByRole('dialog', { name: 'Codex' });
const hwk = (page: Page) => page.getByRole('dialog', { name: 'How do we know this?' });
const entryTitle = (page: Page) => page.locator('.ks-cx-entry-title');

async function settle(page: Page): Promise<void> {
  // Let transitions finish before a screenshot (CPU rendering is slow).
  await page.waitForTimeout(1200);
}

test.describe('Codex panel', () => {
  test('opens from the keyboard, navigates categories and entries, and returns focus on close', async ({ page }) => {
    const errors = await open(page);
    await page.keyboard.press('KeyC');
    await expect(codex(page)).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(5);
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeFocused();
    // Starts on the first known entry (the Sun), in Stars.
    await expect(page.getByRole('tab', { name: /Stars/ })).toHaveAttribute('aria-selected', 'true');
    await expect(entryTitle(page)).toHaveText('Sun');

    // Arrow down: selection follows focus, onto a locked entry with a hint.
    const before = await listbox.getAttribute('aria-activedescendant');
    await page.keyboard.press('ArrowDown');
    await expect(listbox).not.toHaveAttribute('aria-activedescendant', before ?? '');
    const active = page.locator(`#${(await listbox.getAttribute('aria-activedescendant'))!}`);
    await expect(active).toHaveAttribute('aria-selected', 'true');
    await expect(active).toHaveAttribute('aria-label', /^Not yet discovered\. Jump to Proxima Centauri/);
    await expect(entryTitle(page)).toHaveText('Not yet discovered');

    // Shift+Tab back through search and close to the selected tab; arrows switch category.
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('searchbox')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Close Codex' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('tab', { name: /Stars/ })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    const bodies = page.getByRole('tab', { name: /Bodies/ });
    await expect(bodies).toBeFocused();
    await expect(bodies).toHaveAttribute('aria-selected', 'true');
    await expect(listbox).toHaveAttribute('aria-label', 'Bodies entries');
    await page.keyboard.press('ArrowDown');
    await expect(listbox).toBeFocused();
    await expect(entryTitle(page)).toHaveText('Earth');
    await expect(page.getByRole('option', { name: 'Earth' })).toHaveAttribute('aria-selected', 'true');

    // Enter moves into the entry; Tab reaches its first control.
    await page.keyboard.press('Enter');
    await expect(entryTitle(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'How do we know this?' })).toBeFocused();
    await expect(page.locator('.ks-cx-table tbody tr')).toHaveCount(7);
    await expect(page.locator('.ks-cx-sources > li')).toHaveCount(6);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/panel-entry.png` });

    // Tab never leaves the dialog.
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('dialog.ks-cx') !== null)).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(codex(page)).toBeHidden();

    // Opened from a button, closing returns focus to it.
    await page.locator('#lab-open').click();
    await expect(codex(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(codex(page)).toBeHidden();
    await expect(page.locator('#lab-open')).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('lists locked entries with hints, searches discovered entries only, and shows the discovery log', async ({
    page,
  }) => {
    await open(page, 'discover=moon,trappist-1&open=codex');
    await expect(codex(page)).toBeVisible();
    // Opens on the newest unseen discovery.
    await expect(entryTitle(page)).toHaveText('TRAPPIST-1');
    await page.getByRole('tab', { name: /Exoplanets/ }).click();
    await expect(codex(page).getByRole('option')).toHaveCount(1);
    await expect(codex(page).getByRole('option').first()).toHaveAttribute(
      'aria-label',
      'Not yet discovered. Travel to the TRAPPIST-1 system to unlock it.',
    );
    await codex(page).getByRole('option').first().click();
    await expect(page.locator('.ks-cx-lockcard')).toContainText('Travel to the TRAPPIST-1 system to unlock it.');
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/panel-locked.png` });

    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox')).toBeFocused();
    await page.keyboard.type('radius');
    await expect(page.getByRole('listbox')).toHaveAttribute('aria-label', 'Search results for “radius”');
    // Sun, Earth, the now-discovered Moon and TRAPPIST-1: never the locked TRAPPIST-1 e.
    await expect(codex(page).getByRole('option')).toHaveCount(4);
    await expect(page.getByRole('status').filter({ hasText: 'results' })).toHaveText('4 results');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('listbox')).toBeFocused();
    await page.locator('.ks-cx-search-input').focus();
    await page.keyboard.press('Escape'); // clears the search, keeps the Codex open
    await expect(page.getByRole('searchbox')).toHaveValue('');
    await expect(codex(page)).toBeVisible();

    await page.getByRole('tab', { name: /Discovery log/ }).click();
    const log = codex(page).getByRole('option');
    await expect(log).toHaveCount(2);
    await expect(log.nth(0)).toHaveAttribute('aria-label', /^TRAPPIST-1, Star, discovered just now/);
    await expect(log.nth(1)).toHaveAttribute('aria-label', /^Moon, Body, discovered just now, new$/);
    await expect(page.locator('.ks-cx-opt.is-new .ks-cx-new')).toHaveText('New');
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/panel-log.png` });
  });

  test('How do we know this?: values with tiers and citations, a focus trap, and Esc back to the opener', async ({
    page,
  }) => {
    const errors = await open(page, 'open=codex&entry=earth');
    const button = page.getByRole('button', { name: 'How do we know this?' });
    await button.click();
    const dialog = hwk(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'How do we know this?' })).toBeFocused();
    await expect(dialog.locator('.ks-cx-eyebrow').first()).toHaveText('Provenance · Earth');
    // One row per fact and per claim, each with a badge, method and source.
    await expect(dialog.locator('.ks-hwk-item')).toHaveCount(7 + 3);
    const first = dialog.locator('.ks-hwk-item').first();
    await expect(first.getByRole('img', { name: /^Measured: / })).toBeVisible();
    await expect(first).toContainText('Equatorial radius');
    await expect(first).toContainText('6,378.1366 ± 0.0001 km');
    await expect(first).toContainText('Satellite geodesy');
    await expect(first).toContainText('Archinal, B. A. et al. (2018). Report of the IAU Working Group');
    const link = first.getByRole('link', { name: /doi:10\.1007\/s10569-017-9805-5/ });
    await expect(link).toHaveAttribute('href', 'https://doi.org/10.1007/s10569-017-9805-5');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    // A source already given in full is shortened to authors, year and link.
    const second = dialog.locator('.ks-hwk-item').nth(1);
    await expect(second.locator('.ks-cx-cite')).toHaveText(
      /^Archinal, B\. A\. et al\. \(2018\)\. doi:10\.1007\/s10569-017-9805-5/,
    );
    await expect(second.getByRole('link', { name: /doi:10\.1007/ })).toHaveAttribute(
      'href',
      'https://doi.org/10.1007/s10569-017-9805-5',
    );
    await expect(dialog.getByRole('img', { name: /^Inferred: / }).first()).toBeVisible();
    await expect(dialog.getByRole('img', { name: /^Generated: / }).first()).toBeVisible();
    await expect(dialog.locator('.ks-hwk-tier')).toHaveCount(3);
    await expect(dialog.locator('.ks-cx-unverified').first()).toHaveText(/Unverified/);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/how-we-know.png` });

    // Focus is trapped in both directions.
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('dialog.ks-hwk') !== null)).toBe(true);
    }
    await dialog.getByRole('button', { name: 'Close' }).first().focus();
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('dialog.ks-hwk') !== null)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(codex(page)).toBeVisible();
    await expect(button).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('"Read Codex entry" opens the Codex at the entry; locked entries say so', async ({ page }) => {
    await open(page);
    await page.keyboard.press('KeyI'); // the lab's "explain the target" (Earth)
    await expect(hwk(page)).toBeVisible();
    await hwk(page).getByRole('button', { name: 'Read Codex entry' }).click();
    await expect(hwk(page)).toBeHidden();
    await expect(codex(page)).toBeVisible();
    await expect(entryTitle(page)).toHaveText('Earth');
    await expect(entryTitle(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(codex(page)).toBeHidden();

    // A locked entry's provenance is still explained, but its Codex page is not opened.
    await page.evaluate(() => (window as unknown as HookWindow).__ksCodex.ui.howWeKnow.showById('moon'));
    await expect(hwk(page).getByRole('button', { name: 'Codex entry not yet discovered' })).toBeDisabled();
  });
});

test.describe('provenance badges', () => {
  test('are shape-coded, labelled and independent of colour', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 }); // the lab shows its badge gallery on larger screens
    await open(page);
    const info = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.lab-badges .ks-badge')].map((b) => {
        const cs = getComputedStyle(b);
        const label = b.querySelector<HTMLElement>('.ks-badge-label')!;
        const glyph = b.querySelector('svg')!;
        return {
          p: b.dataset['provenance'],
          compact: b.classList.contains('ks-badge--compact'),
          role: b.getAttribute('role'),
          aria: b.getAttribute('aria-label'),
          border: cs.borderTopStyle,
          color: cs.color,
          text: label.textContent,
          labelWidth: label.getBoundingClientRect().width,
          glyph: `${glyph.querySelector('circle')!.getAttribute('fill')}|${glyph.querySelectorAll('path').length}`,
        };
      }),
    );
    expect(info).toHaveLength(6);
    const by = (p: string, compact: boolean) => info.find((i) => i.p === p && i.compact === compact)!;
    expect(by('measured', false)).toMatchObject({
      role: 'img',
      aria: 'Measured: directly observed and catalogued',
      border: 'solid',
      text: 'Measured',
      glyph: 'currentColor|0',
    });
    expect(by('inferred', false)).toMatchObject({
      role: 'img',
      aria: /^Inferred: not observed directly/,
      border: 'dashed',
      text: 'Inferred',
      glyph: 'none|1',
    });
    expect(by('generated', false)).toMatchObject({
      role: 'img',
      aria: /^Generated: plausible fill/,
      border: 'dotted',
      text: 'Generated',
      glyph: 'none|0',
    });
    // Three distinct border styles and glyphs, so colour is never the only cue.
    expect(new Set(info.filter((i) => !i.compact).map((i) => i.border)).size).toBe(3);
    expect(new Set(info.filter((i) => !i.compact).map((i) => i.glyph)).size).toBe(3);
    // Full badges show their label; compact ones keep it for screen readers only.
    for (const i of info) expect(i.compact ? i.labelWidth <= 1 : i.labelWidth > 20).toBe(true);
    for (const p of ['measured', 'inferred', 'generated']) expect(by(p, true).border).toBe(by(p, false).border);
    await expect(page.getByRole('img', { name: 'Measured: directly observed and catalogued' }).first()).toBeVisible();
    await page.locator('.lab-badges').screenshot({ path: `${SHOTS}/badges.png` });
  });

  test('take their colours from the palette tokens', async ({ page }) => {
    await open(page, 'colorblind=deuteranopia');
    const colors = await page.evaluate(() =>
      ['measured', 'inferred', 'generated'].map(
        (p) => getComputedStyle(document.querySelector(`.lab-badges .ks-badge--${p}`)!).color,
      ),
    );
    expect(colors).toEqual(['rgb(86, 180, 233)', 'rgb(240, 228, 66)', 'rgb(0, 168, 122)']);
  });
});

test.describe('discovery and toasts', () => {
  test('discover() unlocks an entry once, shows a toast, opens it from the toast and persists', async ({ page }) => {
    const errors = await open(page);
    expect(await discover(page, 'trappist-1e')).toBe(true);
    const toast = page.locator('.ks-cx-toast');
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText('Codex entry unlocked: TRAPPIST-1 e');
    await expect(page.getByRole('region', { name: 'Codex notifications' })).toHaveAttribute('aria-live', 'polite');
    expect(await toast.evaluate((el) => getComputedStyle(el).animationName)).toBe('ks-cx-toast-in');
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/toast.png` });
    expect(await discover(page, 'trappist-1e')).toBe(false);
    await expect(toast).toHaveCount(1);

    await toast.getByRole('button', { name: 'View TRAPPIST-1 e in the Codex' }).click();
    await expect(codex(page)).toBeVisible();
    await expect(entryTitle(page)).toHaveText('TRAPPIST-1 e');
    await expect(page.locator('.ks-cx-when')).toHaveText('Discovered just now');
    await expect(page.getByRole('tab', { name: /Exoplanets/ })).toHaveAttribute('aria-selected', 'true');
    await expect(toast).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Progress survives a reload (without the lab's reset parameter).
    await page.goto('/codex.html?source=fixtures');
    await page.waitForFunction(() => (window as unknown as { __ksCodex?: unknown }).__ksCodex !== undefined);
    expect(await discovered(page, 'trappist-1e')).toBe(true);
    expect(await page.evaluate(() => (window as unknown as HookWindow).__ksCodex.store.log().map((r) => r.id))).toEqual(
      ['trappist-1e'],
    );
    await expect(page.locator('.ks-cx-toast')).toHaveCount(0); // old discoveries are not announced again
    expect(errors).toEqual([]);
  });

  test('toasts fade without sliding under reduced motion, and wait while a dialog is open', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await discover(page, 'moon');
    const toast = page.locator('.ks-cx-toast');
    await expect(toast).toHaveClass(/is-still/);
    expect(await toast.evaluate((el) => getComputedStyle(el).animationName)).toBe('ks-cx-toast-fade');
    await expect(toast.locator('.ks-cx-toast-timer')).toHaveCount(0);
    await toast.getByRole('button', { name: 'Dismiss' }).click();
    await expect(toast).toHaveCount(0);

    // While the Codex is open, a new toast waits until it closes; the open Codex updates live.
    await page.keyboard.press('KeyC');
    await expect(codex(page)).toBeVisible();
    await expect(entryTitle(page)).toHaveText('Moon'); // opens on the newest unseen discovery
    await discover(page, 'proxima-centauri');
    await expect(page.getByRole('tab', { name: /Stars.*2 of 3 discovered.*includes new entries/ })).toBeVisible();
    await expect(toast).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText('Proxima Centauri');
  });

  test('the game setting data-reduced-motion also stops the slide', async ({ page }) => {
    await open(page, 'reduced=1');
    await discover(page, 'moon');
    expect(await page.locator('.ks-cx-toast').evaluate((el) => getComputedStyle(el).animationName)).toBe(
      'ks-cx-toast-fade',
    );
  });
});

test.describe('input and layout', () => {
  test('gamepad: D-pad moves, RB switches category, A opens, B goes back and closes', async ({ page }) => {
    await page.addInitScript(() => {
      const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
      const pad = {
        id: 'test pad',
        index: 0,
        connected: true,
        mapping: 'standard',
        axes: [0, 0, 0, 0],
        buttons,
        timestamp: 0,
      };
      (window as unknown as { __pad: typeof pad }).__pad = pad;
      Object.defineProperty(navigator, 'getGamepads', { value: () => [pad] });
    });
    await open(page, 'open=codex');
    const press = async (b: number): Promise<void> => {
      await page.evaluate(
        (i) => ((window as unknown as { __pad: { buttons: { pressed: boolean }[] } }).__pad.buttons[i]!.pressed = true),
        b,
      );
      await page.waitForTimeout(300);
      await page.evaluate(
        (i) =>
          ((window as unknown as { __pad: { buttons: { pressed: boolean }[] } }).__pad.buttons[i]!.pressed = false),
        b,
      );
      await page.waitForTimeout(250);
    };
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeFocused();
    await expect(entryTitle(page)).toHaveText('Sun');
    await press(13); // D-pad down
    await expect(entryTitle(page)).toHaveText('Not yet discovered');
    await expect(codex(page)).toHaveAttribute('data-input', 'pad');
    await press(5); // RB: next category
    await expect(page.getByRole('tab', { name: /Exoplanets/ })).toHaveAttribute('aria-selected', 'true');
    await press(4); // LB: back
    await press(4);
    await expect(page.getByRole('tab', { name: /Bodies/ })).toHaveAttribute('aria-selected', 'true');
    await expect(entryTitle(page)).toHaveText('Earth');
    await press(0); // A: into the entry
    await expect(entryTitle(page)).toBeFocused();
    await press(13);
    await expect(page.getByRole('button', { name: 'How do we know this?' })).toBeFocused();
    await press(0); // A: press it
    await expect(hwk(page)).toBeVisible();
    await press(1); // B: close the dialog
    await expect(hwk(page)).toBeHidden();
    await press(1); // B: back to the list
    await expect(listbox).toBeFocused();
    await press(1); // B: close
    await expect(codex(page)).toBeHidden();
  });

  test('large text switches to one pane at a time and never scrolls sideways', async ({ page }) => {
    const errors = await open(page, 'textScale=2&open=codex&entry=earth');
    await expect(codex(page)).toHaveAttribute('data-view', 'entry');
    const back = page.getByRole('button', { name: 'Back to list' });
    await expect(back).toBeVisible();
    await expect(page.getByRole('listbox')).toBeHidden();
    const fits = () =>
      page.evaluate(() => {
        const r = document.querySelector('.ks-cx-frame')!.getBoundingClientRect();
        return document.documentElement.scrollWidth <= innerWidth && r.left >= 0 && r.right <= innerWidth;
      });
    expect(await fits()).toBe(true);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/panel-text-2x.png` });
    await page.keyboard.press('Escape'); // back to the list first
    await expect(codex(page)).toHaveAttribute('data-view', 'list');
    await expect(page.getByRole('listbox')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(entryTitle(page)).toBeFocused();
    await back.click();
    await expect(page.getByRole('listbox')).toBeFocused();
    expect(await fits()).toBe(true);
    await page.keyboard.press('Escape');
    await expect(codex(page)).toBeHidden();

    await page.goto('/codex.html?reset=1&source=fixtures&textScale=0.8&open=codex&entry=earth');
    await page.waitForFunction(() => (window as unknown as { __ksCodex?: unknown }).__ksCodex !== undefined);
    await expect(page.getByRole('button', { name: 'Back to list' })).toBeHidden();
    await expect(page.getByRole('listbox')).toBeVisible();
    expect(await fits()).toBe(true);
    expect(errors).toEqual([]);
  });

  test('high-contrast palette', async ({ page }) => {
    await open(page, 'colorblind=high-contrast&open=codex&entry=earth');
    const border = await page.locator('.ks-cx-frame').evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(border).toBe('2px');
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/panel-high-contrast.png` });
  });
});
