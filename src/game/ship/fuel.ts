/**
 * Hyper-fuel and star scooping: the fuel loop for the fictional hyperspeed drive (PRD M6, docs/FUEL.md).
 *
 * The physics input is real: the stellar flux the ship receives, F = L / (4 pi d^2), from the star's luminosity and
 * the ship's distance, expressed in units of the solar constant. Everything built on top of it is a game mechanic and
 * is labelled as fiction wherever the player sees it: the tank, the scoop band and its rate, the hull heat scale and
 * its limits, and the jump cost. docs/FUEL.md lists every formula and constant.
 *
 * Model (all deterministic; no randomness):
 * - Scooping works while the incident flux is at least FUEL.scoopMinFlux (1,000 x the solar constant), outside the
 *   photosphere, not landed and not in hyperspeed. The rate grows linearly with flux (capped) and with throttle.
 * - Hull heat h (0..1 of the fictional hull limit) follows a lumped radiative balance with a Stefan-Boltzmann
 *   cooling term: dh/dt = (F / F_crit - h^4) / tau. Its equilibrium is h_eq = (F / F_crit)^(1/4), the shape of a
 *   black body's equilibrium temperature. At equal distance in stellar radii a hotter star gives (T/T_sun)^4 more
 *   flux, so it fills the tank faster and heats the hull faster; dim M dwarfs need the ship much closer.
 * - Warnings rise at fixed heat levels with hysteresis; at 1.0 the system reports 'heat-emergency' once, and the
 *   ship controller forces an emergency climb.
 * - A jump costs max(minJumpCost, (d / 50 ly)^0.75) of the tank: a full tank reaches 50 ly, and the cost grows more
 *   slowly than distance.
 */
import { AU_M, SUN_LUMINOSITY_W } from '../../core/constants';

/**
 * Solar constant: total solar irradiance at 1 au, 1360.8 +/- 0.5 W/m^2 (Kopp & Lean 2011, Geophys. Res. Lett. 38,
 * L01706, doi:10.1029/2010GL045777), rounded to the IAU 2015 Resolution B3 nominal value of 1361 W/m^2.
 */
export const SOLAR_CONSTANT_W_M2 = 1361;

/** Stefan-Boltzmann constant (CODATA 2018; exact in the 2019 SI), W m^-2 K^-4. */
export const STEFAN_BOLTZMANN_W_M2_K4 = 5.670_374_419e-8;

/** The star the scoop and the hull see. Real values (Measured or Inferred), SI units. */
export interface StarEnv {
  /** Ship distance from the star's centre (m). */
  distanceM: number;
  /** Photospheric radius (m). */
  radiusM: number;
  /** Bolometric luminosity in solar units (IAU nominal L_sun = 3.828e26 W). */
  luminositySun: number;
  /** Effective temperature (K). Used to derive the luminosity when luminositySun is missing or invalid. */
  teffK: number;
}

export type FuelEvent = 'scoop-start' | 'scoop-stop' | 'tank-full' | 'heat-warning' | 'heat-critical' | 'heat-emergency' | 'fuel-low';

export type HeatState = 'nominal' | 'warning' | 'critical' | 'emergency';

export interface FuelContext {
  /** Flight mode ('thrusters' | 'impulse' | 'cruise' | 'hyperspeed'). The scoop is closed in hyperspeed. */
  mode: string;
  /** Throttle setpoint (-0.5..1); its magnitude opens the scoop wider. */
  throttle: number;
  landed: boolean;
}

/** Serialised fuel state (versioned for future migrations). */
export interface FuelSave {
  version: 1;
  hyperFuel: number;
  heat: number;
}

/**
 * Game-design numbers (fiction, not physics). docs/FUEL.md explains each one. Flux values are in units of the solar
 * constant; rates are fractions of the tank per second.
 */
