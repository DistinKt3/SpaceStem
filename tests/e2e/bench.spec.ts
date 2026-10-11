/**
 * Benchmark UI on bench.html (a synthetic driver, DOM only, so page screenshots work) and one run of the real game
 * driver (createAppBenchDriver over App) on index.html. Screenshots go to test-results/bench-shots/ for review.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const SHOTS = 'test-results/bench-shots';

interface ViewRow {
  view: string;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  verdict: string;
  overBudget: string[];
}
interface Report {
  format: string;
  framesPerView: number;
  synthetic?: boolean;
  views: ViewRow[];
  overall: { verdict: string; suggestedPreset: string; worstView: string };
  info: { backend: string };
}
interface DemoState {
  report: Report | null;
  progress: { view: string; index: number; phase: string }[];
  closed: number;
  running: boolean;
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Benchmark results' });
const demoState = (page: Page): Promise<DemoState> => page.evaluate(() => (window as unknown as { __ks: { state: DemoState } }).__ks.state);

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/bench.html${query ? `?${query}` : ''}`);
  await expect(dialog(page)).toBeVisible();
}

test.describe('benchmark panel (synthetic driver)', () => {
  test('runs every view in order and shows an accessible results dialog', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await open(page);
    const s = await demoState(page);
    const r = s.report!;
    expect(r.format).toBe('known-sky-bench');
    expect(r.synthetic).toBe(true);
    // Progress: loading, warm-up and measuring for each of the seven default views, in order.
    const views = ['leo', 'earth-low', 'earth-descent', 'moon-surface', 'earthrise', 'saturn', 'sun'];
    expect(r.views.map((v) => v.view)).toEqual(views);
    expect([...new Set(s.progress.map((p) => p.view))]).toEqual(views);
    for (const v of views) expect(new Set(s.progress.filter((p) => p.view === v).map((p) => p.phase))).toEqual(new Set(['loading', 'warmup', 'measuring']));

    const d = dialog(page);
    await expect(d).toHaveAttribute('aria-describedby', /ks-bench-verdict/);
    // Synthetic numbers are labelled as such.
    await expect(d.getByText('Sample data')).toBeVisible();
    await expect(d.getByText(/not a measurement of this device/)).toBeVisible();
    // Opening moves focus to the title.
    await expect(page.getByRole('heading', { name: 'Benchmark results' })).toBeFocused();

    // One row per view, with the report's numbers and a worded verdict.
    const rows = d.getByRole('row');
    await expect(rows).toHaveCount(8);
    for (const [i, v] of r.views.entries()) {
      const row = rows.nth(i + 1);
      await expect(row.getByRole('rowheader')).toHaveText(
        ['Low Earth orbit', 'Low over the Himalaya', 'Descent over the Himalaya', 'Lunar surface', 'Earthrise from the Moon', 'Saturn', 'Near the Sun'][i]!,
      );
      await expect(row).toContainText(`${v.p95Ms.toFixed(1)} ms`);
      await expect(row).toContainText(`${v.p50Ms.toFixed(1)} ms`);
      await expect(row).toContainText({ smooth: 'Smooth', playable: 'Playable', slow: 'Slow' }[v.verdict]!);
      if (v.overBudget.includes('triangles')) await expect(row).toContainText('Over budget');
    }
    await expect(d.locator('.ks-bench-verdict')).toContainText({ smooth: 'Smooth', playable: 'Playable', slow: 'Slow' }[r.overall.verdict]!);
    await expect(d.locator('.ks-bench-stat.is-accent dd')).toHaveText(r.overall.suggestedPreset.replace(/^./, (c) => c.toUpperCase()));
    await page.screenshot({ path: `${SHOTS}/panel-mixed.png` });

    // Modal: Tab cycles inside the dialog.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.querySelector('dialog.ks-bench')!.contains(document.activeElement))).toBe(true);
    }
    expect(errors).toEqual([]);
  });

  // Review finding: Shift+Tab from the title (focused on open, tabIndex -1) left the modal.
  test('Shift+Tab stays inside the dialog, from the title and around the ends', async ({ page }) => {
    await open(page);
    const inDialog = (): Promise<{ inside: boolean; tag: string }> =>
      page.evaluate(() => ({ inside: document.querySelector('dialog.ks-bench')!.contains(document.activeElement), tag: document.activeElement?.className ?? '' }));
    await expect(page.getByRole('heading', { name: 'Benchmark results' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    // From the title, backwards wraps to the last control (the Close text button in the action bar).
    expect(await inDialog()).toEqual({ inside: true, tag: expect.stringContaining('ks-bench-close-text') as unknown as string });
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab');
      expect((await inDialog()).inside).toBe(true);
    }
    // And forwards from a click on plain text (not a stop) goes to the first control, not out of the dialog.
    await page.locator('.ks-bench-verdict-desc').click();
    await page.keyboard.press('Tab');
    expect((await inDialog()).inside).toBe(true);
  });

  test('Copy JSON puts the report on the clipboard and announces it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);
    await dialog(page).getByRole('button', { name: 'Copy JSON' }).click();
    await expect(dialog(page).getByRole('status')).toHaveText('Report copied to the clipboard.');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(JSON.parse(text)).toEqual((await demoState(page)).report);
  });

  test('Download JSON saves the report as a file', async ({ page }) => {
    await open(page);
    const [download] = await Promise.all([page.waitForEvent('download'), dialog(page).getByRole('button', { name: 'Download JSON' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^known-sky-bench-2026-10-11T12-00-00Z\.json$/);
    const saved = JSON.parse(readFileSync(await download.path(), 'utf8')) as Report;
    expect(saved).toEqual((await demoState(page)).report);
    await expect(dialog(page).getByRole('status')).toContainText('Report saved as known-sky-bench-');
  });

  test('the raw JSON is readable in the dialog', async ({ page }) => {
    await open(page);
    await dialog(page).getByText('Report JSON').click();
    const pre = dialog(page).locator('pre.ks-bench-json');
    await expect(pre).toBeVisible();
    expect(JSON.parse((await pre.textContent())!)).toEqual((await demoState(page)).report);
  });

  test('Escape closes the dialog; the benchmark can run again', async ({ page }) => {
    await open(page, 'profile=slow');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    // The dialog's close event is queued as a task, so poll for its effect.
    await expect.poll(async () => (await demoState(page)).closed).toBe(1);
    const again = page.getByRole('button', { name: 'Run again' });
    await expect(again).toBeVisible();
    await again.click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator('.ks-bench-verdict')).toContainText('Slow');
    await dialog(page).getByRole('button', { name: 'Close' }).last().click();
    await expect(dialog(page)).toBeHidden();
  });

  test('the progress card names each view in a polite live region', async ({ page }) => {
    await page.goto('/bench.html?hold=progress');
    const card = page.locator('.ks-bench-progress');
    await expect(card).toBeVisible();
    const live = card.getByRole('status');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText('Low Earth orbit (1 of 7)');
    await expect(card).toContainText('Loading the view');
    await expect(card.getByRole('progressbar', { name: 'Benchmark progress' })).toHaveAttribute('aria-valuenow', '0');
    await expect(dialog(page)).toBeHidden();
    await page.screenshot({ path: `${SHOTS}/progress.png` });
  });

  // Review finding: at 2x text on a phone-sized window the header (title, device and run lines) overflowed the dialog.
  for (const [w, h, scale] of [
    [390, 844, 2],
    [320, 640, 2],
    [480, 800, 2],
    [390, 844, 1.5],
    [320, 640, 1.5],
    [800, 450, 2],
    [1280, 720, 2],
  ] as const) {
    test(`no horizontal overflow or clipped header text at ${w}x${h} with ${scale}x text`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await open(page, `textScale=${scale}&profile=slow`);
      const m = await page.evaluate(() => {
        const frame = document.querySelector<HTMLElement>('.ks-bench-frame')!;
        const fr = frame.getBoundingClientRect();
        const sel = ['.ks-bench-eyebrow', '.ks-bench-title', '.ks-bench-device', '.ks-bench-meta > span', '.ks-bench-close', '.ks-bench-actions .ks-bench-btn', '.ks-bench-stat', '.ks-bench-verdict'];
        const outside: string[] = [];
        for (const s of sel) {
          for (const el of document.querySelectorAll<HTMLElement>(s)) {
            const r = el.getBoundingClientRect();
            if (r.left < fr.left - 0.5 || r.right > fr.right + 0.5) outside.push(`${s} ${Math.round(r.left)}..${Math.round(r.right)} vs ${Math.round(fr.left)}..${Math.round(fr.right)}`);
            if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') outside.push(`${s} scrolls`);
          }
        }
        return { overflow: frame.scrollWidth - frame.clientWidth, outside, page: document.documentElement.scrollWidth - innerWidth };
      });
      expect(m.overflow).toBeLessThanOrEqual(1);
      expect(m.page).toBeLessThanOrEqual(0);
      expect(m.outside).toEqual([]);
      const box = (await dialog(page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(w);
      if (w <= 480) await page.screenshot({ path: `${SHOTS}/narrow-${w}x${h}-${scale}x.png` });
    });
  }

  // Review finding: a bogus ?profile= broke "Run again", and ?frames=Infinity froze the tab.
  test('hostile URL parameters fall back to defaults', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await open(page, 'profile=bogus&frames=abc');
    expect((await demoState(page)).report!.framesPerView).toBe(180);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Run again' }).click();
    await expect(dialog(page)).toBeVisible();
    await expect.poll(async () => (await demoState(page)).running).toBe(false);
    expect(errors).toEqual([]);
    await open(page, 'frames=Infinity');
    expect((await demoState(page)).report!.framesPerView).toBe(180);
    await open(page, 'frames=1e12');
    expect((await demoState(page)).report!.framesPerView).toBe(2000);
    expect(errors).toEqual([]);
  });

  test('a view without measured frames reads "No data" and is left out of the verdict', async ({ page }) => {
    await open(page, 'profile=smooth');
    await page.evaluate(() => {
      const ks = (window as unknown as { __ks: { panel: { show(r: unknown): void; close(): void }; state: { report: Record<string, unknown> & { views: Record<string, unknown>[] } } } }).__ks;
      const r = structuredClone(ks.state.report);
      r.views[0] = { ...r.views[0], frames: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, meanMs: 0, verdict: 'none' };
      ks.panel.close();
      ks.panel.show(r);
    });
    await expect(dialog(page).locator('tr[data-view="leo"]')).toContainText('No data');
    await expect(dialog(page).locator('.ks-bench-verdict')).toContainText('Smooth');
  });

  test('large text and high contrast stay inside the viewport', async ({ page }) => {
    await open(page, 'textScale=2&colorblind=high-contrast&profile=slow');
    const box = (await dialog(page).boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
    // No horizontal overflow: rows become cards, and the table keeps its semantics through explicit roles.
    const overflow = await page.evaluate(() => {
      const f = document.querySelector('.ks-bench-frame')!;
      return f.scrollWidth - f.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(dialog(page).getByRole('row')).toHaveCount(8);
    await expect(dialog(page).getByRole('columnheader')).toHaveCount(7);
    await expect(page.locator('html')).toHaveAttribute('data-colorblind', 'high-contrast');
    await page.screenshot({ path: `${SHOTS}/panel-large-text-hc.png` });
    await page.locator('tr[data-view="moon-surface"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/panel-large-text-hc-rows.png` });
  });
});

test.describe('benchmark in the game', () => {
  test('the App driver measures views, gives the frame loop back and shows the results', async ({ page }) => {
    test.slow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
    });
    await page.goto('/?msaa=0&bloom=0');
    await page.waitForFunction(() => (window as unknown as { __ks?: unknown }).__ks !== undefined, null, { timeout: 180_000 });
    const result = await page.evaluate(async () => {
      interface KsApp {
        input: { enabled: boolean };
        cam: { pos: { anchor: string } };
      }
      const app = (window as unknown as { __ks: { app: KsApp } }).__ks.app;
      const anchorBefore = app.cam.pos.anchor;
      const url = '/src/game/bench/appBench.ts';
      const m = (await import(/* @vite-ignore */ url)) as { runAppBench: (app: unknown, o: unknown) => Promise<Report & { views: (ViewRow & { frames: number; cpuP50Ms: number | null; meanDrawCalls: number })[] }> };
      const r = await m.runAppBench(app, { views: ['sun'], framesPerView: 3, warmup: 1, settleFrames: 3, idleTimeoutMs: 30_000, quality: 'high' });
      return {
        r,
        ownTick: Object.prototype.hasOwnProperty.call(app, 'tick'),
        inputDuringDialog: app.input.enabled,
        anchorBefore,
        anchorAfter: app.cam.pos.anchor,
      };
    });
    expect(result.r.views).toHaveLength(1);
    const v = result.r.views[0]!;
    expect(v.view).toBe('sun');
    expect(v.frames).toBe(3);
    expect(v.p50Ms).toBeGreaterThan(0);
    expect(v.cpuP50Ms).not.toBeNull();
    expect(v.p50Ms).toBeGreaterThanOrEqual(v.cpuP50Ms!);
    expect(v.meanDrawCalls).toBeGreaterThan(0);
    expect(['webgpu', 'webgl2']).toContain(result.r.info.backend);
    // The loop is App's again, the camera is back where it was, and input stays off until the dialog closes.
    expect(result.ownTick).toBe(false);
    expect(result.anchorAfter).toBe(result.anchorBefore);
    expect(result.inputDuringDialog).toBe(false);
    await expect(dialog(page)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/game-results.png` });
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __ks: { app: { input: { enabled: boolean } } } }).__ks.app.input.enabled)).toBe(true);
    // Escape closed the dialog only: it did not also open the pause menu.
    await page.waitForTimeout(300);
    await expect(page.locator('dialog.ks-settings')).toBeHidden();
    expect(errors).toEqual([]);
  });
});
