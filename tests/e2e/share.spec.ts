/**
 * Shareable coordinates and screenshot mode. Most tests use share.html, a DOM-only lab: a 2D canvas stands in for the
 * renderer, so page screenshots work, and the controller runs with the real Settings, InputManager and SettingsPanel.
 * The last group boots the real game (index.html, WebGPU on SwiftShader) and plays it from the keyboard. Review images
 * go to test-results/share-shots/.
 */
import { test, expect, type Download, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { findShareInPng, readPngText } from '../../src/game/share/pngText';
import { decodeShare, encodeShare, type ShareState } from '../../src/game/share/shareLink';

const SHOTS = 'test-results/share-shots';
mkdirSync(SHOTS, { recursive: true });

test.use({ viewport: { width: 1280, height: 720 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });

interface LabState {
  anchor: string;
  offset: [number, number, number];
  quat: [number, number, number, number];
  timeMs: number;
  target: string | null;
  mode: string;
}

interface LabKs {
  boot: Promise<string>;
  outcome(): string | null;
  state(): LabState;
  setPlace(name: string): void;
  rawFrame(): string;
  input: { setBinding(id: string, slot: 0 | 1, b: unknown): boolean; axis(id: string): number };
  share: { screenshot: { active: boolean } };
}

interface Box {
  x: number;
  y: number;
  right: number;
  bottom: number;
}

/** The element's border box, or null when it is not rendered. */
async function box(page: Page, selector: string): Promise<Box | null> {
  return page.evaluate((sel) => {
    const e = document.querySelector(sel);
    if (!e || e.getClientRects().length === 0) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
  }, selector);
}

const intersects = (a: Box, b: Box): boolean => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

/** True when a click at the centre of `selector` lands on that element (nothing covers it). */
async function hittable(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const e = document.querySelector(sel)!;
    const r = e.getBoundingClientRect();
    return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }, selector);
}

async function open(page: Page, path = '/share.html?reset=1', errors: string[] = []): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // The dev server has no favicon; anything else logged as an error is a failure.
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
  });
  await page.goto(path);
  await page.waitForFunction(() => (window as unknown as { __ks?: unknown }).__ks !== undefined);
  await page.evaluate(() => (window as unknown as { __ks: LabKs }).__ks.boot);
}

const labState = (page: Page): Promise<LabState> => page.evaluate(() => (window as unknown as { __ks: LabKs }).__ks.state());
const toast = (page: Page) => page.locator('.ks-toasts .ks-toast').last();

/** Quaternion (x, y, z, w) of a camera whose -Z axis looks along `fwd` with +Y toward `up`. */
function lookAt(fwd: [number, number, number], up: [number, number, number]): [number, number, number, number] {
  const n = (v: number[]): number[] => v.map((c) => c / Math.hypot(...v));
  const cross = (a: number[], b: number[]): number[] => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const z = n(fwd.map((c) => -c));
  const x = n(cross(up, z));
  const y = cross(z, x);
  const [m00, m10, m20] = x as [number, number, number];
  const [m01, m11, m21] = y as [number, number, number];
  const [m02, m12, m22] = z as [number, number, number];
  const tr = m00 + m11 + m22;
  let q: number[];
  if (tr > 0) {
    const k = 0.5 / Math.sqrt(tr + 1);
    q = [(m21 - m12) * k, (m02 - m20) * k, (m10 - m01) * k, 0.25 / k];
  } else if (m00 > m11 && m00 > m22) {
    const k = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * k, (m01 + m10) / k, (m02 + m20) / k, (m21 - m12) / k];
  } else if (m11 > m22) {
    const k = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / k, 0.25 * k, (m12 + m21) / k, (m02 - m20) / k];
  } else {
    const k = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / k, (m12 + m21) / k, 0.25 * k, (m10 - m01) / k];
  }
  return n(q) as [number, number, number, number];
}

function expectSameView(a: LabState, b: LabState): void {
  expect(b.anchor).toBe(a.anchor);
  for (let k = 0; k < 3; k++) expect(Object.is(b.offset[k], a.offset[k]), `offset ${k}`).toBe(true);
  for (let k = 0; k < 4; k++) expect(Math.abs(b.quat[k]! - a.quat[k]!)).toBeLessThan(1e-6);
  expect(b.timeMs).toBe(a.timeMs);
  expect(b.target).toBe(a.target);
  expect(b.mode).toBe(a.mode);
}

async function savePng(download: Download, name: string): Promise<Buffer> {
  const path = await download.path();
  const bytes = readFileSync(path);
  writeFileSync(`${SHOTS}/${name}`, bytes);
  return bytes;
}

/** PNG width and height from the IHDR chunk. */
function pngSize(bytes: Buffer): [number, number] {
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

/**
 * Mean absolute RGB difference (0-255) between a PNG and the raw stand-in frame, in the bottom 14% and the top half.
 * The caption darkens and writes over the bottom band only.
 */
async function captionDiff(page: Page, png: Buffer): Promise<{ bottom: number; top: number }> {
  return page.evaluate(async (b64) => {
    const load = async (src: string): Promise<ImageData> => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, c.width, c.height);
    };
    const shot = await load(`data:image/png;base64,${b64}`);
    const raw = await load((window as unknown as { __ks: LabKs }).__ks.rawFrame());
    const band = (y0: number, y1: number): number => {
      let sum = 0;
      let n = 0;
      for (let y = Math.floor(y0); y < Math.floor(y1); y += 2) {
        for (let x = 0; x < shot.width; x += 2) {
          const i = (y * shot.width + x) * 4;
          sum += Math.abs(shot.data[i]! - raw.data[i]!) + Math.abs(shot.data[i + 1]! - raw.data[i + 1]!) + Math.abs(shot.data[i + 2]! - raw.data[i + 2]!);
          n += 3;
        }
      }
      return sum / n;
    };
    return { bottom: band(shot.height * 0.86, shot.height), top: band(0, shot.height * 0.5) };
  }, png.toString('base64'));
}

