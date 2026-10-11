import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { defaultBindings } from '../../src/game/input/actions';
import {
  composite,
  contrastRatio,
  deltaE2000,
  parseColor,
  perceivedDifference,
  simulateCvd,
  toLab,
  type Deficiency,
  type Rgba,
} from '../../src/game/settings/colorScience';
import {
  COLORBLIND_MODES,
  SETTINGS_SAVE_DELAY_MS,
  SETTINGS_STORAGE_KEY,
  SETTINGS_VERSION,
  Settings,
  defaultSettings,
  migrate,
  type ColorblindMode,
  type SettingsKey,
  type StorageLike,
} from '../../src/game/settings/settings';

const ENV = { prefersReducedMotion: false, prefersMoreContrast: false };

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

function withStored(value: unknown): { settings: Settings; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  storage.setItem(SETTINGS_STORAGE_KEY, typeof value === 'string' ? value : JSON.stringify(value));
  return { settings: new Settings({ storage, env: ENV }), storage };
}

describe('settings defaults', () => {
  it('has accessible defaults', () => {
    const d = new Settings({ storage: null, env: ENV }).data;
    expect(d.version).toBe(SETTINGS_VERSION);
    expect(d.textScale).toBe(1);
    expect(d.subtitles).toBe(true);
    expect(d.captionSize).toBe('medium');
    expect(d.colorblind).toBe('none');
    expect(d.reducedMotion).toBe(false);
    expect(d.quality).toBe('auto');
    expect(d.invertY).toBe(false);
    expect(d.bindings).toEqual(defaultBindings('kbm'));
    expect(d.padBindings).toEqual(defaultBindings('pad'));
  });

  it('follows prefers-reduced-motion and prefers-contrast', () => {
    expect(defaultSettings({ prefersReducedMotion: true, prefersMoreContrast: false }).reducedMotion).toBe(true);
    expect(defaultSettings({ prefersReducedMotion: false, prefersMoreContrast: true }).colorblind).toBe('high-contrast');
  });

  it('exposes read-only data', () => {
    const s = new Settings({ storage: null, env: ENV });
    expect(Object.isFrozen(s.data)).toBe(true);
    expect(Object.isFrozen(s.data.volumes)).toBe(true);
  });
});

