/**
 * Audio verification without ears: the real engine graph is rendered faster than real time with an
 * OfflineAudioContext inside Chromium (audio.html exposes window.__ksAudio), then measured. Rendering is
 * deterministic, so rendering with and without a cue and subtracting isolates exactly what the cue adds.
 * The last test drives the live page with a real AudioContext.
 */
import { test, expect, type Page } from '@playwright/test';
import type { AudioCue } from '../../src/game/audio/audioEngine';
import { CUE_CAPTIONS } from '../../src/game/audio/captions';
import { EXIT_GLIDE_AT, EXIT_STAGGER } from '../../src/game/audio/cues';
import type { Measurement, Scenario } from '../../src/game/audio/offlineRender';
import { composeScore } from '../../src/game/audio/score';
import { exitShimmerNotes, inKey } from '../../src/game/audio/tuning';

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
  engine: {
    unlocked: boolean;
    score: { loopSeconds: number };
    stats(): { contextState: string; musicTime: number | null; suspended: boolean; activeLayers: number; lastError: string | null };
  };
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
    expect(drone.diff!.hfFraction).toBeLessThan(0.01);
  });

  test('hull sounds stay dark but reach small speakers: 150-600 Hz within 10 dB of the music', async ({ page }) => {
    for (const seed of [SEED, 3]) {
      const music = await measure(page, { seconds: 8, seed, volumes: { sfx: 0 } });
      const musicDb = 20 * Math.log10(music.midBandLate);
      const base: Scenario = { seconds: 6, seed, volumes: { music: 0 } };
      const states: Scenario['state'][] = [
        { hyperspeed: 1, mode: 'hyperspeed' },
        { thrust: 0.4, mode: 'thrusters' },
        { thrust: 0.4, mode: 'impulse' },
        { thrust: 0.4, mode: 'cruise', speedFraction: 0.5 },
      ];
      for (const state of states) {
        const m = await measure(page, { ...base, ...(state ? { state } : {}) }, base);
        const label = `seed ${seed} ${JSON.stringify(state)}`;
        expect(20 * Math.log10(m.diff!.midBandLate), label).toBeGreaterThan(musicDb - 10);
        expect(m.diff!.centroidHz, label).toBeLessThan(400); // still felt through the hull, not heard as a hiss
        expect(m.diff!.hfFraction, label).toBeLessThan(0.01);
      }
    }
  });

  test('the hyperspeed exit shimmer is the tonic triad in the score key, six distinct pitches', async ({ page }) => {
    for (const seed of [SEED, 1, 3]) {
      const score = composeScore(seed);
      const key = { tonic: score.tonic, steps: score.mode.steps };
      const base: Scenario = { seconds: 4, seed, volumes: { music: 0 } };
      // Every note has entered and none has started to glide yet: look at the onset pitches.
      const t0 = 0.4 + 0.01; // the cue starts 10 ms after play()
      const m = await measure(page, { ...base, steps: [{ at: 0.4, cue: 'hyperspeed-exit' }], peaksWindow: [t0 + 5 * EXIT_STAGGER + 0.04, t0 + EXIT_GLIDE_AT] }, base);
      const midi = m.diff!.peaksHz.slice(0, 6).map((hz) => 69 + 12 * Math.log2(hz / 440));
      expect(midi, `seed ${seed}`).toHaveLength(6);
      for (const x of midi) {
        expect(Math.abs(x - Math.round(x)), `seed ${seed} peak ${x.toFixed(2)} is a tempered pitch`).toBeLessThan(0.15);
        expect(inKey(key, Math.round(x)), `seed ${seed} peak ${x.toFixed(2)} in key`).toBe(true);
        expect(440 * Math.pow(2, (x - 69) / 12)).toBeLessThan(7000);
      }
      expect(new Set(midi.map(Math.round)), `seed ${seed}`).toEqual(new Set(exitShimmerNotes(key)));
    }
  });

  test('a warning is heard and captioned even when every cue voice is busy', async ({ page }) => {
    const busy: AudioCue[] = ['ui-hover', 'hyperspeed-engage', 'hyperspeed-exit', 'codex-unlock', 'hyperspeed-spool', 'landing-contact', 'target-lock', 'mode-change', 'ui-select', 'ui-back', 'scoop-warning', 'heat-critical'];
    const storm: Scenario = { seconds: 3, seed: SEED, volumes: { music: 0 }, steps: busy.map((cue, i) => ({ at: 0.3 + i * 0.004, cue })) };
    const withAlert = await measure(page, { ...storm, steps: [...storm.steps!, { at: 0.4, cue: 'alert' }] }, storm);
    expect(withAlert.diff!.rms).toBeGreaterThan(5e-4); // before priorities the 13th cue was dropped (diff 0)
    expect(keys(withAlert)).toContain('audio.caption.alert');
    expect(withAlert.peak).toBeLessThan(0.98);
    expect(withAlert.lastError).toBeNull();
  });

  test('mute, zero volume, NaN state and dispose are silent, finite and error-free', async ({ page }) => {
    const muted = await measure(page, { seconds: 2, seed: SEED, muted: true, state: { thrust: 1 }, steps: [{ at: 0.5, cue: 'alert' }] });
    expect(muted.rms).toBeLessThan(1e-6);
    // Silent, but still captioned: captions are for players who cannot hear the game.
    expect(keys(muted)).toEqual(expect.arrayContaining(['audio.caption.engineSurge', 'audio.caption.alert', 'audio.caption.cabin', 'audio.caption.music']));

    const zero = await measure(page, { seconds: 2, seed: SEED, volumes: { master: 0 }, state: { thrust: 1 }, steps: [{ at: 0.5, cue: 'fuel-low' }] });
    expect(zero.rms).toBeLessThan(1e-6);
    expect(keys(zero)).toEqual(expect.arrayContaining(['audio.caption.engineSurge', 'audio.caption.fuelLow']));

    // Unmuting brings back what is running (the layers rebuild and fade in).
    const unmute = await measure(page, { seconds: 4, seed: SEED, muted: true, volumes: { music: 0 }, state: { thrust: 0.6 }, steps: [{ at: 1.5, muted: false }] });
    expect(unmute.windowRms[1]!).toBeLessThan(1e-6);
    expect(unmute.windowRms[7]!).toBeGreaterThan(0.02);
    expect(unmute.click).toBeLessThan(9);

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
  const stats = (): Promise<ReturnType<Hooks['engine']['stats']>> => page.evaluate(() => (window as unknown as { __ksAudio: Hooks }).__ksAudio.engine.stats());
  const t0 = (await stats()).musicTime ?? 0;
  await page.waitForTimeout(600);
  const s = await stats();
  expect(s.contextState).toBe('running');
  expect(s.musicTime!).toBeGreaterThan(t0);
  expect(s.lastError).toBeNull();

  // Muted, the engine suspends its own context (no audio CPU) but stays unlocked and keeps captioning.
  await page.click('.toggle:has-text("Mute")');
  await page.waitForFunction(() => (window as unknown as { __ksAudio: Hooks }).__ksAudio.engine.stats().contextState === 'suspended', null, { timeout: 10_000 });
  expect((await stats()).suspended).toBe(true);
  await expect(page.locator('.pill')).toHaveText('Audio idle (muted)');
  await page.click('.cue-btn[data-cue="fuel-low"]');
  await expect(page.locator('.caption', { hasText: '[Low fuel tone]' })).toBeVisible();
  const frozen = (await stats()).musicTime!;
  await page.waitForTimeout(400);
  expect((await stats()).musicTime).toBeCloseTo(frozen, 3); // the score pauses in place
  await page.click('.toggle:has-text("Mute")');
  await page.waitForFunction(() => (window as unknown as { __ksAudio: Hooks }).__ksAudio.engine.stats().contextState === 'running', null, { timeout: 10_000 });
  await expect(page.locator('.pill')).toHaveText('Audio running');
  expect((await stats()).suspended).toBe(false);
  expect((await stats()).lastError).toBeNull();

  // A new seed disposes the engine and builds a new one with a different score; audio keeps running.
  const keyBefore = await page.locator('.score-meta b').innerText();
  await page.fill('#seed', '3');
  await page.dispatchEvent('#seed', 'change');
  await page.waitForFunction(() => (window as unknown as { __ksAudio: Hooks }).__ksAudio.engine.unlocked, null, { timeout: 30_000 });
  await expect(page.locator('.score-meta b')).not.toHaveText(keyBefore);
  await page.click('.cue-btn[data-cue="codex-unlock"]');
  await expect(page.locator('.caption', { hasText: '[Codex chime]' })).toBeVisible();
});
