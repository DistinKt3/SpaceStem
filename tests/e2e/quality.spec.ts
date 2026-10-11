/**
 * Adaptive quality in the real game (index.html): the quality setting chosen with the keyboard reaches the renderer,
 * the stats overlay names the level, a cockpit rebuilt at another detail level takes over the old one's lighting (no
 * frame of default uniforms), and ?bench=1 runs from the URL with unknown views skipped and the preset given back.
 */
import { test, expect, type Page } from '@playwright/test';

interface QualityStats {
  preset: string;
  level: string;
  bootLevel: string;
  limitMs: number | null;
}
interface KsApp {
  quality: { stats(): QualityStats; setPreset(p: string): void };
  frame: { hdrSize: { width: number; height: number }; cockpitEnabled: boolean };
  stars: { magLimit: { value: number } };
  cockpit: { stats(): { triangles: number } } | null;
  settings: { data: { quality: string; showFps: boolean } };
  sys: { viewSamples: number };
  input: { enabled: boolean };
}
type Win = Window & { __ks?: { app: KsApp; bench?: { quality: string; views: { view: string; frames: number }[] } } };

const SHOTS = 'test-results/quality-shots';

async function boot(page: Page, query: string, errors: string[], warnings: string[] = []): Promise<void> {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await page.goto(`/?msaa=0&bloom=0&lock=0${query}`);
  await page.waitForFunction(() => (window as Win).__ks !== undefined, null, { timeout: 180_000 });
}

const state = (page: Page) =>
  page.evaluate(() => {
    const app = (window as Win).__ks!.app;
    return {
      q: app.quality.stats(),
      hdr: app.frame.hdrSize,
      mag: app.stars.magLimit.value,
      cockpitTris: app.cockpit?.stats().triangles ?? 0,
      setting: app.settings.data.quality,
      skySamples: app.sys.viewSamples,
    };
  });

/** Settings > Graphics with the keyboard (Escape opens the pause menu; Ctrl+PageDown steps through the tabs). */
async function openGraphics(page: Page): Promise<void> {
  await page.locator('canvas').focus();
  await page.keyboard.press('Escape');
  const dialog = page.getByRole('dialog', { name: /settings/i });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+PageDown');
  await expect(page.getByRole('tab', { name: 'Graphics' })).toHaveAttribute('aria-selected', 'true');
}

/** Tab forward until the element matching `pick` has focus. */
async function tabTo(page: Page, pick: () => boolean, max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate(pick)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('focus target not reached');
}