export const FUEL = {
  /** Inner edge of the scoop band: the scoop works at or above this flux. */
  scoopMinFlux: 1_000,
  /** Scoop rate at the band edge at full throttle (a full tank in 240 s). */
  scoopRateAtEdge: 1 / 240,
  /** Scoop rate cap at full throttle (a full tank in 12 s). */
  scoopRateMax: 1 / 12,
  /** Fraction of the rate available at zero throttle (the scoop sweeps more gas when the ship moves). */
  scoopIdleFactor: 0.5,
  /** Flux whose radiative equilibrium is exactly the hull limit (heat 1). */
  heatLimitFlux: 20_000,
  /**
   * Thermal time constant at the hull limit (s). At exactly the limit flux the heat approaches 1 asymptotically (0.5 to
   * 0.99 takes about 15 s); above it the hull reaches 1 in finite time.
   */
  heatTimeConstantS: 12,
  /** Heat levels for warnings; each clears `heatHysteresis` below its level. */
  heatWarning: 0.7,
  heatCritical: 0.9,
  heatEmergency: 1,
  heatHysteresis: 0.05,
  /** 'fuel-low' fires below this fraction of the tank and re-arms `fuelLowHysteresis` above it. */
  fuelLow: 0.2,
  fuelLowHysteresis: 0.05,
  /** Jump cost: max(minJumpCost, (ly / rangeLy)^costExponent). */
  rangeLy: 50,
  costExponent: 0.75,
  minJumpCost: 0.04,
  /** Longest integration substep (s): an update is split into equal substeps of at most this length. Also the longest update honoured in one call (s). */
  maxSubstepS: 0.1,
  maxUpdateS: 3_600,
} as const;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Fraction-of-tank values closer than this to a threshold count as reaching it (float round-off). */
const EPS = 1e-9;

/** Star luminosity in watts: from luminositySun, or 4 pi R^2 sigma T^4 when that is missing or invalid. */
export function luminosityW(env: Pick<StarEnv, 'radiusM' | 'luminositySun' | 'teffK'>): number {
  if (Number.isFinite(env.luminositySun) && env.luminositySun > 0) return env.luminositySun * SUN_LUMINOSITY_W;
  const r = Number.isFinite(env.radiusM) && env.radiusM > 0 ? env.radiusM : 0;
  const t = Number.isFinite(env.teffK) && env.teffK > 0 ? env.teffK : 0;
  return 4 * Math.PI * r * r * STEFAN_BOLTZMANN_W_M2_K4 * t ** 4;
}

/**
 * Incident stellar flux at the ship, in units of the solar constant at 1 au: F = L / (4 pi d^2) / S0. The distance
 * is clamped to the photosphere (no flux is defined inside the star). The Sun at 1 au gives 1.000.
 */
export function fluxSolar(env: StarEnv): number {
  const L = luminosityW(env);
  const r = Number.isFinite(env.radiusM) && env.radiusM > 0 ? env.radiusM : 1;
  const d = Number.isFinite(env.distanceM) ? Math.max(env.distanceM, r) : Infinity;
  if (!Number.isFinite(d)) return 0;
  return L / (4 * Math.PI * d * d) / SOLAR_CONSTANT_W_M2;
}

/** Flux at the photosphere (solar-constant units), i.e. sigma T^4 expressed through L and R. */
export function surfaceFluxSolar(env: Pick<StarEnv, 'radiusM' | 'luminositySun' | 'teffK'>): number {
  return fluxSolar({ ...env, distanceM: env.radiusM });
}

/** Distance from the star's centre (m) at which the flux equals `flux` (solar-constant units). */
export function distanceForFlux(env: Pick<StarEnv, 'radiusM' | 'luminositySun' | 'teffK'>, flux: number): number {
  if (!(flux > 0)) return Infinity;
  return Math.sqrt(luminosityW(env) / (4 * Math.PI * flux * SOLAR_CONSTANT_W_M2));
}

