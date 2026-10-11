/**
 * Player settings: accessibility, audio, graphics and control bindings. Persisted to localStorage as versioned JSON;
 * every storage access is guarded (private mode, blocked storage and quota errors must never break the game), stored
 * data is migrated step by step to the current version and then sanitised field by field, so corrupt or hand-edited
 * data degrades to defaults one field at a time instead of failing.
 */
import { ACTIONS, FIXED, bindingAllowed, defaultBindings } from '../input/actions';
import { parseBinding, sameBinding, type Binding, type BindingMap, type BindingSlots, type InputContext } from '../input/bindings';

export type ColorblindMode = 'none' | 'deuteranopia' | 'protanopia' | 'tritanopia' | 'high-contrast';
export type CaptionSize = 'small' | 'medium' | 'large';
export type QualityPreset = 'auto' | 'low' | 'medium' | 'high';

export const COLORBLIND_MODES: readonly ColorblindMode[] = ['none', 'deuteranopia', 'protanopia', 'tritanopia', 'high-contrast'];
export const CAPTION_SIZES: readonly CaptionSize[] = ['small', 'medium', 'large'];
export const QUALITY_PRESETS: readonly QualityPreset[] = ['auto', 'low', 'medium', 'high'];

export interface Volumes {
  master: number;
  music: number;
  sfx: number;
}

export interface SettingsData {
  version: number;
  /** Root text scale, 0.8..2 (applied as the :root font-size, so every rem-based UI scales). */
  textScale: number;
  colorblind: ColorblindMode;
  /** Defaults from prefers-reduced-motion. */
  reducedMotion: boolean;
  subtitles: boolean;
  captionSize: CaptionSize;
  /** 0..1 each. */
  volumes: Volumes;
  quality: QualityPreset;
  /** Multiplier on mouse look, 0.1..5. */
  mouseSensitivity: number;
  /** Flips mouse and gamepad-stick pitch. */
  invertY: boolean;
  /** Vertical field of view in degrees. */
  fovDeg: number;
  showFps: boolean;
  /** Keyboard and mouse bindings: action id to its two slots. */
  bindings: Record<string, [Binding | null, Binding | null]>;
  /** Gamepad bindings: action id to its two slots. */
  padBindings: Record<string, [Binding | null, Binding | null]>;
}

/** A patch may set volumes partially. */
export type SettingsPatch = Partial<Omit<SettingsData, 'volumes' | 'version'>> & { volumes?: Partial<Volumes> };

export const SETTINGS_VERSION = 1;
export const SETTINGS_STORAGE_KEY = 'knownsky.settings';

export const LIMITS = {
  textScale: { min: 0.8, max: 2, step: 0.05 },
  mouseSensitivity: { min: 0.1, max: 5, step: 0.05 },
  fovDeg: { min: 45, max: 100, step: 1 },
  volume: { min: 0, max: 1, step: 0.01 },
} as const;

export interface SettingsEnvironment {
  prefersReducedMotion: boolean;
  prefersMoreContrast: boolean;
}

/** Minimal Storage surface (localStorage or a test double). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function detectEnvironment(): SettingsEnvironment {
  const q = (query: string): boolean => {
    try {
      return typeof matchMedia === 'function' && matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  return { prefersReducedMotion: q('(prefers-reduced-motion: reduce)'), prefersMoreContrast: q('(prefers-contrast: more)') };
}

export function defaultSettings(env: SettingsEnvironment = { prefersReducedMotion: false, prefersMoreContrast: false }): SettingsData {
  return {
    version: SETTINGS_VERSION,
    textScale: 1,
    colorblind: env.prefersMoreContrast ? 'high-contrast' : 'none',
    reducedMotion: env.prefersReducedMotion,
    subtitles: true,
    captionSize: 'medium',
    volumes: { master: 0.8, music: 0.6, sfx: 0.8 },
    quality: 'auto',
    mouseSensitivity: 1,
    invertY: false,
    fovDeg: 60,
    showFps: false,
    bindings: defaultBindings('kbm'),
    padBindings: defaultBindings('pad'),
  };
}

// --- Migration and sanitising ---------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;
/** MIGRATIONS[v] upgrades stored data from version v to v + 1. */
export type MigrationTable = Readonly<Record<number, (raw: Raw) => Raw>>;

