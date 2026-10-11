/**
 * Adaptive quality in the game (docs/QUALITY.md). Owns the QualityController, applies its levels to the renderer
 * (resolution, pixel-ratio cap, MSAA, bloom), the terrain, the starfield and the cockpit, feeds it the frame interval
 * of every rendered frame, and follows the quality setting.
 *
 * App holds one instance (`app.quality`) and calls three hooks: frame() once per rendered frame from tick(),
 * sceneChanged() from place() (teleports), and the boot level's atmosphere samples go to SolarSystem.create().
 */
import { Cockpit } from '../../render/cockpit/cockpit';
import { applyQuality, type QualityTarget } from '../../render/quality/applyQuality';
import { QualityController, type QualityLevel, type QualityName, type QualityPreset, type QualityStats } from '../../render/quality/quality';
import type { App } from '../app';
import { t } from '../i18n';

const PRESETS: readonly QualityPreset[] = ['auto', 'low', 'medium', 'high'];

/** A preset from a URL value (?quality=), or null when it names none. */
export function presetParam(v: string | null): QualityPreset | null {
  return v !== null && (PRESETS as readonly string[]).includes(v) ? (v as QualityPreset) : null;
}

/** The fixed level a benchmark measures at: ?quality=low|medium|high, else high ('auto' is not a level). */
export function benchLevel(params: URLSearchParams): Exclude<QualityPreset, 'auto'> {
  const p = presetParam(params.get('quality'));
  return p && p !== 'auto' ? p : 'high';
}

/** The star system an anchor belongs to ('sol', an exoplanet system id, a catalogue star "*i"), or null in transit. */
export function systemOf(anchor: string, exoSystemOf: (anchor: string) => string | undefined): string | null {
  if (anchor === 'ism') return null;
  const exo = exoSystemOf(anchor);
  if (exo !== undefined) return exo;
  return anchor.startsWith('*') ? anchor : 'sol';
}

export class GameQuality {
  readonly controller: QualityController;
  /**
   * Level the world was built at. Atmosphere samples are compiled into the sky and surface materials, so they follow
   * this level for the whole session (a preset chosen in Settings applies to them from the next load).
   */
  readonly bootLevel: QualityLevel;
  private applied: QualityLevel | undefined;
  /** Quality the current cockpit was built with. */
  private cockpitBuilt: 'low' | 'high';
  private terrainErrorPx: number;
  private anchor = '';
  private system: string | null = null;
  private readonly target: QualityTarget;
  private readonly offSettings: () => void;
  private readonly onResize = (): void => this.controller.reset();

  constructor(
    private readonly app: App,
    opts: { now?: () => number } = {},
  ) {
    // ?bench=1 builds the world at the benchmark's level, so its atmosphere samples match what is measured.
    const bench = app.params.get('bench') === '1';
    const preset = bench ? benchLevel(app.params) : this.playerPreset();
    this.controller = new QualityController({ preset, ...(opts.now ? { now: opts.now } : {}) });
    this.bootLevel = this.controller.level;
    this.cockpitBuilt = this.bootLevel.cockpit;
    this.terrainErrorPx = this.bootLevel.terrainErrorPx;
    const p = app.params;
    this.target = {
      setRenderScale: (scale, maxPixelRatio) => app.frame.setRenderScale(scale, maxPixelRatio),
      // ?msaa=0 and ?bloom=0 stay hard overrides (tests and screenshots use them).
      setMsaa: (samples) => app.frame.setMsaa(p.get('msaa') === '0' ? 0 : samples),
      setBloom: (on) => app.frame.setBloom(on && p.get('bloom') !== '0'),
      // Applied to every body in frame(), so bodies added later (arrivals at other stars) follow it too.
      setTerrainErrorPx: (px) => (this.terrainErrorPx = px),
      setCockpitQuality: (q) => this.rebuildCockpit(q),
      setStarMagLimit: (m) => (app.stars.magLimit.value = m),
    };
    this.offSettings = app.settings.onChange((data, changed) => {
      if (changed.has('quality')) this.setPreset(data.quality);
    });
    window.addEventListener('resize', this.onResize);
  }

  /** The preset the player asked for: ?quality= for this session, else the setting. */
  playerPreset(): QualityPreset {
    return presetParam(this.app.params.get('quality')) ?? this.app.settings.data.quality;
  }

  get level(): QualityLevel {
    return this.controller.level;
  }

  /** Pushes a level to the renderer (only the knobs that differ from the level applied last). */
  apply(level: QualityLevel = this.controller.level): void {
    applyQuality(this.target, level, this.applied);
    this.applied = level;
  }

  /** Switch preset (the setting, or the benchmark pinning a level) and apply the resulting level. */
  setPreset(p: QualityPreset): void {
    this.controller.setPreset(p);
    this.apply();
  }

  /**
   * Once per rendered frame, before the world is drawn: keeps terrain detail on every body, tells the controller about
   * arrivals in another star system, and feeds it the frame interval (not while a menu pauses the game).
   */
  frame(intervalMs: number, paused: boolean): void {
    const app = this.app;
    for (const v of app.sys.views) v.terrain.errorPx = this.terrainErrorPx;
    const anchor = app.cam.pos.anchor;
    if (anchor !== this.anchor) {
      this.anchor = anchor;
      // Crossing between bodies of one system changes nothing the frame times would not show; arriving in another
      // system does (new bodies, a new star), so the controller may probe higher levels again there.
      const system = systemOf(anchor, (a) => app.exoOf(a)?.spec.id);
      if (system !== null && system !== this.system) {
        if (this.system !== null) this.controller.sceneChanged();
        this.system = system;
      }
    }
    if (paused) return;
    const next = this.controller.sample(intervalMs);
    if (next) this.apply(next);
  }

  /** A teleport (named view, share link, restart): a new scene. */
  sceneChanged(): void {
    this.controller.sceneChanged();
  }

  /** "High · Auto" for the stats overlay. */
  hudValue(): string {
    const preset = this.controller.preset;
    return t('quality.hud.value', { level: t(`quality.level.${this.controller.level.name}`), preset: preset === 'auto' ? t('quality.hud.auto') : t('quality.hud.fixed') });
  }

  stats(): QualityStats & { bootLevel: QualityName } {
    return { ...this.controller.stats(), bootLevel: this.bootLevel.name };
  }

  dispose(): void {
    this.offSettings();
    window.removeEventListener('resize', this.onResize);
  }

  /**
   * Rebuilds the cockpit at another detail level. The new cockpit continues the old one's state, so the frame drawn
   * before the ship controller next drives it shows the same lighting (not default uniforms: a full-screen flash).
   */
  private rebuildCockpit(q: 'low' | 'high'): void {
    const app = this.app;
    const old = app.cockpit;
    if (!old || q === this.cockpitBuilt) return;
    const next = new Cockpit({ quality: q });
    next.continueFrom(old);
    const visible = app.frame.cockpitEnabled;
    old.dispose();
    app.cockpit = next;
    app.frame.cockpitScene.add(next.group);
    app.setCockpitVisible(visible);
    this.cockpitBuilt = q;
  }
}