/** True when a flux lies inside the scoop band. */
export function inScoopBand(flux: number): boolean {
  return flux >= FUEL.scoopMinFlux;
}

/** Scoop rate (fraction of the tank per second) at a flux and throttle. Zero outside the band. */
export function scoopRate(flux: number, throttle: number): number {
  if (!inScoopBand(flux)) return 0;
  const open = FUEL.scoopIdleFactor + (1 - FUEL.scoopIdleFactor) * clamp01(Math.abs(Number.isFinite(throttle) ? throttle : 0));
  return Math.min(FUEL.scoopRateMax, (FUEL.scoopRateAtEdge * flux) / FUEL.scoopMinFlux) * open;
}

/**
 * Radiative-equilibrium hull heat for a flux: (F / F_limit)^(1/4). Not clamped: values above 1 mean the hull would
 * pass its limit (the live heat value saturates at 1 and raises 'heat-emergency').
 */
export function equilibriumHeat(flux: number): number {
  return flux > 0 ? Math.pow(flux / FUEL.heatLimitFlux, 0.25) : 0;
}

/** Flux whose equilibrium heat is `heat` (inverse of equilibriumHeat). */
export function fluxForHeat(heat: number): number {
  return FUEL.heatLimitFlux * Math.max(0, heat) ** 4;
}

/** Fraction of a full tank one jump of `lightYears` costs. Infinity for invalid distances (NaN, infinite, negative). */
export function jumpCost(lightYears: number): number {
  if (!Number.isFinite(lightYears) || lightYears < 0) return Infinity;
  return Math.max(FUEL.minJumpCost, Math.pow(lightYears / FUEL.rangeLy, FUEL.costExponent));
}

/** Longest jump (ly) a given amount of fuel allows (inverse of jumpCost). */
export function rangeFor(hyperFuel: number): number {
  if (!(hyperFuel + EPS >= FUEL.minJumpCost)) return 0;
  return FUEL.rangeLy * Math.pow(Math.min(1, hyperFuel + EPS), 1 / FUEL.costExponent);
}

const STATES: readonly HeatState[] = ['nominal', 'warning', 'critical', 'emergency'];
const LEVEL_EVENTS: readonly (FuelEvent | null)[] = [null, 'heat-warning', 'heat-critical', 'heat-emergency'];
const LEVEL_THRESHOLDS = [0, FUEL.heatWarning, FUEL.heatCritical, FUEL.heatEmergency] as const;

/** Heat warning level reached by a heat value, ignoring hysteresis (0 nominal .. 3 emergency). */
function levelFor(heat: number): number {
  if (heat >= FUEL.heatEmergency - EPS) return 3;
  if (heat >= FUEL.heatCritical) return 2;
  if (heat >= FUEL.heatWarning) return 1;
  return 0;
}

/**
 * Next heat state from the previous one: rises straight to the highest level reached, falls one level at a time
 * once the heat is `heatHysteresis` below that level's threshold (so a value hovering at a threshold does not flap).
 */
export function heatStateFor(prev: HeatState, heat: number): HeatState {
  const from = STATES.indexOf(prev);
  const reached = levelFor(heat);
  if (reached >= from) return STATES[reached]!;
  let level = from;
  while (level > 0 && heat < LEVEL_THRESHOLDS[level]! - FUEL.heatHysteresis) level--;
  return STATES[level]!;
}

/** Low-fuel flag with hysteresis: set below FUEL.fuelLow, cleared at FUEL.fuelLow + fuelLowHysteresis. */
export function fuelLowFor(prev: boolean, hyperFuel: number): boolean {
  if (hyperFuel < FUEL.fuelLow - EPS) return true;
  if (hyperFuel >= FUEL.fuelLow + FUEL.fuelLowHysteresis) return false;
  return prev;
}

