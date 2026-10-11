/**
 * Settings, input and captions on ui.html (DOM only, no WebGPU canvas, so page screenshots work).
 * Screenshots of the panel are written to test-results/ui-shots/ for visual review.
 */
import { test, expect, type Page } from '@playwright/test';
import { ACTIONS } from '../../src/game/input/actions';

const SHOTS = 'test-results/ui-shots';

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/ui.html?reset=1${query ? `&${query}` : ''}`);
  await page.waitForFunction(() => (window as unknown as { __ks?: unknown }).__ks !== undefined);
}

const dialog = (page: Page) => page.locator('dialog.ks-settings');
const slot = (page: Page, action: string, n: 0 | 1) => page.locator(`.ks-slot[data-action="${action}"][data-slot="${n}"]`);

async function binding(page: Page, ctx: 'bindings' | 'padBindings', action: string, n: 0 | 1): Promise<unknown> {
  return page.evaluate(
    ([c, a, i]) => (window as unknown as { __ks: { settings: { data: Record<string, Record<string, unknown[]>> } } }).__ks.settings.data[c]![a]![i],
    [ctx, action, n] as const,
  );
}

test.describe('settings panel', () => {
  test('Escape opens a modal dialog with tabs, and closes it again', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute('role', 'dialog');
    await expect(dialog(page)).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(4);
    await expect(page.getByRole('tab', { name: 'Controls' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Controls' })).toBeFocused();
    await expect(page.getByRole('tabpanel', { name: 'Controls' })).toBeVisible();
    // Every action is listed with two slots.
    const actions = await page.evaluate(() => document.querySelectorAll('.ks-bind').length);
    expect(actions).toBe(ACTIONS.length);
    await expect(page.locator('.ks-slot')).toHaveCount(ACTIONS.length * 2);
    await page.screenshot({ path: `${SHOTS}/panel-normal.png` });

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    // The Escape that closed the menu must not reopen it on the next frame.
    await page.waitForTimeout(300);
    await expect(dialog(page)).toBeHidden();
  });

  test('rebinds an action from the keyboard, cancels with Escape and warns about conflicts', async ({ page }) => {
    await open(page, 'open=controls');
    const map = slot(page, 'toggleMap', 0);
    await map.focus();
    await page.keyboard.press('Enter');
    await expect(map).toHaveClass(/is-listening/);
    await expect(map).toContainText('Press a key');
    await page.keyboard.press('KeyO');
    await expect(map).not.toHaveClass(/is-listening/);
    await expect(map.locator('kbd')).toHaveText('O');
    expect(await binding(page, 'bindings', 'toggleMap', 0)).toEqual({ type: 'key', code: 'KeyO' });
    await expect(page.locator('.ks-settings [role="status"][aria-live="polite"]').last()).toHaveText('Map bound to O.');
    await expect(map).toBeFocused();

    // Escape cancels a capture and leaves the dialog open.
    await page.keyboard.press('Enter');
    await expect(map).toHaveClass(/is-listening/);
    await page.keyboard.press('Escape');
    await expect(map).not.toHaveClass(/is-listening/);
    await expect(dialog(page)).toBeVisible();
    expect(await binding(page, 'bindings', 'toggleMap', 0)).toEqual({ type: 'key', code: 'KeyO' });

    // Axis actions take two keys: negative, then positive.
    const roll = slot(page, 'roll', 1);
    await roll.click();
    await expect(roll).toContainText('Roll left');
    await page.keyboard.press('Digit9');
    await expect(roll).toContainText('Roll right');
    await page.keyboard.press('Digit0');
    await expect(roll.locator('kbd')).toHaveText(['9', '0']);

    // Binding a key another action uses is allowed but flagged.
    await slot(page, 'toggleCodex', 1).click();
    await page.keyboard.press('KeyW');
    await expect(page.locator('.ks-banner-warn')).toBeVisible();
    await expect(page.locator('.ks-bind[data-action="toggleCodex"]')).toHaveClass(/is-conflict/);
    await expect(page.locator('.ks-bind[data-action="thrust"]')).toHaveClass(/is-conflict/);
    await expect(page.locator('.ks-bind[data-action="toggleCodex"] .ks-bind-warn')).toContainText('Thrust');

    // Clearing with Delete resolves it; reset needs a second press.
    await slot(page, 'toggleCodex', 1).focus();
    await page.keyboard.press('Delete');
    await expect(page.locator('.ks-banner-warn')).toBeHidden();
    const reset = page.locator('.ks-reset');
    await reset.click();
    await expect(reset).toHaveClass(/is-armed/);
    await reset.click();
    expect(await binding(page, 'bindings', 'toggleMap', 0)).toEqual({ type: 'key', code: 'KeyM' });

    // Mouse buttons are captured by clicking the listening slot itself; the context menu stays closed.
    const shot = slot(page, 'screenshot', 1);
    await shot.click();
    await shot.click({ button: 'right' });
    expect(await binding(page, 'bindings', 'screenshot', 1)).toEqual({ type: 'mouseButton', button: 2 });
    await expect(shot).toContainText('Mouse R');
    // Clicking elsewhere cancels a capture.
    await slot(page, 'share', 1).click();
    await expect(slot(page, 'share', 1)).toHaveClass(/is-listening/);
    await page.locator('.ks-binds-head').click({ force: true });
    await expect(slot(page, 'share', 1)).not.toHaveClass(/is-listening/);
    expect(await binding(page, 'bindings', 'share', 1)).toBeNull();

    // Escape stays fixed on the pause action.
    await slot(page, 'pause', 0).click({ force: true }); // aria-disabled, but still announces why
    await expect(slot(page, 'pause', 0)).not.toHaveClass(/is-listening/);
    expect(await binding(page, 'bindings', 'pause', 0)).toEqual({ type: 'key', code: 'Escape' });
  });

  test('the new binding drives the game once the menu closes', async ({ page }) => {
    await open(page, 'open=controls');
    await slot(page, 'toggleMap', 0).click();
    await page.keyboard.press('KeyO');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await page.keyboard.press('KeyO');
    await expect(page.locator('.lab-log li').first()).toHaveText('Map');
  });

  test('text size slider rescales the root font', async ({ page }) => {
    await open(page, 'open=accessibility');
    const root = () => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    expect(await root()).toBe('16px');
    const slider = page.getByRole('slider', { name: 'Text size' });
    // Dragging previews the size in the sample only; the interface rescales when the thumb is released.
    const box = (await slider.boundingBox())!;
    const thumbX = box.x + box.width * ((100 - 80) / 120);
    await page.mouse.move(thumbX, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 5 });
    expect(await root()).toBe('16px');
    const previewScale = await page.locator('.ks-preview').evaluate((el) => Number(getComputedStyle(el).getPropertyValue('--ks-preview-scale')));
    expect(previewScale).toBeGreaterThan(1.2);
    await page.mouse.up();
    await expect.poll(root).not.toBe('16px');
    await slider.focus();
    await page.keyboard.press('End');
    await expect.poll(root).toBe('32px');
    await expect(slider).toHaveAttribute('aria-valuetext', '200%');
    expect(await page.evaluate(() => (window as unknown as { __ks: { settings: { data: { textScale: number } } } }).__ks.settings.data.textScale)).toBe(2);
    await page.screenshot({ path: `${SHOTS}/panel-text200-accessibility.png` });
    await page.getByRole('tab', { name: 'Controls' }).click();
    await page.screenshot({ path: `${SHOTS}/panel-text200-controls.png` });
    await page.getByRole('tab', { name: 'Accessibility' }).click();
    await slider.focus();
    await page.keyboard.press('Home');
    await expect.poll(root).toBe('12.8px');
    await page.keyboard.press('ArrowRight');
    await expect.poll(root).toBe('13.6px');
    // Persisted for the next visit.
    await page.goto('/ui.html');
    await page.waitForFunction(() => (window as unknown as { __ks?: unknown }).__ks !== undefined);
    expect(await root()).toBe('13.6px');
  });

  test('colour-blind modes switch the palette tokens', async ({ page }) => {
    await open(page, 'open=accessibility');
    const token = (name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
    expect(await page.evaluate(() => document.documentElement.dataset['colorblind'])).toBe('none');
    expect(await token('--ks-measured')).toBe('#7fd4ff');
    await page.locator('.ks-choice[data-value="deuteranopia"]').click();
    await expect(page.getByRole('radio', { name: /Deuteranopia/ })).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-colorblind', 'deuteranopia');
    expect(await token('--ks-generated')).toBe('#00a87a');
    // Live swatches render each card in its own palette, whatever the active mode.
    const chip = (mode: string) =>
      page.evaluate((m) => getComputedStyle(document.querySelector(`.ks-swatches[data-colorblind="${m}"] .ks-chip-generated`)!).color, mode);
    expect(await chip('tritanopia')).toBe('rgb(242, 85, 154)');
    expect(await chip('none')).toBe('rgb(196, 155, 255)');
    await page.locator('.ks-choice[data-value="high-contrast"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-colorblind', 'high-contrast');
    expect(await token('--ks-fg')).toBe('#ffffff');
    expect(await token('--ks-border-w')).toBe('2px');
    await page.getByRole('tab', { name: 'Controls' }).click();
    await page.screenshot({ path: `${SHOTS}/panel-high-contrast-controls.png` });
    await page.getByRole('tab', { name: 'Accessibility' }).click();
    await page.evaluate(() => document.querySelector('.ks-pane:not([hidden])')!.scrollTo(0, 330));
    await page.screenshot({ path: `${SHOTS}/panel-high-contrast-accessibility.png` });
    // Reduced motion reaches the document too.
    await page.locator('label.ks-switch[for$="-motion"]').click();
    await expect(page.getByRole('switch', { name: 'Reduce motion' })).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
  });

  test('is fully keyboard operable: focus trap, tabs and focus return', async ({ page }) => {
    await open(page);
    const opener = page.locator('#lab-open');
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    const inDialog = () => page.evaluate(() => document.querySelector('dialog.ks-settings')!.contains(document.activeElement));
    // Tab cycles inside the dialog.
    for (let i = 0; i < 70; i++) {
      await page.keyboard.press('Tab');
      expect(await inDialog()).toBe(true);
    }
    // Shift+Tab from the first control (Resume) wraps to the last binding slot, and Tab wraps back.
    const resume = page.getByRole('button', { name: 'Close settings and resume' });
    await resume.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(slot(page, 'pause', 1)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(resume).toBeFocused();
    // Arrow keys move between tabs (automatic activation), Home/End jump.
    await page.getByRole('tab', { name: 'Controls' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('tab', { name: 'Accessibility' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Accessibility' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Accessibility' })).toBeVisible();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Graphics' })).toHaveAttribute('aria-selected', 'true');
    // Into the panel: radios move with arrows, switches toggle with Space.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('radio', { name: /Auto/ })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: /Low/ })).toBeChecked();
    expect(await page.evaluate(() => (window as unknown as { __ks: { settings: { data: { quality: string } } } }).__ks.settings.data.quality)).toBe('low');
    const fps = page.getByRole('switch', { name: 'Show frame rate' });
    await fps.focus();
    await page.keyboard.press('Space');
    await expect(fps).toBeChecked();
    // Focus is visibly marked.
    const outline = await fps.evaluate((el) => getComputedStyle(el.parentElement!.querySelector('.ks-switch-track')!).outlineStyle);
    expect(outline).toBe('solid');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('gamepad opens, navigates and closes the menu', async ({ page }) => {
    await page.addInitScript(() => {
      const pad = {
        id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
        index: 0,
        connected: true,
        mapping: 'standard',
        timestamp: 0,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
      };
      (window as unknown as { __pad: typeof pad }).__pad = pad;
      Object.defineProperty(navigator, 'getGamepads', { value: () => [pad] });
    });
    await open(page);
    const tap = async (b: number): Promise<void> => {
      await page.evaluate((i) => ((window as unknown as { __pad: { buttons: unknown[] } }).__pad.buttons[i] = { pressed: true, touched: true, value: 1 }), b);
      await page.waitForTimeout(120);
      await page.evaluate((i) => ((window as unknown as { __pad: { buttons: unknown[] } }).__pad.buttons[i] = { pressed: false, touched: false, value: 0 }), b);
      await page.waitForTimeout(120);
    };
    await tap(9); // Menu
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute('data-input', 'pad');
    await expect(page.getByRole('radio', { name: 'Gamepad' })).toBeChecked(); // opens on the device in use
    await expect(page.locator('.ks-slot[data-action="pause"][data-slot="0"] kbd')).toHaveText('Menu');
    await tap(13); // D-pad down: next tab button
    await expect(page.getByRole('tab', { name: 'Accessibility' })).toBeFocused();
    await tap(0); // A
    await expect(page.getByRole('tab', { name: 'Accessibility' })).toHaveAttribute('aria-selected', 'true');
    await tap(5); // RB
    await expect(page.getByRole('tab', { name: 'Audio' })).toHaveAttribute('aria-selected', 'true');
    await tap(15); // D-pad right: into the panel, onto the nearest volume slider
    const focusedSlider = () => page.evaluate(() => (document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'range' ? document.activeElement.getAttribute('aria-valuetext') : null));
    await expect.poll(focusedSlider).not.toBeNull();
    const before = Number((await focusedSlider())!.replace('%', ''));
    await tap(15); // right on a slider adjusts it
    await expect.poll(focusedSlider).toBe(`${before + 1}%`);
    await tap(12); // D-pad up moves between sliders
    await tap(14); // left on a slider adjusts it back down
    await expect(page.locator('.ks-pane-audio :focus')).toHaveCount(1);
    await tap(1); // B closes
    await expect(dialog(page)).toBeHidden();
  });
});

test.describe('captions', () => {
  test('appear bottom-centre, de-duplicate, cap at three lines and follow the subtitles setting', async ({ page }) => {
    await open(page);
    const region = page.locator('.ks-captions');
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await page.locator('#lab-caption').click();
    await expect(region.locator('.ks-caption')).toHaveText(['[Soft chime]']);
    const box = await region.locator('.ks-caption').boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x + box!.width / 2 - 400)).toBeLessThan(2);
    expect(box!.y).toBeGreaterThan(300);
    const show = (text: string) =>
      page.evaluate((s) => (window as unknown as { __ks: { captions: { show(k: string, d: number): void } } }).__ks.captions.show(s, 10), text);
    await show('settings.demo.captionA'); // same text again: counted, not stacked
    await expect(region.locator('.ks-caption')).toHaveCount(1);
    await expect(region.locator('.ks-caption-count')).toHaveText('×2');
    await show('settings.demo.captionB');
    await show('settings.demo.captionC');
    await show('Navigator: course plotted.');
    await expect(region.locator('.ks-caption-text')).toHaveText(['[Attitude jets hiss]', '[Hull creaks as the ship turns]', 'Navigator: course plotted.']);
    await page.waitForTimeout(400); // let the fade-in finish
    await page.screenshot({ path: `${SHOTS}/captions.png` });
    // Size follows the caption size setting.
    const size = () => region.locator('.ks-caption').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const medium = await size();
    await page.evaluate(() => (window as unknown as { __ks: { settings: { set(p: object): void } } }).__ks.settings.set({ captionSize: 'large' }));
    expect(await size()).toBeGreaterThan(medium);
    await page.evaluate(() => (window as unknown as { __ks: { settings: { set(p: object): void } } }).__ks.settings.set({ subtitles: false }));
    await expect(region).toBeHidden();
    await show('settings.demo.captionA');
    await expect(region.locator('.ks-caption')).toHaveCount(0);
  });
});