test.describe('location links', () => {
  test('a copied link reproduces the view exactly in a fresh page', async ({ page, context }) => {
    const errors: string[] = [];
    await open(page, '/share.html?reset=1', errors);
    await page.click('[data-place="moon"]');
    const before = await labState(page);
    await page.keyboard.press('KeyK');
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('Location link copied');
    await expect(toast(page)).toContainText('2026-10-11 14:03:12 UTC');
    const region = page.locator('.ks-toasts');
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await expect(region).toHaveAttribute('aria-atomic', 'true');
    await page.screenshot({ path: `${SHOTS}/toast-link.png` });

    const url = await page.evaluate(() => navigator.clipboard.readText());
    // The link names the page only: the sharer's query parameters (here reset=1, which would wipe the recipient's
    // settings) never travel with it (review finding).
    expect(url).toMatch(/\/share\.html#ks1\.[A-Za-z0-9_-]+$/);
    // The clipboard took it, so the address bar is left alone (review finding: it would keep a place left behind).
    expect(await page.evaluate(() => location.href)).not.toContain('#');
    // The fragment decodes (outside the page) to the exact view.
    const decoded = decodeShare(new URL(url).hash)!;
    expect(decoded.anchor).toBe('301');
    for (let k = 0; k < 3; k++) expect(Object.is(decoded.offset[k], before.offset[k])).toBe(true);
    expect(decoded).toMatchObject({ timeMs: before.timeMs, target: '399', mode: 'impulse', fovDeg: 60 });

    const fresh = await context.newPage();
    await open(fresh, url, errors);
    expect(await fresh.evaluate(() => (window as unknown as { __ks: LabKs }).__ks.outcome())).toBe('ok');
    expectSameView(before, await labState(fresh));
    await expect(toast(fresh).locator('.ks-toast-msg')).toHaveText('Arrived at a shared location');
    await expect(toast(fresh).locator('.ks-toast-detail')).toHaveText('Moon · 2026-10-11 14:03:12 UTC');
    // The link has been read and leaves the address bar, so a reload starts afresh and pasting it again works.
    expect(await fresh.evaluate(() => location.hash)).toBe('');
    await fresh.screenshot({ path: `${SHOTS}/arrived.png` });

    // Pasting a different link into the address bar while playing moves the view (hashchange).
    await page.click('[data-place="mars"]');
    const mars = await labState(page);
    await page.keyboard.press('KeyK');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe(url);
    const marsUrl = await page.evaluate(() => navigator.clipboard.readText());
    await fresh.evaluate((h) => (location.hash = h), new URL(marsUrl).hash);
    await expect.poll(async () => (await labState(fresh)).anchor).toBe('499');
    expectSameView(mars, await labState(fresh));
    expect(await fresh.evaluate(() => location.hash)).toBe('');
    expect(errors).toEqual([]);
  });

  test('a link pasted again in the same tab applies again (review finding)', async ({ page }) => {
    const errors: string[] = [];
    // No query: the copied link is this page plus a fragment, so following it is a same-document navigation.
    await open(page, '/share.html', errors);
    await page.click('[data-place="moon"]');
    const moon = await labState(page);
    await page.keyboard.press('KeyK');
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('Location link copied');
    const url = await page.evaluate(() => navigator.clipboard.readText());
    await page.click('[data-place="mars"]');
    expect((await labState(page)).anchor).toBe('499');
    // The reviewer's probe: navigating to the copied link in the tab that made it.
    await page.evaluate((u) => (location.href = u), url);
    await expect.poll(async () => (await labState(page)).anchor).toBe('301');
    expectSameView(moon, await labState(page));
    // And once more, after flying away again: the same link still applies.
    await page.click('[data-place="leo"]');
    await page.evaluate((u) => (location.href = u), url);
    await expect.poll(async () => (await labState(page)).anchor).toBe('301');
    expect(errors).toEqual([]);
  });

  test('when the clipboard refuses, the link goes into the address bar until a copy succeeds', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __clipOk: boolean; __copied: string };
      w.__clipOk = false;
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        get: () => ({ writeText: (text: string) => (w.__clipOk ? ((w.__copied = text), Promise.resolve()) : Promise.reject(new Error('denied'))) }),
        configurable: true,
      });
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      document.execCommand = () => false;
    });
    await open(page);
    await page.click('[data-place="mars"]');
    await page.keyboard.press('KeyK');
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('The clipboard is not available');
    await expect(toast(page).locator('.ks-toast-detail')).toHaveText('The link is in the address bar; copy it from there.');
    const address = await page.evaluate(() => location.href);
    expect(address).toMatch(/\/share\.html#ks1\./);
    expect(decodeShare(new URL(address).hash)?.anchor).toBe('499');
    // The fragment written there is not applied as if someone had pasted it (no hashchange, no arrival toast).
    await page.waitForTimeout(300);
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('The clipboard is not available');
    // Later the clipboard works: the stale link leaves the address bar.
    await page.evaluate(() => ((window as unknown as { __clipOk: boolean }).__clipOk = true));
    await page.click('[data-place="moon"]');
    await page.keyboard.press('KeyK');
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('Location link copied');
    expect(await page.evaluate(() => location.hash)).toBe('');
    expect(decodeShare(await page.evaluate(() => (window as unknown as { __copied: string }).__copied))?.anchor).toBe('301');
  });

  test('damaged, newer and unknown links are refused and explained', async ({ page }) => {
    await open(page, '/share.html?reset=1#ks1.AAAAAAAAAAAA');
    const home = await labState(page);
    expect(home.anchor).toBe('399');
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('This location link is damaged or incomplete');
    expect(await page.evaluate(() => location.hash)).toBe('');
    await page.screenshot({ path: `${SHOTS}/toast-damaged.png` });

    await open(page, '/share.html?reset=1#ks2.AAAA');
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('This link was made by a newer version of Known Sky');

    const unknown: ShareState = { v: 1, anchor: '799', offset: [3e7, 0, 0], quat: [0, 0, 0, 1], timeMs: Date.UTC(2027, 0, 1) };
    await open(page, `/share.html?reset=1#${encodeShare(unknown)}`);
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('This link points to a place this version of Known Sky does not know');
    expect((await labState(page)).anchor).toBe('399');

    // Outside the ephemeris window: the view moves, the time is clamped and the toast says so.
    const late: ShareState = { v: 1, anchor: '301', offset: [5e6, 1, 2], quat: [0, 0, 0, 1], timeMs: Date.UTC(2040, 0, 1) };
    await open(page, `/share.html?reset=1#${encodeShare(late)}`);
    await expect(toast(page).locator('.ks-toast-detail')).toHaveText(/ephemeris window/);
    const s = await labState(page);
    expect(s.anchor).toBe('301');
    expect(s.timeMs).toBe(Date.UTC(2032, 0, 1));

    // A fragment that is not a Known Sky link is left alone, silently.
    await open(page, '/share.html?reset=1#section-2');
    await page.waitForTimeout(300);
    await expect(page.locator('.ks-toast')).toHaveCount(0);
    expect(await page.evaluate(() => location.hash)).toBe('#section-2');
  });

  test('falls back to execCommand when the Clipboard API is missing', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true });
      document.addEventListener('copy', (e) => {
        (window as unknown as { __copied: string }).__copied = (e.target as HTMLTextAreaElement).value;
      });
    });
    await open(page);
    const copy = page.locator('.lab-actions [data-action="share"]');
    await copy.click();
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('Location link copied');
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied);
    expect(copied).toMatch(/#ks1\./);
    expect(decodeShare(copied!)?.anchor).toBe('399');
    expect(await page.evaluate(() => location.hash)).toBe('');
    // Focus returned to the button that was used.
    await expect(copy).toBeFocused();
  });
});