export class FuelSystem {
  /** Hyper-fuel in the tank, 0..1. */
  hyperFuel: number;
  /** Hull heat, 0..1 of the (fictional) hull limit. */
  heat: number;
  private _scooping = false;
  private _flux = 0;
  private _rate = 0;
  private _heatState: HeatState = 'nominal';
  /**
   * Highest heat level already reported by an event (0 nominal .. 3 emergency). It starts at nominal, so a system
   * created or restored with a hot hull reports its level on the first update, like 'fuel-low' does.
   */
  private announcedLevel = 0;
  private fuelLowArmed = true;

  constructor(init: { hyperFuel?: number; heat?: number } = {}) {
    this.hyperFuel = sanitize(init.hyperFuel, 1);
    this.heat = sanitize(init.heat, 0);
    this._heatState = STATES[levelFor(this.heat)]!;
  }

  /** True while the scoop is collecting fuel (in the band, eligible, tank not full). */
  get scooping(): boolean {
    return this._scooping;
  }

  /** Incident stellar flux from the last update, in units of the solar constant at 1 au. */
  get fluxSolar(): number {
    return this._flux;
  }

  /** Current scoop rate (fraction of the tank per second; 0 when not scooping). */
  get scoopRate(): number {
    return this._rate;
  }

  /** Seconds until the tank is full at the current rate, or null when not scooping. */
  get secondsToFull(): number | null {
    return this._scooping && this._rate > 0 ? (1 - this.hyperFuel) / this._rate : null;
  }

  /** Heat warning level (with hysteresis). */
  get heatState(): HeatState {
    return this._heatState;
  }

  /** Equilibrium heat at the current flux (where the hull settles if the ship holds position). */
  get equilibriumHeat(): number {
    return equilibriumHeat(this._flux);
  }

  jumpCost(lightYears: number): number {
    return jumpCost(lightYears);
  }

  canJump(lightYears: number): boolean {
    return this.hyperFuel + EPS >= jumpCost(lightYears);
  }

  /** Subtracts a jump's cost. Callers check canJump first; the tank never goes below empty. */
  consumeJump(lightYears: number): void {
    const cost = jumpCost(lightYears);
    if (!Number.isFinite(cost)) return;
    this.hyperFuel = clamp01(this.hyperFuel - cost);
    if (this.hyperFuel < EPS) this.hyperFuel = 0;
  }

  /** Fill the tank (debug, tests, new game). */
  refuel(amount = 1): void {
    this.hyperFuel = clamp01(this.hyperFuel + (Number.isFinite(amount) ? amount : 0));
  }

