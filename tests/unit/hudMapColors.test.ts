/**
 * HUD and map colours come from CSS tokens that every palette (default, colour-blind, high contrast) can override,
 * and meet WCAG contrast on the space background: 4.5:1 for text, 3:1 for graphics the player must read (map scale
 * rings and orbits, the velocity marker). Regression for hard-coded HUD/map colours that ignored the palettes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composite, contrastRatio, parseColor, perceivedDifference, type Deficiency, type Rgba } from '../../src/game/settings/colorScience';
import { COLORBLIND_MODES, type ColorblindMode } from '../../src/game/settings/settings';

type Tokens = Record<string, string>;
interface Block {
  selector: string;
  tokens: Tokens;
  body: string;
}

function cssBlocks(css: string): Block[] {
  const out: Block[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Flatten @container / @media wrappers: their inner rules are ordinary blocks for this purpose.
  const flat = clean.replace(/@[a-z-]+[^{]*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g, '$1');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(flat); m; m = re.exec(flat)) {
    const tokens: Tokens = {};
    for (const d of m[2]!.split(';')) {
      const mm = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(d);
      if (mm) tokens[mm[1]!] = mm[2]!;
    }
    out.push({ selector: m[1]!.trim(), tokens, body: m[2]! });
  }
  return out;
}

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const sheets = {
  base: cssBlocks(read('../../src/game/styles.css')),
  ui: cssBlocks(read('../../src/game/ui/ui.css')),
  hud: cssBlocks(read('../../src/game/hud/hud.css')),
  map: cssBlocks(read('../../src/game/map/map.css')),
};
const ORDER = [sheets.base, sheets.ui, sheets.hud, sheets.map];

function tokensFor(mode: ColorblindMode): Tokens {
  const t: Tokens = {};
  for (const s of ORDER) for (const b of s) if (b.selector === ':root') Object.assign(t, b.tokens);
  if (mode !== 'none') {
    for (const s of ORDER) {
      for (const b of s) {
        if (b.selector.split(',').some((sel) => sel.trim() === `:root[data-colorblind='${mode}']`)) Object.assign(t, b.tokens);
      }
    }
  }
  return t;
}

const resolve = (t: Tokens, name: string): Rgba => {
  let v = t[name];
  for (let i = 0; i < 5 && v?.startsWith('var('); i++) v = t[/var\((--[\w-]+)/.exec(v)![1]!];
  if (!v) throw new Error(`missing token ${name}`);
  return parseColor(v);
};

const SIMS: Deficiency[] = ['protanopia', 'deuteranopia', 'tritanopia'];
/** Deficiencies each palette must survive (high contrast: all of them). */
const simsFor = (mode: ColorblindMode): (Deficiency | null)[] => (mode === 'high-contrast' ? [null, ...SIMS] : mode === 'none' ? [null] : [null, mode]);
const minDiff = (a: Rgba, b: Rgba, mode: ColorblindMode): number => Math.min(...simsFor(mode).map((s) => perceivedDifference(a, b, s)));

describe('HUD and map colour tokens', () => {
  for (const mode of COLORBLIND_MODES) {
    describe(mode, () => {
      const t = tokensFor(mode);
      const bg = resolve(t, '--ks-bg');
      const panel = composite(resolve(t, '--ks-panel'), bg);

      it('map scale ring text has >= 4.5:1 and ring / orbit lines >= 3:1 on the map background', () => {
        expect(contrastRatio(resolve(t, '--ks-map-ring-text'), bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(resolve(t, '--ks-map-ring'), bg)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(resolve(t, '--ks-map-orbit'), bg)).toBeGreaterThanOrEqual(3);
      });

      it('keeps planet orbits and reference rings apart', () => {
        expect(minDiff(resolve(t, '--ks-map-orbit'), resolve(t, '--ks-map-ring'), mode)).toBeGreaterThanOrEqual(10);
      });

      it('"you are here" is legible and distinct from the selected and the other labels', () => {
        const you = resolve(t, '--ks-map-you');
        expect(contrastRatio(you, bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(you, panel)).toBeGreaterThanOrEqual(4.5);
        expect(minDiff(you, resolve(t, '--ks-accent'), mode)).toBeGreaterThanOrEqual(10);
        expect(minDiff(you, resolve(t, '--ks-dim'), mode)).toBeGreaterThanOrEqual(10);
      });

      it('the velocity marker is visible and distinct from the reticle and target bracket', () => {
        const vel = resolve(t, '--ks-velocity');
        expect(contrastRatio(vel, bg)).toBeGreaterThanOrEqual(3);
        expect(minDiff(vel, resolve(t, '--ks-accent'), mode)).toBeGreaterThanOrEqual(15);
      });

      it('warning text has >= 4.5:1 on the warning box', () => {
        const box = composite(resolve(t, '--ks-hud-warn-bg'), bg);
        expect(contrastRatio(resolve(t, '--ks-warn'), box)).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  it('high contrast makes the warning box opaque and switches off the glows', () => {
    const t = tokensFor('high-contrast');
    expect(resolve(t, '--ks-hud-warn-bg').a).toBe(1);
    expect(t['--ks-glow']).toBe('0%');
  });

  it('hud.css and map.css take colours from tokens, not literals', () => {
    for (const [name, blocks] of [['hud.css', sheets.hud], ['map.css', sheets.map]] as const) {
      for (const b of blocks) {
        if (Object.keys(b.tokens).length > 0) continue; // Token definitions.
        const body = b.body
          .replace(/var\(--[\w-]+,\s*[^()]*(\([^()]*\))?[^()]*\)/g, 'var()') // fallbacks inside var()
          .replace(/rgba\(0, 0, 0, [\d.]+\)|#000\b|#000000\b/g, '') // black shadows and outlines
          .replace(/rgba\(255, 255, 255, 0\.08\)/g, ''); // the throttle track (neutral, every palette)
        expect(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(body), `${name}: ${b.selector} { ${b.body.trim()} }`).toBe(false);
      }
    }
  });
});