test.describe('screenshot mode', () => {
  test('hides the HUD, names the bound keys, and Escape leaves it without opening the pause menu', async ({ page }) => {
    const errors: string[] = [];
    await open(page, '/share.html?reset=1', errors);
    await expect(page.locator('.ks-hud')).toBeVisible();
    await page.keyboard.press('KeyP');
    await expect(page.locator('body')).toHaveClass(/ks-screenshot/);
    const overlay = page.getByRole('region', { name: 'Screenshot mode' });
    await expect(overlay).toBeVisible();
    await expect(page.locator('.ks-hud')).toBeHidden();
    await expect(page.locator('.lab-intro')).toBeHidden();
    await expect(page.locator('.ks-shot-capture kbd')).toHaveText('P');
    await expect(page.locator('.ks-shot-exit kbd')).toHaveText('Esc');
    const sw = page.getByRole('switch', { name: 'Caption' });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.ks-shot-announcer')).toHaveText('Screenshot mode. The HUD and cockpit are hidden. P captures, Esc exits.');
    await page.screenshot({ path: `${SHOTS}/screenshot-mode.png` });

    // Keyboard (review finding): Tab from the game view reaches the toolbar, although Tab is a flight binding (target
    // next); then the browser's own order applies, and Space on the switch toggles the caption.
    await expect(page.locator('body')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /^Capture/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(sw).toBeFocused();
    await page.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('.ks-shot-preview')).toBeHidden();
    await page.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /^Exit/ })).toBeFocused();
    // The toolbar stays while it has focus (the idle fade waits).
    await page.waitForTimeout(3500);
    await expect(page.locator('.ks-shot')).not.toHaveClass(/is-idle/);

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/ks-screenshot/);
    await expect(page.locator('.ks-hud')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.locator('dialog.ks-settings')).toBeHidden();
    await expect(page.locator('.ks-shot-announcer')).toHaveText('Screenshot mode closed.');
    // Outside screenshot mode Escape opens the pause menu as usual.
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.ks-settings')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.ks-settings')).toBeHidden();

    // Hints follow rebinding.
    await page.evaluate(() => (window as unknown as { __ks: LabKs }).__ks.input.setBinding('screenshot', 0, { type: 'key', code: 'KeyO' }));
    await page.waitForTimeout(100);
    await page.keyboard.press('KeyO');
    await expect(overlay).toBeVisible();
    await expect(page.locator('.ks-shot-capture kbd')).toHaveText('O');
    // Shift+Tab from the game view reaches the toolbar's last button.
    await page.locator('#c').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: /^Exit/ })).toBeFocused();
    await page.click('.ks-shot-exit');
    await expect(overlay).toBeHidden();

    // The overlay fades after a few idle seconds (not while hovered) and returns on pointer movement.
    await page.mouse.move(640, 420);
    await page.keyboard.press('KeyO');
    await expect(page.locator('.ks-shot')).toHaveClass(/is-idle/, { timeout: 6000 });
    await page.mouse.move(400, 300);
    await page.mouse.move(420, 310);
    await expect(page.locator('.ks-shot')).not.toHaveClass(/is-idle/);
    expect(errors).toEqual([]);
  });

  test('keys released over the toolbar do not stay held, and arrows still fly (review finding)', async ({ page }) => {
    await open(page);
    const axis = (id: string): Promise<number> => page.evaluate((a) => (window as unknown as { __ks: LabKs }).__ks.input.axis(a), id);
    await page.keyboard.press('KeyP');
    await expect(page.locator('.ks-shot')).toBeVisible();
    // The reviewer's probe: hold a turn key on the game view, click the caption switch, release the key.
    await page.keyboard.down('ArrowLeft');
    await expect.poll(() => axis('yaw')).toBe(-1);
    await page.getByRole('switch', { name: 'Caption' }).click();
    await expect(page.getByRole('switch', { name: 'Caption' })).toBeFocused();
    await page.keyboard.up('ArrowLeft');
    await expect.poll(() => axis('yaw')).toBe(0);
    // With a toolbar button focused, the arrow keys still steer (pitch has no other default key).
    await page.keyboard.down('ArrowUp');
    await expect.poll(() => axis('pitch')).toBe(1);
    await page.keyboard.up('ArrowUp');
    await expect.poll(() => axis('pitch')).toBe(0);
    // Leaving the mode with a key still held does not leave it stuck either.
    await page.keyboard.down('KeyD');
    await expect.poll(() => axis('yaw')).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.ks-shot')).toBeHidden();
    await page.keyboard.up('KeyD');
    await expect.poll(() => axis('yaw')).toBe(0);
  });

  test('toasts never cover the toolbar, at any window size or text scale (review finding)', async ({ page }) => {
    // The reviewer's sizes: 800x450 at text scale 2 and 390x844 at 1 and 2 overlapped; 1280x720 for reference.
    const cases: [number, number, number][] = [
      [1280, 720, 1],
      [800, 450, 2],
      [390, 844, 1],
      [390, 844, 2],
      [800, 450, 1.5],
    ];
    for (const [w, h, ts] of cases) {
      await page.setViewportSize({ width: w, height: h });
      await open(page, `/share.html?reset=1&textScale=${ts}`);
      await page.keyboard.press('KeyP');
      await expect(page.locator('.ks-shot')).toBeVisible();
      await page.keyboard.press('KeyK');
      await expect(toast(page).locator('.ks-toast-msg')).toHaveText('Location link copied');
      await page.mouse.move(w / 2, h / 2);
      const bar = await box(page, '.ks-shot-bar');
      const card = await box(page, '.ks-toasts .ks-toast');
      expect(bar, `${w}x${h} text ${ts}`).not.toBeNull();
      expect(card, `${w}x${h} text ${ts}`).not.toBeNull();
      expect(intersects(bar!, card!), `toast over toolbar at ${w}x${h}, text ${ts}`).toBe(false);
      expect(card!.right, `toast inside the window at ${w}x${h}, text ${ts}`).toBeLessThanOrEqual(w);
      for (const sel of ['.ks-shot-capture', '.ks-shot-switch', '.ks-shot-exit']) {
        expect(await hittable(page, sel), `${sel} clickable at ${w}x${h}, text ${ts}`).toBe(true);
      }
      await page.screenshot({ path: `${SHOTS}/toast-under-toolbar-${w}x${h}-ts${ts}.png` });
      // The reviewer's click on Exit now reaches it.
      await page.click('.ks-shot-exit');
      await expect(page.locator('.ks-shot')).toBeHidden();
    }
  });

  test('the viewfinder corners and sound captions keep clear of the caption preview (review findings)', async ({ page }) => {
    const cases: [number, number, number][] = [
      [1280, 720, 1.5],
      [390, 844, 1],
      [800, 450, 2],
    ];
    for (const [w, h, ts] of cases) {
      await page.setViewportSize({ width: w, height: h });
      await open(page, `/share.html?reset=1&reducedMotion=1&textScale=${ts}`);
      await page.keyboard.press('KeyP');
      await expect(page.locator('.ks-shot')).toBeVisible();
      await page.evaluate(() => (window as unknown as { __ks: { captions: { show(k: string, s: number): void } } }).__ks.captions.show('audio.caption.engineStart', 30));
      const captionTop = await page.evaluate(() => innerHeight - parseFloat(getComputedStyle(document.body).getPropertyValue('--ks-shot-caption-h')));
      expect(captionTop, `${w}x${h} text ${ts}`).toBeGreaterThan(h / 3);
      const corners = await page.evaluate(() => [...document.querySelectorAll('.ks-shot-frame i')].map((e) => e.getBoundingClientRect().bottom));
      for (const b of corners) expect(b, `corner above the caption at ${w}x${h}, text ${ts}`).toBeLessThanOrEqual(captionTop);
      // Sound captions stay visible (the image never contains DOM) and sit above the caption preview.
      const line = page.locator('.ks-captions .ks-caption').first();
      await expect(line).toBeVisible();
      expect(await page.locator('.ks-captions').evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
      const sound = await box(page, '.ks-captions');
      expect(sound!.bottom, `sound caption above the caption preview at ${w}x${h}, text ${ts}`).toBeLessThanOrEqual(captionTop);
      await page.screenshot({ path: `${SHOTS}/corners-captions-${w}x${h}-ts${ts}.png` });
      // Caption off: the corners return to the frame's edge.
      await page.getByRole('switch', { name: 'Caption' }).click();
      await expect.poll(() => page.evaluate(() => Math.max(...[...document.querySelectorAll('.ks-shot-frame i')].map((e) => e.getBoundingClientRect().bottom)))).toBeGreaterThan(h - 40);
      await page.keyboard.press('Escape');
    }
  });

  test('captures a PNG at native resolution with the caption and the link, or without the caption', async ({ page }) => {
    const errors: string[] = [];
    await open(page, '/share.html?reset=1', errors);
    await page.click('[data-place="leo"]');
    const state = await labState(page);
    await page.keyboard.press('KeyP');
    await expect(page.locator('.ks-shot')).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('KeyP')]);
    expect(dl.suggestedFilename()).toMatch(/^knownsky-\d{8}-\d{6}\.png$/);
    const png = await savePng(dl, 'capture-caption.png');
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    const canvasSize = await page.evaluate(() => [document.querySelector('canvas')!.width, document.querySelector('canvas')!.height]);
    expect(pngSize(png)).toEqual(canvasSize);
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('Screenshot saved');
    await expect(toast(page).locator('.ks-toast-detail')).toHaveText(dl.suggestedFilename());
    await page.screenshot({ path: `${SHOTS}/toast-saved.png` });

    // The image carries the link (PNG iTXt), which decodes to the captured view.
    const token = findShareInPng(new Uint8Array(png));
    expect(token).not.toBeNull();
    const fromImage = decodeShare(`#${token!}`)!;
    expect(fromImage.anchor).toBe(state.anchor);
    for (let k = 0; k < 3; k++) expect(Object.is(fromImage.offset[k], state.offset[k])).toBe(true);
    const text = Object.fromEntries(readPngText(new Uint8Array(png)).map((e) => [e.keyword, e.text]));
    expect(text['Software']).toBe('Known Sky');
    expect(text['Title']).toBe('Earth · 420 km above the surface');
    expect(text['Description']).toContain('Some surface detail is Generated');

    // The caption changes the bottom band only.
    const withCaption = await captionDiff(page, png);
    expect(withCaption.bottom).toBeGreaterThan(4);
    expect(withCaption.top).toBeLessThan(0.5);

    // Without the caption the image is the frame itself.
    await page.getByRole('switch', { name: 'Caption' }).click();
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^Capture/ }).click()]);
    const bare = await savePng(dl2, 'capture-bare.png');
    const without = await captionDiff(page, bare);
    expect(without.bottom).toBeLessThan(0.5);
    expect(findShareInPng(new Uint8Array(bare))).toBe(token);
    expect(errors).toEqual([]);
  });

  test('dropping a Known Sky screenshot goes to the place it shows', async ({ page }) => {
    await open(page);
    await page.click('[data-place="mars"]');
    const mars = await labState(page);
    await page.keyboard.press('KeyP');
    await expect(page.locator('.ks-shot')).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('KeyP')]);
    const png = readFileSync(await dl.path());
    await page.keyboard.press('Escape');
    await page.click('[data-place="leo"]');
    expect((await labState(page)).anchor).toBe('399');

    const drop = async (b64: string, name: string): Promise<void> => {
      await page.evaluate(
        ([data, n]) => {
          const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bytes], n, { type: 'image/png' }));
          window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, cancelable: true }));
          window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
        },
        [b64, name] as const,
      );
    };
    await drop(png.toString('base64'), dl.suggestedFilename());
    await expect.poll(async () => (await labState(page)).anchor).toBe('499');
    expectSameView(mars, await labState(page));
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('Arrived at a shared location');

    // A PNG without the link is explained, not applied.
    const raw = await page.evaluate(() => (window as unknown as { __ks: LabKs }).__ks.rawFrame().split(',')[1]!);
    await drop(raw, 'other.png');
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('This image does not carry a Known Sky location');
  });

  test('reduced motion: no capture flash and toasts appear without sliding', async ({ page }) => {
    await open(page, '/share.html?reset=1&reducedMotion=1');
    await page.keyboard.press('KeyK');
    await expect(toast(page)).toHaveClass(/is-still/);
    await page.keyboard.press('KeyP');
    await expect(page.locator('.ks-shot')).toBeVisible();
    await expect(page.locator('.ks-shot')).toHaveClass(/is-still/);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('KeyP')]);
    expect(dl.suggestedFilename()).toMatch(/\.png$/);
    await expect(page.locator('.ks-shot-flash')).not.toHaveClass(/is-on/);
    // Text scaling: the toolbar grows with the text-size setting (rem-based).
    const h1 = await page.locator('.ks-shot-bar').evaluate((e) => e.getBoundingClientRect().height);
    await page.keyboard.press('Escape');
    await open(page, '/share.html?reset=1&reducedMotion=1&textScale=1.5');
    await page.keyboard.press('KeyP');
    await expect(page.locator('.ks-shot')).toBeVisible();
    const h2 = await page.locator('.ks-shot-bar').evaluate((e) => e.getBoundingClientRect().height);
    expect(h2).toBeGreaterThan(h1 * 1.35);
    await page.screenshot({ path: `${SHOTS}/screenshot-mode-text150.png` });
  });

  test('high-contrast palette', async ({ page }) => {
    await open(page, '/share.html?reset=1&colorblind=high-contrast');
    await page.keyboard.press('KeyK');
    await page.keyboard.press('KeyP');
    await expect(toast(page)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/screenshot-mode-high-contrast.png` });
  });
});

test.describe('real game (index.html)', () => {
  // The software renderer is slow: a smaller window keeps each frame (and each key press) quicker.
  test.use({ viewport: { width: 800, height: 450 } });

  type GameKs = {
    app: {
      cam: { pos: { anchor: string; offset: { x: number; y: number; z: number } }; quat: { x: number; y: number; z: number; w: number } };
      sys: { byId: Map<string, unknown>; primaryStar(p: unknown, t: number): { def: { id: string } } };
      simTime: number;
      cockpit: unknown;
      frame: { cockpitEnabled: boolean };
      panel: { isOpen: boolean };
      map: { isOpen: boolean } | null;
      codex: { ui: { isOpen: boolean; panel: { close(): void } } };
      controller: { targetId: string | null; ship: { mode: string } };
    };
    share: {
      applyFragment(f: string): Promise<string>;
      toast: { current: string | null };
      screenshot: { active: boolean; enter(): void; exit(): void; capture(o: { caption: boolean }): Promise<Blob> };
    };
    pending(): number;
  };

  /** Captures the current view with its caption in the page and returns the PNG's Title and share link. */
  async function captureText(page: Page): Promise<{ title: string; token: string | null; png: Buffer }> {
    const b64 = await page.evaluate(async () => {
      const k = (window as unknown as { __ks: GameKs }).__ks;
      const was = k.share.screenshot.active;
      k.share.screenshot.enter();
      const blob = await k.share.screenshot.capture({ caption: true });
      if (!was) k.share.screenshot.exit();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (const c of buf) bin += String.fromCharCode(c);
      return btoa(bin);
    });
    const png = Buffer.from(b64, 'base64');
    const title = readPngText(new Uint8Array(png)).find((e) => e.keyword === 'Title')?.text ?? '';
    return { title, token: findShareInPng(new Uint8Array(png)), png };
  }

  /** Brightest channel value above the caption band (0-255): a black capture reads about 1. */
  async function peak(page: Page, png: Buffer): Promise<number> {
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, Math.floor(c.height * 0.7)).data;
      let max = 0;
      for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i]!, d[i + 1]!, d[i + 2]!);
      return max;
    }, png.toString('base64'));
  }

  test('a link places the camera exactly, and the player shares and screenshots from the keyboard', async ({ page }) => {
    test.slow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
    });
    const offset: [number, number, number] = [-1_234_567.891_234_567, 2_345_678.912_345_678, 345_678.123_456_789];
    const s: ShareState = {
      v: 1,
      anchor: '301',
      offset,
      // Look a little past the Moon's centre, so the review image shows it.
      quat: lookAt([-offset[0] + 4e5, -offset[1], -offset[2]], [0, 0, 1]),
      timeMs: Date.UTC(2026, 9, 11, 12, 0, 0, 250),
      target: '399',
      mode: 'impulse',
      fovDeg: 60,
    };
    const token = encodeShare(s);
    // The test's own speed flags; links themselves never carry query parameters.
    await page.goto(`/index.html?msaa=0&bloom=0&lock=0#${token}`);
    await page.waitForFunction(() => (window as unknown as { __ks?: { share?: unknown } }).__ks?.share !== undefined, null, { timeout: 200_000 });
    // main.ts applied the link before the first frame and took it out of the address bar.
    expect(await page.evaluate(() => location.hash)).toBe('');

    // Exactness: apply the same link again and read the camera before any frame moves the ship.
    const placed = await page.evaluate(async (h) => {
      const k = (window as unknown as { __ks: GameKs }).__ks;
      const outcome = await k.share.applyFragment(h);
      const app = k.app;
      const o = app.cam.pos.offset;
      const q = app.cam.quat;
      return {
        outcome,
        toast: k.share.toast.current,
        anchor: app.cam.pos.anchor,
        offset: [o.x, o.y, o.z],
        quat: [q.x, q.y, q.z, q.w],
        simTime: app.simTime,
        target: app.controller.targetId,
        mode: app.controller.ship.mode,
      };
    }, `#${token}`);
    expect(placed.outcome).toBe('ok');
    expect(placed.toast).toBe('Arrived at a shared location');
    expect(placed.anchor).toBe('301');
    for (let k = 0; k < 3; k++) expect(Object.is(placed.offset[k], s.offset[k]), `offset ${k}`).toBe(true);
    for (let k = 0; k < 4; k++) expect(Math.abs(placed.quat[k]! - s.quat[k]!)).toBeLessThan(1e-6);
    expect(placed.target).toBe('399');
    expect(placed.mode).toBe('impulse');
    await page.waitForFunction(() => (window as unknown as { __ks: GameKs }).__ks.pending() === 0, null, { timeout: 120_000 });

    // K copies a link to the page alone (no query parameters), and the address bar stays clean.
    await page.keyboard.press('KeyK');
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('Location link copied');
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toMatch(/\/index\.html#ks1\.[A-Za-z0-9_-]+$/);
    expect(decodeShare(new URL(url).hash)?.anchor).toBe('301');
    expect(await page.evaluate(() => location.href)).not.toContain('#');

    // P enters screenshot mode: HUD and cockpit hidden, hints from the bindings, toast clear of the toolbar.
    const hasCockpit = await page.evaluate(() => (window as unknown as { __ks: GameKs }).__ks.app.cockpit !== null);
    await page.keyboard.press('KeyP');
    await expect(page.locator('body')).toHaveClass(/ks-screenshot/);
    await expect(page.locator('.ks-hud')).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as { __ks: GameKs }).__ks.app.frame.cockpitEnabled)).toBe(false);
    await expect(page.locator('.ks-shot-capture kbd')).toHaveText('P');
    await expect(page.locator('.ks-shot-exit kbd')).toHaveText('Esc');

    // Tab reaches the toolbar (not the next target); Space on the switch toggles the caption.
    const targetBefore = await page.evaluate(() => (window as unknown as { __ks: GameKs }).__ks.app.controller.targetId);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /^Capture/ })).toBeFocused();
    await page.keyboard.press('Tab');
    const sw = page.getByRole('switch', { name: 'Caption' });
    await expect(sw).toBeFocused();
    await page.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => (window as unknown as { __ks: GameKs }).__ks.app.controller.targetId)).toBe(targetBefore);
    await page.screenshot({ path: `${SHOTS}/game-screenshot-mode.png` });
    // A click on the view does not reach App's pointer-lock request: the cursor stays for the toolbar.
    const clicks = (): Promise<number> => page.evaluate(() => (window as unknown as { __clicks: number }).__clicks);
    await page.evaluate(() => {
      (window as unknown as { __clicks: number }).__clicks = 0;
      document.getElementById('c')!.addEventListener('click', () => (window as unknown as { __clicks: number }).__clicks++);
    });
    await page.mouse.click(400, 300);
    expect(await clicks()).toBe(0);

    // P again captures: a PNG at the canvas's size, captioned, carrying the link.
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.keyboard.press('KeyP')]);
    expect(dl.suggestedFilename()).toMatch(/^knownsky-\d{8}-\d{6}\.png$/);
    const png = await savePng(dl, 'game-capture.png');
    const size = await page.evaluate(() => [document.querySelector('canvas')!.width, document.querySelector('canvas')!.height]);
    expect(pngSize(png)).toEqual(size);
    expect(decodeShare(`#${findShareInPng(new Uint8Array(png))!}`)?.anchor).toBe('301');
    expect(readPngText(new Uint8Array(png)).find((e) => e.keyword === 'Title')?.text).toMatch(/^Moon · /);
    // The supersampled frame carries the picture (not an empty canvas).
    expect(await peak(page, png)).toBeGreaterThan(60);

    // Escape leaves screenshot mode without opening the pause menu, and brings the cockpit back.
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/ks-screenshot/);
    await expect(page.locator('.ks-hud')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __ks: GameKs }).__ks.app.frame.cockpitEnabled)).toBe(hasCockpit);
    await page.mouse.click(400, 300);
    expect(await clicks()).toBe(1);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as unknown as { __ks: GameKs }).__ks.app.panel.isOpen)).toBe(false);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __ks: GameKs }).__ks.app.panel.isOpen)).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __ks: GameKs }).__ks.app.panel.isOpen)).toBe(false);

    // An interstellar link (review finding): the caption and the arrival name interstellar space, not the nearest moon.
    const ism: ShareState = { v: 1, anchor: 'ism', offset: [1e16, 2e15, -3e15], quat: [0, 0, 0, 1], timeMs: Date.UTC(2026, 9, 11, 12) };
    const deep = await page.evaluate(async (h) => {
      const k = (window as unknown as { __ks: GameKs }).__ks;
      const outcome = await k.share.applyFragment(h);
      return { outcome, detail: document.querySelector('.ks-toasts .ks-toast-detail')?.textContent ?? '' };
    }, `#${encodeShare(ism)}`);
    expect(deep.outcome).toBe('ok');
    expect(deep.detail).toBe('Interstellar space · 2026-10-11 12:00:00 UTC');
    const deepShot = await captureText(page);
    writeFileSync(`${SHOTS}/game-capture-interstellar.png`, deepShot.png);
    expect(deepShot.title).toMatch(/^Interstellar space · Sun 1\.\d+ ly away$/);
    expect(await peak(page, deepShot.png)).toBeGreaterThan(30);

    // A catalogue star pasted while playing (hashchange): the star becomes a lit body before the camera is placed, so
    // the camera stays anchored to it (no detour through the interstellar frame).
    const starOffset: [number, number, number] = [7.1e9, -4.3e9, 2.9e9];
    const proxima: ShareState = {
      v: 1,
      anchor: '*105913',
      offset: starOffset,
      quat: lookAt([-starOffset[0], -starOffset[1] + 1.5e9, -starOffset[2]], [0, 0, 1]),
      timeMs: s.timeMs,
      target: '*105913',
      mode: 'cruise',
    };
    await page.evaluate((h) => (location.hash = h), `#${encodeShare(proxima)}`);
    await page.waitForFunction(() => (window as unknown as { __ks: GameKs }).__ks.app.cam.pos.anchor === '*105913', null, { timeout: 60_000 });
    await page.waitForTimeout(1500);
    const at = await page.evaluate(() => {
      const app = (window as unknown as { __ks: GameKs }).__ks.app;
      const o = app.cam.pos.offset;
      return {
        anchor: app.cam.pos.anchor,
        offset: [o.x, o.y, o.z],
        lit: app.sys.byId.has('*105913'),
        primary: app.sys.primaryStar(app.cam.pos, app.simTime).def.id,
        target: app.controller.targetId,
        hash: location.hash,
      };
    });
    expect(at).toMatchObject({ anchor: '*105913', lit: true, primary: '*105913', target: '*105913', hash: '' });
    // The ship holds still in cruise at zero throttle; allow for a little drift over the frames since arrival.
    for (let k = 0; k < 3; k++) expect(Math.abs(at.offset[k]! - starOffset[k]!)).toBeLessThan(1);
    const star = await captureText(page);
    writeFileSync(`${SHOTS}/game-capture-proxima.png`, star.png);
    expect(star.title).toMatch(/^Proxima Centauri · /);
    expect(await peak(page, star.png)).toBeGreaterThan(60);

    // An exoplanet (M4): the system's bodies load and the camera is placed relative to the planet.
    const planet: ShareState = { v: 1, anchor: 'trappist-1e', offset: [2.2e7, 0, 0], quat: lookAt([-1, 0, 0], [0, 0, 1]), timeMs: s.timeMs, target: 'trappist-1e', mode: 'impulse' };
    await page.evaluate((h) => (location.hash = h), `#${encodeShare(planet)}`);
    await page.waitForFunction(
      () => {
        const app = (window as unknown as { __ks: GameKs }).__ks.app;
        return app.cam.pos.anchor === 'trappist-1e' && app.sys.byId.has('trappist-1e');
      },
      null,
      { timeout: 90_000 },
    );
    expect(await page.evaluate(() => (window as unknown as { __ks: GameKs }).__ks.app.controller.targetId)).toBe('trappist-1e');
    await page.waitForFunction(() => (window as unknown as { __ks: GameKs }).__ks.pending() === 0, null, { timeout: 120_000 });
    const exo = await captureText(page);
    writeFileSync(`${SHOTS}/game-capture-trappist-1e.png`, exo.png);
    expect(exo.title).toMatch(/^TRAPPIST-1 e · /);
    expect(await peak(page, exo.png)).toBeGreaterThan(30);
    expect(decodeShare(`#${exo.token!}`)?.anchor).toBe('trappist-1e');

    // The map and Codex checks come after the captures above: at da75eac, once the map has been opened and closed the 3D
    // view renders black (a pre-existing bug, reported separately), which would blank these review images.
    // The map ends screenshot mode (the toolbar must not sit over the map).
    await page.keyboard.press('KeyP');
    await expect(page.locator('body')).toHaveClass(/ks-screenshot/);
    await page.keyboard.press('KeyM');
    await expect(page.locator('body')).not.toHaveClass(/ks-screenshot/);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __ks: GameKs }).__ks.app.map?.isOpen ?? false)).toBe(false);

    // So does the Codex (it can also open from a toast's View button, without a game action).
    await page.keyboard.press('KeyP');
    await expect(page.locator('body')).toHaveClass(/ks-screenshot/);
    await page.keyboard.press('KeyC');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __ks: GameKs }).__ks.app.codex.ui.isOpen)).toBe(true);
    await expect(page.locator('body')).not.toHaveClass(/ks-screenshot/);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __ks: GameKs }).__ks.app.codex.ui.isOpen)).toBe(false);

    // Large text on this short window, a Codex notification up, then K in screenshot mode: the share toast stays on
    // screen and off the toolbar, and every toolbar button still takes a click.
    await page.evaluate(() => (window as unknown as { __ks: { app: { settings: { set(p: object): void } } } }).__ks.app.settings.set({ textScale: 2 }));
    await page.keyboard.press('KeyP');
    await expect(page.locator('body')).toHaveClass(/ks-screenshot/);
    await page.evaluate(() => (window as unknown as { __ks: { app: { codex: { ui: { store: { discover(id: string): void } } } } } }).__ks.app.codex.ui.store.discover('concept-radial-velocity'));
    await expect(page.locator('.ks-cx-toasts .ks-cx-toast')).not.toHaveCount(0);
    await page.keyboard.press('KeyK');
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('Location link copied');
    await page.mouse.move(400, 300);
    const bar = (await box(page, '.ks-shot-bar'))!;
    await expect.poll(async () => (await box(page, '.ks-toasts .ks-toast'))?.bottom ?? 0).toBeLessThanOrEqual(450);
    expect(intersects(bar, (await box(page, '.ks-toasts .ks-toast'))!)).toBe(false);
    expect(intersects(bar, (await box(page, '.ks-cx-toasts .ks-cx-toast'))!)).toBe(false);
    for (const sel of ['.ks-shot-capture', '.ks-shot-switch', '.ks-shot-exit']) expect(await hittable(page, sel), sel).toBe(true);
    await page.screenshot({ path: `${SHOTS}/game-text2-toasts.png` });
    expect(errors).toEqual([]);
  });
});