test.describe('adaptive quality in the game', () => {
  test('the quality preset chosen with the keyboard reaches the renderer, and the stats overlay names it', async ({ page }) => {
    test.slow();
    const errors: string[] = [];
    await boot(page, '', errors);
    const before = await state(page);
    expect(before.q).toMatchObject({ preset: 'auto', level: 'high', bootLevel: 'high' });
    expect(before.hdr).toEqual({ width: 800, height: 450 });
    expect(before.mag).toBe(7.5);
    expect(before.skySamples).toBe(12);

    await openGraphics(page);
    await tabTo(page, () => (document.activeElement as HTMLInputElement | null)?.value === 'auto');
    await page.keyboard.press('ArrowRight'); // Auto -> Low
    await expect.poll(async () => (await state(page)).q.level).toBe('low');
    const low = await state(page);
    expect(low.setting).toBe('low');
    expect(low.q.preset).toBe('low');
    // Low: 0.67 of the canvas, faint stars cut at 6.5, the low-detail cockpit.
    expect(low.hdr).toEqual({ width: Math.round(800 * 0.67), height: Math.round(450 * 0.67) });
    expect(low.mag).toBe(6.5);
    expect(low.cockpitTris).toBeLessThan(before.cockpitTris * 0.6);
    // Atmosphere samples were compiled at boot and stay for the session.
    expect(low.skySamples).toBe(12);

    // Show FPS: the stats overlay gains a Quality row.
    await tabTo(page, () => document.activeElement?.id.endsWith('-fps') ?? false);
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /settings/i })).toBeHidden();
    await expect(page.locator('#hud')).toContainText(/Quality\s*Low · fixed/, { timeout: 60_000 });

    // Back to Auto: adapts from the current level.
    await openGraphics(page);
    await tabTo(page, () => (document.activeElement as HTMLInputElement | null)?.value === 'low');
    await page.keyboard.press('ArrowLeft'); // Low -> Auto
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await state(page)).q.preset).toBe('auto');
    await expect(page.locator('#hud')).toContainText(/Quality\s*Low · Auto/, { timeout: 60_000 });
    expect(errors).toEqual([]);
  });

  // Review finding: the rebuilt cockpit was drawn for one frame with default uniforms (a full-screen wash-out), because
  // the ship controller drives it only after the frame is rendered.
  test('a cockpit rebuilt at another detail level is drawn with the old one\'s lighting from its first frame', async ({ page }) => {
    test.slow();
    const errors: string[] = [];
    await boot(page, '&quality=high&view=saturn', errors);
    const r = await page.evaluate(async () => {
      type C = { u: Record<string, { value: unknown }>; group: unknown };
      const app = (window as Win).__ks!.app as unknown as KsApp & {
        tick(): void;
        renderFrame(dt?: number): void;
        renderer: { domElement: HTMLCanvasElement };
        cockpit: C | null;
      };
      const uniforms = (c: C): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const k of ['gain', 'panelGain', 'sunI', 'still', 'throttle']) out[k] = Number(c.u[k]!.value);
        return out;
      };
      const mean = async (): Promise<number> => {
        const img = new Image();
        img.src = app.renderer.domElement.toDataURL('image/png');
        await img.decode();
        const c = document.createElement('canvas');
        c.width = 160;
        c.height = 90;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0, 160, 90);
        const d = g.getImageData(0, 0, 160, 90).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
        return s / (d.length / 4);
      };
      app.tick();
      app.renderFrame();
      const oldCockpit = app.cockpit!;
      const before = uniforms(oldCockpit);
      const lumBefore = await mean();
      // The rebuild and the next frame, with no ship-controller update in between (as when the level changes in tick).
      app.quality.setPreset('low');
      const after = uniforms(app.cockpit!);
      app.renderFrame();
      const lumAfter = await mean();
      return { before, after, rebuilt: app.cockpit !== oldCockpit, lumBefore, lumAfter };
    });
    expect(r.rebuilt).toBe(true);
    expect(r.after).toEqual(r.before);
    expect(r.before.gain).not.toBe(1); // the exposure compensation is real, not the default
    // No wash-out: the frame's mean brightness stays close (the scene buffer is coarser, the lighting the same).
    expect(Math.abs(r.lumAfter - r.lumBefore)).toBeLessThan(Math.max(4, r.lumBefore * 0.25));
    expect(errors).toEqual([]);
  });

  test('?bench=1 runs from the URL: unknown views are skipped, the world is built at the measured level, the preset comes back', async ({ page }) => {
    test.slow();
    const errors: string[] = [];
    const warnings: string[] = [];
    await boot(page, '&bench=1&benchViews=sun,nosuchview&benchFrames=2&quality=auto', errors, warnings);
    const dialog = page.getByRole('dialog', { name: 'Benchmark results' });
    await expect(dialog).toBeVisible({ timeout: 180_000 });
    const report = await page.evaluate(() => (window as Win).__ks!.bench!);
    expect(report.quality).toBe('high');
    expect(report.views.map((v) => [v.view, v.frames])).toEqual([['sun', 2]]);
    expect(warnings.some((w) => w.includes('nosuchview'))).toBe(true);
    const s = await state(page);
    expect(s.q.bootLevel).toBe('high');
    expect(s.q.preset).toBe('auto'); // ?quality=auto given back after the run
    await page.screenshot({ path: `${SHOTS}/bench-results.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as Win).__ks!.app.input.enabled)).toBe(true);
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog', { name: /settings/i })).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('the scripted descent moves the camera on every measured frame', async ({ page }) => {
    test.slow();
    const errors: string[] = [];
    await boot(page, '&quality=high', errors);
    const r = await page.evaluate(async () => {
      interface P {
        pos: { anchor: string; offset: { length(): number } };
      }
      const app = (window as Win).__ks!.app as unknown as { place(p: P): void; cam: { pos: { anchor: string } } };
      const radii: number[] = [];
      const place = app.place.bind(app);
      app.place = (p: P) => {
        radii.push(p.pos.offset.length());
        place(p);
      };
      const url = '/src/game/bench/appBench.ts';
      const m = (await import(/* @vite-ignore */ url)) as { runAppBench: (app: unknown, o: unknown) => Promise<{ views: { view: string; frames: number }[] }> };
      const report = await m.runAppBench(app, { views: ['earth-descent'], framesPerView: 3, warmup: 0, settleFrames: 1, idleTimeoutMs: 30_000, quality: 'high' });
      Reflect.deleteProperty(app, 'place');
      return { report, radii, anchor: app.cam.pos.anchor };
    });
    expect(r.report.views).toEqual([expect.objectContaining({ view: 'earth-descent', frames: 3 })]);
    // setView, then one placement per measured frame (descending), then the camera goes home.
    expect(r.radii.length).toBe(1 + 3 + 1);
    const flight = r.radii.slice(1, 4);
    expect(flight[0]).toBeCloseTo(r.radii[0]!, -2);
    expect(flight[2]!).toBeLessThan(flight[0]! - 30_000);
    expect(errors).toEqual([]);
  });
});