describe('settings persistence', () => {
  it('round-trips through storage', () => {
    const storage = new MemoryStorage();
    const a = new Settings({ storage, env: ENV });
    a.set({ textScale: 1.5, colorblind: 'tritanopia', volumes: { music: 0.25 }, invertY: true });
    expect(storage.getItem(SETTINGS_STORAGE_KEY)).toBeNull(); // debounced
    a.flush();
    const b = new Settings({ storage, env: ENV });
    expect(b.data.textScale).toBe(1.5);
    expect(b.data.colorblind).toBe('tritanopia');
    expect(b.data.volumes).toEqual({ master: 0.8, music: 0.25, sfx: 0.8 });
    expect(b.data.invertY).toBe(true);
    expect((JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)!) as { version: number }).version).toBe(SETTINGS_VERSION);
  });

  it('recovers from corrupt data with defaults', () => {
    for (const bad of ['{not json', '42', '[]', 'null', '"text"', '']) {
      const { settings } = withStored(bad);
      expect(settings.data, bad).toEqual(defaultSettings(ENV));
      if (bad !== '') expect(settings.lastLoadIssue, bad).toBe('corrupt');
    }
  });

  it('keeps valid fields and repairs the rest one by one', () => {
    const { settings } = withStored({
      version: 1,
      textScale: 7,
      colorblind: 'purple',
      reducedMotion: 'yes',
      subtitles: false,
      captionSize: 'large',
      volumes: { master: -2, music: 0.333333, sfx: 'loud' },
      quality: 'ultra',
      mouseSensitivity: Number.NaN,
      fovDeg: 75.4,
      bindings: {
        toggleMap: [{ type: 'key', code: 'KeyO' }, null],
        thrust: [{ type: 'key', code: 'KeyW' }, null], // a single key cannot drive an axis
        pause: [{ type: 'key', code: 'KeyP' }, { type: 'key', code: 'F10' }], // Escape is fixed
        toggleCodex: 'junk',
        notAnAction: [{ type: 'key', code: 'KeyZ' }, null],
      },
    });
    const d = settings.data;
    expect(d.textScale).toBe(2);
    expect(d.colorblind).toBe('none');
    expect(d.reducedMotion).toBe(false);
    expect(d.subtitles).toBe(false);
    expect(d.captionSize).toBe('large');
    expect(d.volumes).toEqual({ master: 0, music: 0.33, sfx: 0.8 });
    expect(d.quality).toBe('auto');
    expect(d.mouseSensitivity).toBe(1);
    expect(d.fovDeg).toBe(75);
    expect(d.bindings['toggleMap']).toEqual([{ type: 'key', code: 'KeyO' }, null]);
    expect(d.bindings['thrust']).toEqual(defaultBindings('kbm')['thrust']);
    expect(d.bindings['pause']).toEqual([{ type: 'key', code: 'Escape' }, { type: 'key', code: 'F10' }]);
    expect(d.bindings['toggleCodex']).toEqual(defaultBindings('kbm')['toggleCodex']);
    expect(d.bindings['notAnAction']).toBeUndefined();
    expect(d.padBindings).toEqual(defaultBindings('pad'));
  });

  it('migrates unversioned data', () => {
    const { settings } = withStored({ textScale: 1.25, subtitles: false });
    expect(settings.data.version).toBe(SETTINGS_VERSION);
    expect(settings.data.textScale).toBe(1.25);
    expect(settings.data.subtitles).toBe(false);
  });

  it('runs migrations in order from the stored version', () => {
    const steps = {
      0: (r: Record<string, unknown>) => ({ ...r, trail: [...((r['trail'] as string[] | undefined) ?? []), 'a'] }),
      1: (r: Record<string, unknown>) => ({ ...r, trail: [...(r['trail'] as string[]), 'b'], renamed: r['old'] }),
      2: (r: Record<string, unknown>) => ({ ...r, trail: [...(r['trail'] as string[]), 'c'] }),
    };
    expect(migrate({ old: 5 }, steps, 3)).toMatchObject({ version: 3, trail: ['a', 'b', 'c'], renamed: 5 });
    expect(migrate({ version: 2, trail: [] }, steps, 3)).toMatchObject({ version: 3, trail: ['c'] });
    expect(migrate({ version: 9, x: 1 }, steps, 3)).toEqual({ version: 9, x: 1 }); // newer data is left for sanitising
  });

  it('reads data written by a newer version without losing known fields', () => {
    const { settings } = withStored({ version: 99, textScale: 1.5, futureField: true });
    expect(settings.data.textScale).toBe(1.5);
    expect(settings.data.version).toBe(SETTINGS_VERSION);
  });

  it('debounces saves: a burst of changes (a slider drag) writes once', () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const writes: string[] = [];
      const counting: StorageLike = { getItem: (k) => storage.getItem(k), setItem: (k, v) => (writes.push(v), storage.setItem(k, v)) };
      const s = new Settings({ storage: counting, env: ENV });
      for (let i = 1; i <= 30; i++) {
        s.set({ volumes: { music: i / 100 } });
        vi.advanceTimersByTime(16);
      }
      expect(writes).toHaveLength(0);
      vi.advanceTimersByTime(SETTINGS_SAVE_DELAY_MS);
      expect(writes).toHaveLength(1);
      expect((JSON.parse(writes[0]!) as { volumes: { music: number } }).volumes.music).toBe(0.3);
      s.set({ fovDeg: 80 });
      s.flush(); // e.g. on pagehide
      expect(writes).toHaveLength(2);
      vi.advanceTimersByTime(SETTINGS_SAVE_DELAY_MS * 2);
      expect(writes).toHaveLength(2);
      const now = new Settings({ storage: counting, env: ENV, saveDelayMs: 0 });
      now.set({ fovDeg: 90 });
      expect(writes).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('migrates version 1 data, which pinned the system-derived values', () => {
    const { settings } = withStored({ version: 1, reducedMotion: false, colorblind: 'none', textScale: 1.5 });
    expect(settings.data.textScale).toBe(1.5);
    expect(settings.isOverridden('reducedMotion')).toBe(false);
    expect(settings.isOverridden('colorblind')).toBe(false);
    settings.setEnvironment({ prefersReducedMotion: true, prefersMoreContrast: true });
    expect(settings.data.reducedMotion).toBe(true);
    expect(settings.data.colorblind).toBe('high-contrast');
    // Real choices survive the migration.
    const kept = withStored({ version: 1, reducedMotion: true, colorblind: 'tritanopia' }).settings;
    expect(kept.data.reducedMotion).toBe(true);
    expect(kept.data.colorblind).toBe('tritanopia');
    expect(kept.isOverridden('colorblind')).toBe(true);
  });

  it('survives storage that throws', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const s = new Settings({ storage: throwing, env: ENV });
    expect(s.lastLoadIssue).toBe('unavailable');
    expect(() => s.set({ textScale: 1.2 })).not.toThrow();
    expect(s.data.textScale).toBe(1.2);
  });
});