  /**
   * Advance by `dt` seconds near `env` (null in interstellar space). Returns the events that happened during this
   * step, in a fixed order: scoop-start, tank-full, scoop-stop, the highest newly reached heat level, fuel-low.
   */
  update(dt: number, env: StarEnv | null, ctx: FuelContext): FuelEvent[] {
    const events: FuelEvent[] = [];
    const span = Number.isFinite(dt) ? Math.min(FUEL.maxUpdateS, Math.max(0, dt)) : 0;
    const flux = env ? fluxSolar(env) : 0;
    this._flux = flux;
    const outside = env !== null && Number.isFinite(env.distanceM) && env.distanceM > env.radiusM;
    const eligible = outside && !ctx.landed && ctx.mode !== 'hyperspeed' && inScoopBand(flux);
    const rate = eligible ? scoopRate(flux, ctx.throttle) : 0;
    const wasScooping = this._scooping;
    const fuelBefore = this.hyperFuel;

    // Fixed substeps keep the stiff h^4 cooling term stable and make results independent of frame rate.
    const n = Math.max(1, Math.ceil(span / FUEL.maxSubstepS - 1e-9));
    const h = span / n;
    const drive = flux / FUEL.heatLimitFlux;
    let filled = false;
    const dhdt = (x: number): number => (drive - x * x * x * x) / FUEL.heatTimeConstantS;
    if (h > 0) {
      for (let i = 0; i < n; i++) {
        // Heun's method (second order) for the heat balance.
        const k1 = dhdt(this.heat);
        const k2 = dhdt(clamp01(this.heat + k1 * h));
        this.heat = clamp01(this.heat + 0.5 * (k1 + k2) * h);
        if (rate > 0 && this.hyperFuel < 1) {
          this.hyperFuel += rate * h;
          if (this.hyperFuel >= 1 - EPS) {
            this.hyperFuel = 1;
            filled = true;
          }
        }
      }
    }

    // Scoop state.
    const started = eligible && fuelBefore < 1 && !wasScooping && span > 0;
    const nowScooping = eligible && this.hyperFuel < 1;
    if (started || (!wasScooping && nowScooping)) events.push('scoop-start');
    if (filled) events.push('tank-full');
    if ((wasScooping || started) && !nowScooping) events.push('scoop-stop');
    this._scooping = nowScooping;
    this._rate = nowScooping ? rate : 0;

    // Heat warnings: one event for the highest newly reached level; levels fall back with hysteresis.
    this._heatState = heatStateFor(this._heatState, this.heat);
    const level = STATES.indexOf(this._heatState);
    if (level > this.announcedLevel) {
      const ev = LEVEL_EVENTS[level];
      if (ev) events.push(ev);
    }
    this.announcedLevel = level;

    // Low fuel: once per crossing (re-armed above the hysteresis band).
    const low = fuelLowFor(!this.fuelLowArmed, this.hyperFuel);
    if (low && this.fuelLowArmed) events.push('fuel-low');
    this.fuelLowArmed = !low;
    return events;
  }

  toJSON(): FuelSave {
    return { version: 1, hyperFuel: this.hyperFuel, heat: this.heat };
  }

  /** Restores a saved state; anything missing or corrupt falls back to a full tank and a cold hull, field by field. */
  static fromJSON(raw: unknown): FuelSystem {
    let obj: unknown = raw;
    if (typeof raw === 'string') {
      try {
        obj = JSON.parse(raw);
      } catch {
        obj = null;
      }
    }
    const r = typeof obj === 'object' && obj !== null && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
    const fuel = typeof r['hyperFuel'] === 'number' ? r['hyperFuel'] : undefined;
    const heat = typeof r['heat'] === 'number' ? r['heat'] : undefined;
    return new FuelSystem({ ...(fuel !== undefined ? { hyperFuel: fuel } : {}), ...(heat !== undefined ? { heat } : {}) });
  }
}

function sanitize(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : fallback;
}

// --- Persistence -----------------------------------------------------------------------------------------------------

export const FUEL_STORAGE_KEY = 'knownsky.fuel';

/** Minimal Storage surface (localStorage or a test double). */
export interface FuelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's localStorage, or null where storage is blocked (private mode, sandboxed frames). */
export function defaultFuelStorage(): FuelStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Loads the saved fuel state; a fresh full tank when nothing is stored or storage fails. */
export function loadFuel(storage: FuelStorage | null = defaultFuelStorage()): FuelSystem {
  try {
    const text = storage?.getItem(FUEL_STORAGE_KEY) ?? null;
    return text === null ? new FuelSystem() : FuelSystem.fromJSON(text);
  } catch {
    return new FuelSystem();
  }
}

/** Saves the fuel state; storage errors (quota, blocked) are ignored so the game keeps running. */
export function saveFuel(fuel: FuelSystem, storage: FuelStorage | null = defaultFuelStorage()): void {
  try {
    storage?.setItem(FUEL_STORAGE_KEY, JSON.stringify(fuel.toJSON()));
  } catch {
    // Storage blocked or full: the state still works for this session.
  }
}

/** Reference: flux at 1 au from the Sun in solar-constant units (1.000 by construction of S0 and L_sun). */
export const SUN_FLUX_AT_1AU = SUN_LUMINOSITY_W / (4 * Math.PI * AU_M * AU_M) / SOLAR_CONSTANT_W_M2;
