/**
 * Captions for every audio cue and for significant changes in the continuous ship sound. Keys live in
 * src/game/locales/en.audio.json; the game renders them with t(key). Pure logic, unit-tested.
 */
import type { AudioCue, AudioState } from './audioEngine';
import { windIntensity } from './mappings';

export interface CaptionDef {
  readonly key: string;
  /** Seconds the caption should stay on screen. */
  readonly duration: number;
}

const c = (key: string, duration: number): CaptionDef => ({ key: `audio.caption.${key}`, duration });

export const CUE_CAPTIONS: Readonly<Record<AudioCue, CaptionDef>> = {
  'ui-hover': c('uiHover', 1.2),
  'ui-select': c('uiSelect', 1.5),
  'ui-back': c('uiBack', 1.5),
  'target-lock': c('targetLock', 2),
  'mode-change': c('modeChange', 2),
  'hyperspeed-spool': c('hyperSpool', 3.5),
  'hyperspeed-engage': c('hyperEngage', 3.5),
  'hyperspeed-exit': c('hyperExit', 3.5),
  'scoop-warning': c('scoopWarning', 2.5),
  'heat-critical': c('heatCritical', 3),
  'landing-contact': c('landingContact', 2),
  alert: c('alert', 2.5),
  'codex-unlock': c('codexUnlock', 3),
  'fuel-low': c('fuelLow', 2.5),
};

export const STATE_CAPTIONS = {
  music: c('music', 3),
  cabin: c('cabin', 3.5),
  engineStart: c('engineStart', 3),
  engineSurge: c('engineSurge', 3),
  engineStop: c('engineStop', 2.5),
  engineShift: c('engineShift', 2.5),
  rcs: c('rcs', 2),
  windRising: c('windRising', 3),
  windStrong: c('windStrong', 3),
  windFading: c('windFading', 3),
  // Shares the cue's key: a spool started by state and by play('hyperspeed-spool') shows one caption.
  hyperSpool: c('hyperSpool', 3.5),
  hyperDrone: c('hyperDrone', 3.5),
  hyperWindDown: c('hyperWindDown', 3),
  heatStress: c('heatStress', 3),
} as const satisfies Record<string, CaptionDef>;

export const ALL_CAPTION_KEYS: readonly string[] = [
  ...new Set([...Object.values(CUE_CAPTIONS), ...Object.values(STATE_CAPTIONS)].map((d) => d.key)),
];

/**
 * Turns the continuous ship state into caption events, with hysteresis so jitter around a threshold never produces a
 * stream of captions. The first call compares against silence, so sounds already running when audio starts are
 * captioned.
 */
export class StateCaptioner {
  private engineOn = false;
  private engineSurge = false;
  private engineOffFor = 0;
  private wind: 0 | 1 | 2 = 0;
  private hyper: 'idle' | 'spool' | 'engaged' | 'down' = 'idle';
  private heat = false;
  private rcsCooldown = 0;
  private mode: AudioState['mode'] | null = null;

  update(dt: number, s: AudioState): CaptionDef[] {
    const out: CaptionDef[] = [];
    this.rcsCooldown = Math.max(0, this.rcsCooldown - dt);

    // Main engine (debounced off so short throttle taps do not caption twice).
    if (!this.engineOn && s.thrust > 0.06) {
      this.engineOn = true;
      this.engineOffFor = 0;
      // Straight to full thrust: one caption, the stronger one.
      this.engineSurge = s.thrust > 0.85;
      out.push(this.engineSurge ? STATE_CAPTIONS.engineSurge : STATE_CAPTIONS.engineStart);
    } else if (this.engineOn) {
      if (s.thrust < 0.02) {
        this.engineOffFor += dt;
        if (this.engineOffFor >= 0.6) {
          this.engineOn = false;
          this.engineSurge = false;
          out.push(STATE_CAPTIONS.engineStop);
        }
      } else this.engineOffFor = 0;
    }
    // The drive's tone changes with the mode while the engine runs.
    if (this.mode !== null && s.mode !== this.mode && this.engineOn && s.mode !== 'hyperspeed') out.push(STATE_CAPTIONS.engineShift);
    this.mode = s.mode;
    if (this.engineOn && !this.engineSurge && s.thrust > 0.85) {
      this.engineSurge = true;
      out.push(STATE_CAPTIONS.engineSurge);
    } else if (this.engineSurge && s.thrust < 0.6) this.engineSurge = false;

    // Attitude jets: rate limited.
    if (s.rcs > 0.15 && this.rcsCooldown === 0) {
      this.rcsCooldown = 6;
      out.push(STATE_CAPTIONS.rcs);
    }

    // Wind (only where there is air).
    const w = windIntensity(s.atmosphereDensity, s.airspeed);
    if (this.wind === 0 && w > 0.55) {
      this.wind = 2;
      out.push(STATE_CAPTIONS.windStrong);
    } else if (this.wind === 0 && w > 0.12) {
      this.wind = 1;
      out.push(STATE_CAPTIONS.windRising);
    } else if (this.wind === 1 && w > 0.55) {
      this.wind = 2;
      out.push(STATE_CAPTIONS.windStrong);
    } else if (this.wind === 2 && w < 0.4) this.wind = 1;
    if (this.wind > 0 && w < 0.05) {
      this.wind = 0;
      out.push(STATE_CAPTIONS.windFading);
    }

    // Hyperspeed.
    const h = s.hyperspeed;
    if (this.hyper === 'idle' && h > 0.04) {
      this.hyper = 'spool';
      out.push(STATE_CAPTIONS.hyperSpool);
    }
    if (this.hyper === 'spool' && h >= 0.97) {
      this.hyper = 'engaged';
      out.push(STATE_CAPTIONS.hyperDrone);
    } else if (this.hyper === 'spool' && h < 0.02) this.hyper = 'idle';
    if (this.hyper === 'engaged' && h < 0.5) {
      this.hyper = 'down';
      out.push(STATE_CAPTIONS.hyperWindDown);
    } else if (this.hyper === 'down' && h < 0.02) this.hyper = 'idle';
    else if (this.hyper === 'down' && h >= 0.97) {
      this.hyper = 'engaged';
      out.push(STATE_CAPTIONS.hyperDrone);
    }

    // Scoop heat stressing the hull.
    if (!this.heat && s.scoopHeat > 0.5) {
      this.heat = true;
      out.push(STATE_CAPTIONS.heatStress);
    } else if (this.heat && s.scoopHeat < 0.35) this.heat = false;

    return out;
  }
}

/** Suppresses a caption whose identical text is still on screen. */
export class CaptionGate {
  private readonly until = new Map<string, number>();

  allow(def: CaptionDef, now: number): boolean {
    const u = this.until.get(def.key);
    if (u !== undefined && now < u) return false;
    this.until.set(def.key, now + def.duration);
    return true;
  }
}