describe('settings changes', () => {
  it('clamps patches, notifies changed keys only, and supports unsubscribe', () => {
    const s = new Settings({ storage: null, env: ENV });
    const seen: SettingsKey[][] = [];
    const off = s.onChange((_, changed) => seen.push([...changed]));
    s.set({ textScale: 0.1 });
    expect(s.data.textScale).toBe(0.8);
    s.set({ textScale: 0.8 }); // no change, no event
    s.set({ volumes: { sfx: 0.5 }, showFps: true });
    expect(seen).toEqual([['textScale'], ['volumes', 'showFps']]);
    off();
    s.set({ showFps: false });
    expect(seen).toHaveLength(2);
  });

  it('keeps mouse sensitivity at the two decimals the slider shows', () => {
    const s = new Settings({ storage: null, env: ENV });
    s.set({ mouseSensitivity: 0.1216 }); // a log-scale slider position
    expect(s.data.mouseSensitivity).toBe(0.12);
    s.set({ mouseSensitivity: 9 });
    expect(s.data.mouseSensitivity).toBe(5);
  });

  it('keeps the current value when a patch is invalid', () => {
    const s = new Settings({ storage: null, env: ENV });
    s.set({ colorblind: 'protanopia' });
    s.set({ colorblind: 'sepia' as ColorblindMode });
    expect(s.data.colorblind).toBe('protanopia');
  });

  it('resets keys or everything', () => {
    const s = new Settings({ storage: null, env: ENV });
    s.set({ textScale: 2, fovDeg: 90 });
    s.reset(['fovDeg']);
    expect(s.data.fovDeg).toBe(60);
    expect(s.data.textScale).toBe(2);
    s.reset();
    expect(s.data.textScale).toBe(1);
  });

  it('keeps following the system preferences until the player overrides them', () => {
    const storage = new MemoryStorage();
    const stored = (): Record<string, unknown> => JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)!) as Record<string, unknown>;
    const s = new Settings({ storage, env: ENV, saveDelayMs: 0 });
    const seen: SettingsKey[][] = [];
    s.onChange((_, changed) => seen.push([...changed]));
    // An unrelated change saves, but does not pin the system-derived values.
    s.set({ volumes: { music: 0.3 } });
    expect(stored()).not.toHaveProperty('reducedMotion');
    expect(stored()).not.toHaveProperty('colorblind');
    // The system now asks for reduced motion: live, and on the next launch.
    s.setEnvironment({ prefersReducedMotion: true, prefersMoreContrast: false });
    expect(s.data.reducedMotion).toBe(true);
    expect(seen.at(-1)).toEqual(['reducedMotion']);
    expect(new Settings({ storage, env: { prefersReducedMotion: true, prefersMoreContrast: false } }).data.reducedMotion).toBe(true);
    // An explicit choice that differs from the system is stored and wins, whatever the system says later.
    s.set({ reducedMotion: false });
    expect(s.isOverridden('reducedMotion')).toBe(true);
    expect(stored()['reducedMotion']).toBe(false);
    s.setEnvironment({ prefersReducedMotion: false, prefersMoreContrast: false });
    s.setEnvironment({ prefersReducedMotion: true, prefersMoreContrast: false });
    expect(s.data.reducedMotion).toBe(false);
    expect(new Settings({ storage, env: { prefersReducedMotion: true, prefersMoreContrast: false } }).data.reducedMotion).toBe(false);
    // Choosing the system's value again follows the system again.
    s.set({ reducedMotion: true });
    expect(s.isOverridden('reducedMotion')).toBe(false);
    expect(stored()).not.toHaveProperty('reducedMotion');
    s.setEnvironment({ prefersReducedMotion: false, prefersMoreContrast: false });
    expect(s.data.reducedMotion).toBe(false);
  });

  it('follows prefers-contrast for the colour mode until a mode is chosen, and reset follows it again', () => {
    const s = new Settings({ storage: null, env: ENV });
    s.setEnvironment({ prefersReducedMotion: false, prefersMoreContrast: true });
    expect(s.data.colorblind).toBe('high-contrast');
    s.set({ colorblind: 'deuteranopia' });
    s.setEnvironment({ prefersReducedMotion: false, prefersMoreContrast: false });
    expect(s.data.colorblind).toBe('deuteranopia');
    s.reset(['colorblind']);
    expect(s.data.colorblind).toBe('none');
    expect(s.isOverridden('colorblind')).toBe(false);
    s.setEnvironment({ prefersReducedMotion: false, prefersMoreContrast: true });
    expect(s.data.colorblind).toBe('high-contrast');
  });

  it('applies text scale, colour mode and reduced motion to the document root', () => {
    const props = new Map<string, string>();
    const root = { style: { fontSize: '', setProperty: (k: string, v: string) => props.set(k, v) }, dataset: {} as Record<string, string> };
    const s = new Settings({ storage: null, env: ENV });
    s.applyToDocument(root as unknown as HTMLElement);
    expect(root.style.fontSize).toBe('100%');
    expect(root.dataset['colorblind']).toBe('none');
    expect(root.dataset['reducedMotion']).toBe('false');
    s.set({ textScale: 2, colorblind: 'high-contrast', reducedMotion: true });
    expect(root.style.fontSize).toBe('200%');
    expect(props.get('--ks-text-scale')).toBe('2');
    expect(root.dataset['colorblind']).toBe('high-contrast');
    expect(root.dataset['reducedMotion']).toBe('true');
  });
});

