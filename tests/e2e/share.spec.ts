/**
 * Shareable coordinates and screenshot mode on share.html. The default page is DOM-only: a 2D canvas stands in for
 * the renderer, so page screenshots work. One test boots the real game (?game=1, WebGPU on SwiftShader) to check the
 * integration code against the App. Review images go to test-results/share-shots/.
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
  input: { setBinding(id: string, slot: 0 | 1, b: unknown): boolean };
  share: { screenshot: { active: boolean } };
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
    expect(url).toMatch(/\/share\.html\?reset=1#ks1\.[A-Za-z0-9_-]+$/);
    // The address bar carries the same link.
    expect(await page.evaluate(() => location.href)).toBe(url);
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
    expect(errors).toEqual([]);
  });

  test('damaged, newer and unknown links are refused and explained', async ({ page }) => {
    await open(page, '/share.html?reset=1#ks1.AAAAAAAAAAAA');
    const home = await labState(page);
    expect(home.anchor).toBe('399');
    await expect(toast(page).locator('.ks-toast-msg')).toHaveText('This location link is damaged or incomplete');
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

    // Keyboard: the overlay's buttons are reachable and Space toggles the caption without reaching game bindings.
    await sw.focus();
    await page.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('.ks-shot-preview')).toBeHidden();
    await page.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'true');

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

test.describe('game integration', () => {
  test('a link places the real camera, time and target; the capture composites the WebGPU frame', async ({ page }) => {
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
    await page.goto(`/share.html?game=1&msaa=0&bloom=0#${encodeShare(s)}`);
    await page.waitForFunction(() => (window as unknown as { __ks?: unknown }).__ks !== undefined, null, { timeout: 200_000 });
    const placed = await page.evaluate(() => {
      const k = (window as unknown as { __ks: { outcome: string; placed: unknown } }).__ks;
      return { outcome: k.outcome, placed: k.placed };
    });
    expect(placed.outcome).toBe('ok');
    const p = placed.placed as { anchor: string; offset: number[]; quat: number[]; timeMs: number; target: string | null; mode: string };
    expect(p.anchor).toBe('301');
    for (let k = 0; k < 3; k++) expect(Object.is(p.offset[k], s.offset[k]), `offset ${k}`).toBe(true);
    for (let k = 0; k < 4; k++) expect(Math.abs(p.quat[k]! - s.quat[k]!)).toBeLessThan(1e-6);
    expect(Math.abs(p.timeMs - s.timeMs)).toBeLessThan(0.01);
    expect(p.target).toBe('399');
    expect(p.mode).toBe('impulse');

    await page.waitForFunction(() => (window as unknown as { __ks: { pending(): number } }).__ks.pending() === 0, null, { timeout: 120_000 });
    const b64 = await page.evaluate(async () => {
      const k = (window as unknown as { __ks: { share: { screenshot: { enter(): void; exit(): void; capture(o: { caption: boolean }): Promise<Blob> } } } }).__ks;
      k.share.screenshot.enter();
      const blob = await k.share.screenshot.capture({ caption: true });
      k.share.screenshot.exit();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (const c of buf) bin += String.fromCharCode(c);
      return btoa(bin);
    });
    const png = Buffer.from(b64, 'base64');
    writeFileSync(`${SHOTS}/game-capture.png`, png);
    const size = await page.evaluate(() => [document.querySelector('canvas')!.width, document.querySelector('canvas')!.height]);
    expect(pngSize(png)).toEqual(size);
    const token = findShareInPng(new Uint8Array(png));
    expect(decodeShare(`#${token!}`)?.anchor).toBe('301');
    const title = readPngText(new Uint8Array(png)).find((e) => e.keyword === 'Title')?.text ?? '';
    expect(title).toMatch(/^Moon · /);

    // A link to a catalogue star pasted while playing (hashchange): the star becomes a lit body before the camera is
    // placed, so the camera stays anchored to it (no detour through the interstellar frame).
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
    type GameKs = {
      app: {
        cam: { pos: { anchor: string; offset: { x: number; y: number; z: number } } };
        sys: { byId: Map<string, unknown>; primaryStar(p: unknown, t: number): { def: { id: string } } };
        simTime: number;
        controller: { targetId: string | null };
      };
    };
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
      };
    });
    expect(at).toMatchObject({ anchor: '*105913', lit: true, primary: '*105913', target: '*105913' });
    // The ship holds still in cruise at zero throttle; allow for a little drift over the frames since arrival.
    for (let k = 0; k < 3; k++) expect(Math.abs(at.offset[k]! - starOffset[k]!)).toBeLessThan(1);
    const starShot = await page.evaluate(async () => {
      const k = (window as unknown as { __ks: { share: { screenshot: { enter(): void; exit(): void; capture(o: { caption: boolean }): Promise<Blob> } } } }).__ks;
      k.share.screenshot.enter();
      const blob = await k.share.screenshot.capture({ caption: true });
      k.share.screenshot.exit();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (const c of buf) bin += String.fromCharCode(c);
      return btoa(bin);
    });
    const star = Buffer.from(starShot, 'base64');
    writeFileSync(`${SHOTS}/game-capture-proxima.png`, star);
    expect(readPngText(new Uint8Array(star)).find((e) => e.keyword === 'Title')?.text).toMatch(/^Proxima Centauri · /);
    expect(errors).toEqual([]);
  });
});
