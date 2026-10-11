/**
 * Audio verification without ears: the real engine graph is rendered faster than real time with an
 * OfflineAudioContext inside Chromium (audio.html exposes window.__ksAudio), then measured. Rendering is
 * deterministic, so rendering with and without a cue and subtracting isolates exactly what the cue adds.
 * The last test drives the live page with a real AudioContext.
 */
import { test, expect, type Page } from '@playwright/test';
import type { AudioCue } from '../../src/game/audio/audioEngine';
import { CUE_CAPTIONS } from '../../src/game/audio/captions';
import type { Measurement, Scenario } from '../../src/game/audio/offlineRender';

const executablePath = process.env['CI'] ? undefined : '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
test.use({
  launchOptions: {
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--enable-unsafe-webgpu',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--disable-vulkan-surface',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

interface Hooks {
  measure(sc: Scenario, base?: Scenario): Promise<Measurement>;
  cues: AudioCue[];
  engine: { unlocked: boolean; score: { loopSeconds: number }; stats(): { contextState: string; musicTime: number | null; lastError: string | null } };
}

async function open(page: Page): Promise<void> {
  await page.goto('/audio.html');
  await page.waitForFunction(() => (window as unknown as { __ksAudio?: unknown }).__ksAudio !== undefined, null, { timeout: 60_000 });
}

function measure(page: Page, sc: Scenario, base?: Scenario): Promise<Measurement> {
  return page.evaluate(([s, b]) => (window as unknown as { __ksAudio: Hooks }).__ksAudio.measure(s, b ?? undefined), [sc, base ?? null] as const);
}

const keys = (m: Measurement): string[] => m.captions.map((c) => c.key);
const SEED = 7;

test.describe('procedural audio (offline renders)', () => {
  test.beforeEach(async ({ page }) => open(page));

  test('score + engine + wind: audible, bounded, finite, click-free and captioned', async ({ page }) => {
    const m = await measure(page, {
      seconds: 6,
      seed: SEED,
      state: { atmosphereDensity: 1, airspeed: 150 },
      steps: [
        { at: 0.5, state: { thrust: 0.4 } },
        { at: 2.5, state: { thrust: 0.9, rcs: 0.6 } },
        { at: 3.0, state: { rcs: 0 } },
        { at: 4.5, state: { thrust: 0.2 } },
      ],
    });
    expect(m.nonFinite).toBe(0);
    expect(m.lastError).toBeNull();
    expect(m.rms).toBeGreaterThan(0.03); // about -30 dBFS or louder
    expect(m.peak).toBeLessThan(0.98);
    expect(m.shoulder).toBeLessThan(0.002); // the limiter is a safety net, not part of the sound
    expect(m.click).toBeLessThan(9);
    for (const w of m.windowRms.slice(2)) expect(w).toBeGreaterThan(0.01); // no dropouts
    expect(keys(m)).toEqual(
      expect.arrayContaining(['audio.caption.music', 'audio.caption.cabin', 'audio.caption.engineStart', 'audio.caption.engineSurge', 'audio.caption.windStrong', 'audio.caption.rcs']),
    );
  });

  test('every cue renders audibly, stays bounded, decays and is captioned', async ({ page }) => {
    const base: Scenario = { seconds: 5, seed: SEED, volumes: { music: 0 } };
    const cues = await page.evaluate(() => (window as unknown as { __ksAudio: Hooks }).__ksAudio.cues);
    expect(cues).toHaveLength(14);
    for (const cue of cues) {
      const m = await measure(page, { ...base, steps: [{ at: 0.4, cue }] }, base);
      const d = m.diff!;
      expect(m.nonFinite, cue).toBe(0);
      expect(m.peak, cue).toBeLessThan(0.98);
      expect(d.rms, `${cue} rms`).toBeGreaterThan(5e-4);
      expect(d.peak, `${cue} peak`).toBeGreaterThan(0.02);
      expect(d.rmsLate, `${cue} decays`).toBeLessThan(d.rmsEarly);
      expect(d.rmsTail, `${cue} ends`).toBeLessThan(d.rmsEarly * 0.05);
      if (cue.startsWith('ui-')) expect(d.peak, `${cue} is soft`).toBeLessThan(0.2);
      expect(keys(m), cue).toContain(CUE_CAPTIONS[cue].key);
    }
  });

  test('honest silence: no wind in vacuum; drive sounds reach the cabin only low-passed', async ({ page }) => {
    const base: Scenario = { seconds: 3, seed: SEED, volumes: { music: 0 } };
    const vacuum = await measure(page, { ...base, state: { atmosphereDensity: 0, airspeed: 3000 } }, base);
    expect(vacuum.diff!.rms).toBeLessThan(1e-4); // -80 dB: nothing outside is heard in space
    expect(keys(vacuum)).not.toContain('audio.caption.windRising');

    const air = await measure(page, { ...base, state: { atmosphereDensity: 1, airspeed: 120 } }, base);
    expect(air.diff!.rms).toBeGreaterThan(3e-3);

    const engine = await measure(page, { ...base, state: { thrust: 1 } }, base);
    expect(engine.diff!.rms).toBeGreaterThan(0.03);
    expect(engine.diff!.centroidHz).toBeLessThan(400);
    expect(engine.diff!.hfFraction).toBeLessThan(0.01); // essentially nothing above 2 kHz

    const drone = await measure(page, { ...base, state: { hyperspeed: 1, mode: 'hyperspeed' } }, base);
    expect(drone.diff!.rms).toBeGreaterThan(0.02);
    expect(drone.diff!.centroidHz).toBeLessThan(400);
  });

  test('mute, zero volume, NaN state and dispose are silent, finite and error-free', async ({ page }) => {
    const muted = await measure(page, { seconds: 2, seed: SEED, muted: true, state: { thrust: 1 }, steps: [{ at: 0.5, cue: 'alert' }] });
    expect(muted.rms).toBeLessThan(1e-6);
    expect(muted.captions).toEqual([]); // nothing audible, nothing captioned

    const zero = await measure(page, { seconds: 2, seed: SEED, volumes: { master: 0 }, state: { thrust: 1 } });
    expect(zero.rms).toBeLessThan(1e-6);

    const nan = await measure(page, {
      seconds: 2,
      seed: SEED,
      state: { thrust: Number.NaN, airspeed: Infinity, atmosphereDensity: -4, hyperspeed: Number.NaN, mode: 'warp' as 'cruise' },
      steps: [{ at: 0.3, cue: 'hyperspeed-engage', volumes: { music: Number.NaN, sfx: 2 } }],
    });
    expect(nan.nonFinite).toBe(0);
    expect(nan.peak).toBeLessThan(0.98);
    expect(nan.lastError).toBeNull();

    const disposed = await measure(page, { seconds: 3, seed: SEED, state: { thrust: 0.8 }, steps: [{ at: 1.5, dispose: true }, { at: 2, cue: 'alert', state: { thrust: 1 } }] });
    expect(disposed.lastError).toBeNull();
    expect(disposed.windowRms[0]!).toBeGreaterThan(1e-3);
    for (const w of disposed.windowRms.slice(4)) expect(w).toBeLessThan(1e-5);
  });

  test('deterministic per seed; different seeds sound different', async ({ page }) => {
    const sc: Scenario = { seconds: 4, seed: SEED, state: { thrust: 0.5, atmosphereDensity: 0.5, airspeed: 80 } };
    const a = await measure(page, sc, sc);
    expect(a.diff!.rms).toBeLessThan(1e-5);
    const b = await measure(page, { ...sc, seed: SEED + 1 }, sc);
    expect(b.diff!.rms).toBeGreaterThan(1e-3);
  });

  test('the score loops seamlessly', async ({ page }) => {
    const loop = await page.evaluate(() => (window as unknown as { __ksAudio: Hooks }).__ksAudio.engine.score.loopSeconds);
    // Start 7 s before the end of the loop and play across the seam.
    const m = await measure(page, { seconds: 14, seed: SEED, scoreOffset: loop - 7, volumes: { sfx: 0 }, updateHz: 10 });
    expect(m.nonFinite).toBe(0);
    expect(m.click).toBeLessThan(9);
    const settled = m.windowRms.slice(6); // after the initial fade-in
    const db = settled.map((w) => 20 * Math.log10(w));
    const median = [...db].sort((x, y) => x - y)[Math.floor(db.length / 2)]!;
    for (const v of db) expect(Math.abs(v - median)).toBeLessThan(5);
  });
});

test('Audio Lab: Start audio unlocks a real AudioContext; cues play and caption', async ({ page }) => {
  await open(page);
  await expect(page.locator('.pill')).toHaveText('Audio locked');
  await page.click('.btn-start');
  await page.waitForFunction(() => (window as unknown as { __ksAudio: Hooks }).__ksAudio.engine.unlocked, null, { timeout: 30_000 });
  await expect(page.locator('.pill')).toHaveText('Audio running');
  await expect(page.locator('.caption', { hasText: '[Quiet cabin hum and soft avionics]' })).toBeVisible();
  await expect(page.locator('.caption', { hasText: '[Ambient music]' })).toBeVisible();
  await page.click('.cue-btn[data-cue="ui-select"]');
  await expect(page.locator('.caption', { hasText: '[Soft chime]' })).toBeVisible();
  await page.click('.cue-btn[data-cue="landing-contact"]');
  await expect(page.locator('.caption', { hasText: '[Landing gear thud]' })).toBeVisible();
  const t0 = await page.evaluate(() => (window as unknown as { __ksAudio: Hooks }).__ksAudio.engine.stats().musicTime ?? 0);
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => (window as unknown as { __ksAudio: Hooks }).__ksAudio.engine.stats());
  expect(s.contextState).toBe('running');
  expect(s.musicTime!).toBeGreaterThan(t0);
  expect(s.lastError).toBeNull();
});