// --- Colour science ---------------------------------------------------------------------------------------------------

describe('colour science', () => {
  it('computes WCAG contrast', () => {
    expect(contrastRatio(parseColor('#000'), parseColor('#fff'))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor('#777777'), parseColor('#ffffff'))).toBeCloseTo(4.48, 2);
    expect(parseColor('rgba(8, 18, 34, 0.55)')).toEqual({ r: 8, g: 18, b: 34, a: 0.55 });
  });

  it('matches the CIEDE2000 reference data (Sharma et al. 2005)', () => {
    expect(deltaE2000({ l: 50, a: 2.6772, b: -79.7751 }, { l: 50, a: 0, b: -82.7485 })).toBeCloseTo(2.0425, 3);
    expect(deltaE2000({ l: 50, a: 2.5, b: 0 }, { l: 73, a: 25, b: -18 })).toBeCloseTo(27.1492, 3);
    expect(deltaE2000({ l: 2.0776, a: 0.0795, b: -1.135 }, { l: 0.9033, a: -0.0636, b: -0.5514 })).toBeCloseTo(0.9082, 3);
  });

  it('simulates dichromacy: neutrals stay neutral, red and green collapse for deuteranopes', () => {
    const white = simulateCvd(parseColor('#ffffff'), 'deuteranopia');
    expect(white.r).toBeGreaterThan(250);
    expect(white.b).toBeGreaterThan(250);
    const red = parseColor('#d00000');
    const green = parseColor('#00a000');
    expect(perceivedDifference(red, green, null)).toBeGreaterThan(60);
    expect(perceivedDifference(red, green, 'deuteranopia')).toBeLessThan(perceivedDifference(red, green, null) / 2);
    expect(toLab(parseColor('#ffffff')).l).toBeCloseTo(100, 1);
  });
});

// --- Palettes in ui.css -----------------------------------------------------------------------------------------------

type Tokens = Record<string, string>;

function cssBlocks(css: string): { selector: string; tokens: Tokens }[] {
  const out: { selector: string; tokens: Tokens }[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    const tokens: Tokens = {};
    for (const d of m[2]!.split(';')) {
      const mm = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(d);
      if (mm) tokens[mm[1]!] = mm[2]!;
    }
    out.push({ selector: m[1]!.trim(), tokens });
  }
  return out;
}

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const baseCss = cssBlocks(read('../../src/game/styles.css'));
const uiCss = cssBlocks(read('../../src/game/ui/ui.css'));
const rootOf = (blocks: { selector: string; tokens: Tokens }[]): Tokens => Object.assign({}, ...blocks.filter((b) => b.selector === ':root').map((b) => b.tokens)) as Tokens;
const BASE: Tokens = { ...rootOf(baseCss), ...rootOf(uiCss) };

function paletteTokens(mode: ColorblindMode): Tokens {
  const block = uiCss.find((b) => b.selector.includes(`:root[data-colorblind='${mode}']`));
  return { ...BASE, ...(block?.tokens ?? {}) };
}

