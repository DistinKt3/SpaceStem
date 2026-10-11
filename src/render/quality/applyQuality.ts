/**
 * Pushes a QualityLevel to the systems that render it. The game implements QualityTarget over FrameRenderer
 * (resolution, MSAA, bloom), PlanetTerrain.errorPx, the Cockpit and the Starfield; see docs/QUALITY.md for the
 * integration and the cost of each knob (MSAA and cockpit changes rebuild GPU resources, so they are applied only when
 * they actually change).
 */
import type { QualityLevel } from './quality';

export interface QualityTarget {
  /** Scene buffer = CSS size x min(devicePixelRatio, maxPixelRatio) x scale; the canvas uses the capped ratio. */
  setRenderScale(scale: number, maxPixelRatio: number): void;
  setMsaa(samples: 0 | 4): void;
  setBloom(on: boolean): void;
  setTerrainErrorPx(px: number): void;
  setCockpitQuality(q: 'low' | 'high'): void;
  setStarMagLimit(m: number): void;
  /**
   * Optional: atmosphere ray-march samples. The TSL loop count is compiled into the sky and surface materials, so a
   * target may apply it only when materials are (re)built, or not at all.
   */
  setViewSamples?(n: number): void;
}

/**
 * Applies `level` to `target`. With `previous` (the level currently applied), only the knobs that differ are pushed,
 * so expensive changes (MSAA re-creates the scene buffer, the cockpit rebuilds its geometry) happen only when needed.
 * Returns the knobs that were applied.
 */
export function applyQuality(target: QualityTarget, level: QualityLevel, previous?: QualityLevel): (keyof QualityLevel)[] {
  const applied: (keyof QualityLevel)[] = [];
  const changed = (k: keyof QualityLevel): boolean => {
    const yes = !previous || previous[k] !== level[k];
    if (yes) applied.push(k);
    return yes;
  };
  // Resolution first: it is the largest saving and the others may allocate at the new size.
  const scale = changed('renderScale');
  const ratio = changed('maxPixelRatio');
  if (scale || ratio) target.setRenderScale(clamp(level.renderScale, 0.5, 1), Math.max(0.5, level.maxPixelRatio));
  if (changed('msaa')) target.setMsaa(level.msaa);
  if (changed('bloom')) target.setBloom(level.bloom);
  if (changed('terrainErrorPx')) target.setTerrainErrorPx(Math.max(0.5, level.terrainErrorPx));
  if (changed('cockpit')) target.setCockpitQuality(level.cockpit);
  if (changed('starMagLimit')) target.setStarMagLimit(level.starMagLimit);
  if (target.setViewSamples) {
    if (changed('viewSamples')) target.setViewSamples(Math.max(1, Math.round(level.viewSamples)));
  }
  return applied;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