export const MIGRATIONS: MigrationTable = {
  // Version 0: data written before settings carried a version number. Field names are unchanged, so stamping the
  // version is enough; sanitising below fills anything missing.
  0: (raw) => ({ ...raw, version: 1 }),
};

/** Upgrades raw stored data step by step. Unknown future versions are kept as-is and sanitised field by field. */
export function migrate(raw: Raw, migrations: MigrationTable = MIGRATIONS, target = SETTINGS_VERSION): Raw {
  let v = typeof raw['version'] === 'number' && Number.isInteger(raw['version']) && raw['version'] >= 0 ? raw['version'] : 0;
  let out = raw;
  while (v < target) {
    const step = migrations[v];
    out = step ? step(out) : { ...out };
    v += 1;
    out = { ...out, version: v };
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const roundTo = (v: number, step: number): number => Math.round(v / step) * step;
const num = (v: unknown, lo: number, hi: number, step: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Number(roundTo(clamp(v, lo, hi), step).toFixed(4)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;

function sanitizeBindings(raw: unknown, context: InputContext, fallback: BindingMap): BindingMap {
  const out: BindingMap = {};
  const src = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Raw) : {};
  for (const a of ACTIONS) {
    const def = fallback[a.id] ?? [null, null];
    const entry = src[a.id];
    if (!Array.isArray(entry) || entry.length !== 2) {
      out[a.id] = [def[0], def[1]];
      continue;
    }
    const slots: BindingSlots = [null, null];
    const fixed = FIXED[context][a.id];
    for (const slot of [0, 1] as const) {
      if (fixed?.slot === slot) {
        slots[slot] = fixed.binding;
        continue;
      }
      const v: unknown = entry[slot];
      const b = v === null ? null : parseBinding(v);
      // An unreadable or disallowed slot falls back to its default rather than silently unbinding.
      slots[slot] = (v === null || b !== null) && bindingAllowed(context, a.id, slot, b) ? b : def[slot];
    }
    out[a.id] = slots;
  }
  return out;
}

/** Produces valid settings from anything: missing, wrong-typed or out-of-range fields take their default. */
export function sanitize(raw: unknown, defaults: SettingsData): SettingsData {
  const r: Raw = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Raw) : {};
  const vol: Raw = typeof r['volumes'] === 'object' && r['volumes'] !== null ? (r['volumes'] as Raw) : {};
  const L = LIMITS;
  return {
    version: SETTINGS_VERSION,
    textScale: num(r['textScale'], L.textScale.min, L.textScale.max, L.textScale.step, defaults.textScale),
    colorblind: oneOf(r['colorblind'], COLORBLIND_MODES, defaults.colorblind),
    reducedMotion: bool(r['reducedMotion'], defaults.reducedMotion),
    subtitles: bool(r['subtitles'], defaults.subtitles),
    captionSize: oneOf(r['captionSize'], CAPTION_SIZES, defaults.captionSize),
    volumes: {
      master: num(vol['master'], 0, 1, L.volume.step, defaults.volumes.master),
      music: num(vol['music'], 0, 1, L.volume.step, defaults.volumes.music),
      sfx: num(vol['sfx'], 0, 1, L.volume.step, defaults.volumes.sfx),
    },
    quality: oneOf(r['quality'], QUALITY_PRESETS, defaults.quality),
    mouseSensitivity: num(r['mouseSensitivity'], L.mouseSensitivity.min, L.mouseSensitivity.max, L.mouseSensitivity.step, defaults.mouseSensitivity),
    invertY: bool(r['invertY'], defaults.invertY),
    fovDeg: num(r['fovDeg'], L.fovDeg.min, L.fovDeg.max, L.fovDeg.step, defaults.fovDeg),
    showFps: bool(r['showFps'], defaults.showFps),
    bindings: sanitizeBindings(r['bindings'], 'kbm', defaults.bindings),
    padBindings: sanitizeBindings(r['padBindings'], 'pad', defaults.padBindings),
  };
}

function deepFreeze<T>(o: T): T {
  if (typeof o === 'object' && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function equalValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type SettingsKey = keyof SettingsData;
export type SettingsListener = (data: Readonly<SettingsData>, changed: ReadonlySet<SettingsKey>) => void;

export interface SettingsOptions {
  /** Storage backend; defaults to localStorage when reachable. Pass null for memory-only settings. */
  storage?: StorageLike | null;
  key?: string;
  env?: SettingsEnvironment;
  /** Load from storage in the constructor (default true). */
  autoLoad?: boolean;
  /** Save after every change (default true). */
  autoSave?: boolean;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // Accessing localStorage itself throws when storage is blocked.
  }
}

export class Settings {
  private current: Readonly<SettingsData>;
  private readonly listeners = new Set<SettingsListener>();
  private readonly storage: StorageLike | null;
  private readonly key: string;
  private readonly autoSave: boolean;
  readonly defaults: Readonly<SettingsData>;
  private appliedRoot: HTMLElement | null = null;
  /** Why the last load fell back to defaults ('corrupt' | 'unavailable'), or null when it read cleanly. */
  lastLoadIssue: 'corrupt' | 'unavailable' | null = null;

  constructor(options: SettingsOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.key = options.key ?? SETTINGS_STORAGE_KEY;
    this.autoSave = options.autoSave ?? true;
    this.defaults = deepFreeze(defaultSettings(options.env ?? detectEnvironment()));
    this.current = deepFreeze(structuredClone(this.defaults) as SettingsData);
    if (options.autoLoad ?? true) this.load();
  }

  get data(): Readonly<SettingsData> {
    return this.current;
  }

  /** Applies a patch (sanitised and clamped), notifies listeners of the keys that actually changed, then saves. */
  set(patch: SettingsPatch): void {
    const merged = { ...this.current, ...patch, volumes: { ...this.current.volumes, ...patch.volumes } };
    // Invalid values in a patch keep the current value.
    this.replace(sanitize(merged, this.current));
  }

  /** Restores defaults for the given keys, or everything when no keys are given. */
  reset(keys?: readonly SettingsKey[]): void {
    if (!keys) {
      this.replace(structuredClone(this.defaults));
      return;
    }
    const patch: Raw = {};
    for (const k of keys) patch[k] = structuredClone(this.defaults[k]);
    this.replace(sanitize({ ...this.current, ...patch }, this.defaults));
  }

  /** Subscribes to changes; returns the unsubscribe function. */
  onChange(cb: SettingsListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  load(): void {
    let next: SettingsData = structuredClone(this.defaults);
    this.lastLoadIssue = null;
    let text: string | null = null;
    try {
      text = this.storage?.getItem(this.key) ?? null;
    } catch {
      this.lastLoadIssue = 'unavailable';
    }
    if (text !== null) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
        next = sanitize(migrate(parsed as Raw), this.defaults);
      } catch {
        this.lastLoadIssue = 'corrupt';
      }
    }
    this.replace(next, false);
  }

  save(): void {
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.current));
    } catch {
      // Quota exceeded or storage blocked: settings still work for this session.
    }
  }

  /**
   * Reflects settings on the document: the :root font-size (text scale, relative to the browser default so a user's
   * own font preference is respected), data-colorblind and data-reduced-motion attributes, and a --ks-text-scale
   * custom property. After the first call, later changes are applied automatically.
   */
  applyToDocument(root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
    if (!root) return;
    this.appliedRoot = root;
    const d = this.current;
    root.style.fontSize = `${Number((d.textScale * 100).toFixed(2))}%`;
    root.style.setProperty('--ks-text-scale', String(d.textScale));
    root.dataset['colorblind'] = d.colorblind;
    root.dataset['reducedMotion'] = String(d.reducedMotion);
  }

  private replace(next: SettingsData, save = true): void {
    const prev = this.current;
    const changed = new Set<SettingsKey>();
    for (const k of Object.keys(next) as SettingsKey[]) if (!equalValue(prev[k], next[k])) changed.add(k);
    if (changed.size === 0) return;
    this.current = deepFreeze(next);
    if (this.appliedRoot) this.applyToDocument(this.appliedRoot);
    if (save && this.autoSave) this.save();
    for (const cb of [...this.listeners]) {
      try {
        cb(this.current, changed);
      } catch (e) {
        console.error('Settings listener failed', e);
      }
    }
  }
}

/** Replaces one slot in a binding map (returns a new map). */
export function withBinding(map: Readonly<BindingMap>, id: string, slot: 0 | 1, b: Binding | null): BindingMap {
  const out: BindingMap = {};
  for (const [k, v] of Object.entries(map)) out[k] = [v[0], v[1]];
  const cur = out[id] ?? [null, null];
  if (sameBinding(cur[slot], b)) return out;
  cur[slot] = b;
  out[id] = cur;
  return out;
}