const resolve = (t: Tokens, name: string): Rgba => {
  let v = t[name];
  for (let i = 0; i < 5 && v?.startsWith('var('); i++) v = t[/var\((--[\w-]+)/.exec(v)![1]!];
  if (!v) throw new Error(`missing token ${name}`);
  return parseColor(v);
};

const TEXT_TOKENS = ['--ks-fg', '--ks-dim', '--ks-accent', '--ks-measured', '--ks-inferred', '--ks-generated', '--ks-warn', '--ks-danger', '--ks-ok'];
const SIMS: Deficiency[] = ['protanopia', 'deuteranopia', 'tritanopia'];
const WHITE = parseColor('#ffffff');

function minPairDifference(colors: Rgba[], sim: Deficiency | null): number {
  let m = Infinity;
  for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) m = Math.min(m, perceivedDifference(colors[i]!, colors[j]!, sim));
  return m;
}

describe('colour-blind palettes', () => {
  it('defines a root palette for every non-default mode and a preview for every mode', () => {
    for (const mode of COLORBLIND_MODES) {
      if (mode !== 'none') expect(uiCss.some((b) => b.selector.includes(`:root[data-colorblind='${mode}']`)), mode).toBe(true);
      expect(uiCss.some((b) => b.selector.includes(`.ks-palette[data-colorblind='${mode}']`)), mode).toBe(true);
    }
  });

  it('keeps the default preview card in sync with styles.css', () => {
    const preview = uiCss.find((b) => b.selector === ".ks-palette[data-colorblind='none']")!.tokens;
    for (const [k, v] of Object.entries(preview)) expect(v.toLowerCase(), k).toBe(BASE[k]!.toLowerCase());
  });

  for (const mode of COLORBLIND_MODES) {
    describe(mode, () => {
      const t = paletteTokens(mode);
      const bg = resolve(t, '--ks-bg');
      const panel = composite(resolve(t, '--ks-panel'), bg);
      // Settings dialog surface over its scrim over a white (sunlit) scene: the worst case behind the glass.
      const dialog = composite(resolve(t, '--ks-surface'), composite(resolve(t, '--ks-scrim'), WHITE));

      it('has text colours with at least 4.5:1 contrast on the panel and dialog backgrounds', () => {
        for (const name of TEXT_TOKENS) {
          const c = resolve(t, name);
          expect(contrastRatio(c, panel), `${name} on panel`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(c, dialog), `${name} on dialog`).toBeGreaterThanOrEqual(4.5);
        }
      });

      const prov = ['--ks-measured', '--ks-inferred', '--ks-generated'].map((n) => resolve(t, n));
      it('keeps Measured, Inferred and Generated distinct with normal vision', () => {
        expect(minPairDifference(prov, null)).toBeGreaterThanOrEqual(20);
      });

      // A provenance colour equal (or close) to plain text would present that provenance as ordinary data.
      it('keeps every provenance colour distinct from plain text', () => {
        const fg = resolve(t, '--ks-fg');
        for (const [i, name] of ['--ks-measured', '--ks-inferred', '--ks-generated'].entries()) {
          expect(t[name]!.toLowerCase(), name).not.toBe(t['--ks-fg']!.toLowerCase());
          for (const sim of [null, ...(mode === 'none' ? [] : SIMS)]) {
            expect(perceivedDifference(prov[i]!, fg, sim), `${name} vs text${sim ? ` (${sim})` : ''}`).toBeGreaterThanOrEqual(10);
          }
        }
      });

      // Each CVD palette must survive its own deficiency; high contrast must survive all of them.
      const targets: Deficiency[] = mode === 'high-contrast' ? SIMS : mode === 'none' ? [] : [mode];
      for (const sim of targets) {
        it(`keeps the provenance colours distinguishable under simulated ${sim}`, () => {
          expect(minPairDifference(prov, sim)).toBeGreaterThanOrEqual(20);
        });
        it(`keeps ok / warn / danger apart under simulated ${sim}`, () => {
          const status = ['--ks-ok', '--ks-warn', '--ks-danger'].map((n) => resolve(t, n));
          expect(minPairDifference(status, sim)).toBeGreaterThanOrEqual(10);
        });
      }
    });
  }

  it('separates the high-contrast provenance colours in greyscale too (achromatopsia, beyond the target set)', () => {
    const t = paletteTokens('high-contrast');
    const prov = ['--ks-measured', '--ks-inferred', '--ks-generated'].map((n) => resolve(t, n));
    expect(minPairDifference(prov, 'achromatopsia')).toBeGreaterThanOrEqual(6);
  });

  it('documents why the CVD modes exist: the default palette merges two provenance colours for deuteranopes', () => {
    const t = paletteTokens('none');
    const prov = ['--ks-measured', '--ks-inferred', '--ks-generated'].map((n) => resolve(t, n));
    expect(minPairDifference(prov, 'deuteranopia')).toBeLessThan(10);
  });
});
