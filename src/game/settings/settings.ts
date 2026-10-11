/**
 * Player settings: accessibility, audio, graphics and control bindings. Persisted to localStorage as versioned JSON;
 * every storage access is guarded (private mode, blocked storage and quota errors must never break the game), stored
 * data is migrated step by step to the current version and then sanitised field by field, so corrupt or hand-edited
 * data degrades to defaults one field at a time instead of failing.
 *
 * Reduced motion and the colour mode default from the system preferences (prefers-reduced-motion, prefers-contrast)
 * and keep following them, live, until the player picks a value that differs from the system's. Only such explicit
 * choices are stored; choosing the system's value again returns the setting to following the system.
 *
 * Saving is debounced (a slider drag writes once, after it settles) and flushed when the page is hidden or unloaded.
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
  /** Defaults to 'high-contrast' when the system asks for more contrast (prefers-contrast: more), else 'none'. */
  colorblind: ColorblindMode;
  /** Defaults from prefers-reduced-motion, and follows it until the player overrides it. */
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

/** A patch may set volumes partially. `version` is accepted for convenience and ignored. */
export type SettingsPatch = Partial<Omit<SettingsData, 'volumes'>> & { volumes?: Partial<Volumes> };

export const SETTINGS_VERSION = 2;
export const SETTINGS_STORAGE_KEY = 'knownsky.settings';
/** Default delay before a change is written to storage. */
export const SETTINGS_SAVE_DELAY_MS = 250;

/** Settings whose default comes from a system preference. Stored only when the player's choice differs from it. */
export const SYSTEM_KEYS = ['reducedMotion', 'colorblind'] as const;
export type SystemKey = (typeof SYSTEM_KEYS)[number];

export const LIMITS = {
  textScale: { min: 0.8, max: 2, step: 0.05 },
  mouseSensitivity: { min: 0.1, max: 5, step: 0.01 },
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
  // Version 1 stored every field, so reducedMotion and colorblind were pinned to whatever the system said at first
  // launch. Version 2 stores them only as explicit choices. The no-preference values are what version 1 wrote for
  // nearly every player without them choosing anything, so they are dropped and follow the system again.
  1: (raw) => {
    const out: Raw = { ...raw, version: 2 };
    if (out['reducedMotion'] === false) delete out['reducedMotion'];
    if (out['colorblind'] === 'none') delete out['colorblind'];
    return out;
  },
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
  /** System preferences. Omitted: read from matchMedia and followed live as they change. */
  env?: SettingsEnvironment;
  /** Load from storage in the constructor (default true). */
  autoLoad?: boolean;
  /** Save after changes (default true). */
  autoSave?: boolean;
  /** Delay before a change is saved, so a burst (a slider drag) writes once; 0 saves at once. Default 250 ms. */
  saveDelayMs?: number;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // Accessing localStorage itself throws when storage is blocked.
  }
}

const SYSTEM_QUERIES = ['(prefers-reduced-motion: reduce)', '(prefers-contrast: more)'];

export class Settings {
  private current: Readonly<SettingsData>;
  private readonly listeners = new Set<SettingsListener>();
  private readonly storage: StorageLike | null;
  private readonly key: string;
  private readonly autoSave: boolean;
  private readonly saveDelayMs: number;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private env: SettingsEnvironment;
  private _defaults: Readonly<SettingsData>;
  /** System-derived keys the player set to something other than the system's value. */
  private readonly overrides = new Set<SystemKey>();
  private appliedRoot: HTMLElement | null = null;
  private readonly cleanups: (() => void)[] = [];
  /** Why the last load fell back to defaults ('corrupt' | 'unavailable'), or null when it read cleanly. */
  lastLoadIssue: 'corrupt' | 'unavailable' | null = null;

  constructor(options: SettingsOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.key = options.key ?? SETTINGS_STORAGE_KEY;
    this.autoSave = options.autoSave ?? true;
    this.saveDelayMs = Math.max(0, options.saveDelayMs ?? SETTINGS_SAVE_DELAY_MS);
    this.env = options.env ?? detectEnvironment();
    this._defaults = deepFreeze(defaultSettings(this.env));
    this.current = deepFreeze(structuredClone(this._defaults) as SettingsData);
    if (!options.env) this.watchSystem();
    if (this.storage && typeof window !== 'undefined' && typeof document !== 'undefined') {
      // A pending debounced save must not be lost when the tab closes or goes to the background.
      const flush = (): void => this.flush();
      const hidden = (): void => {
        if (document.visibilityState === 'hidden') this.flush();
      };
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', hidden);
      this.cleanups.push(() => {
        window.removeEventListener('pagehide', flush);
        document.removeEventListener('visibilitychange', hidden);
      });
    }
    if (options.autoLoad ?? true) this.load();
  }

  get data(): Readonly<SettingsData> {
    return this.current;
  }

  /** Defaults for the current system preferences. */
  get defaults(): Readonly<SettingsData> {
    return this._defaults;
  }

  /** The system preferences currently in effect. */
  get environment(): Readonly<SettingsEnvironment> {
    return this.env;
  }

  /** True when the player chose a value for a system-derived setting that differs from the system's. */
  isOverridden(key: SystemKey): boolean {
    return this.overrides.has(key);
  }

  /**
   * Applies a patch (sanitised and clamped), notifies listeners of the keys that actually changed, then saves. Setting
   * reducedMotion or colorblind to a value other than the system's makes it an explicit choice; setting the system's
   * value makes it follow the system again.
   */
  set(patch: SettingsPatch): void {
    const merged = { ...this.current, ...patch, volumes: { ...this.current.volumes, ...patch.volumes } };
    // Invalid values in a patch keep the current value.
    const next = sanitize(merged, this.current);
    let overridesChanged = false;
    for (const k of SYSTEM_KEYS) {
      if (patch[k] === undefined) continue;
      const explicit = !equalValue(next[k], this._defaults[k]);
      if (explicit !== this.overrides.has(k)) overridesChanged = true;
      if (explicit) this.overrides.add(k);
      else this.overrides.delete(k);
    }
    if (!this.replace(next) && overridesChanged) this.scheduleSave();
  }

  /** Restores defaults for the given keys, or everything when no keys are given. System-derived keys follow the system again. */
  reset(keys?: readonly SettingsKey[]): void {
    const touched = SYSTEM_KEYS.filter((k) => (!keys || keys.includes(k)) && this.overrides.has(k));
    for (const k of touched) this.overrides.delete(k);
    let changed: boolean;
    if (!keys) changed = this.replace(structuredClone(this._defaults));
    else {
      const patch: Raw = {};
      for (const k of keys) patch[k] = structuredClone(this._defaults[k]);
      changed = this.replace(sanitize({ ...this.current, ...patch }, this._defaults));
    }
    if (!changed && touched.length > 0) this.scheduleSave();
  }

  /**
   * Updates the system preferences (called when the media queries change; tests may call it directly). Settings that
   * follow the system take the new values; explicit choices stay.
   */
  setEnvironment(env: SettingsEnvironment): void {
    if (env.prefersReducedMotion === this.env.prefersReducedMotion && env.prefersMoreContrast === this.env.prefersMoreContrast) return;
    this.env = { ...env };
    this._defaults = deepFreeze(defaultSettings(this.env));
    const next: SettingsData = { ...this.current, ...this.systemValues() };
    // Nothing to save: values that follow the system are not stored.
    this.replace(next, false);
  }

  /** The current defaults of the system-derived keys that are not overridden. */
  private systemValues(): Partial<SettingsData> {
    const out: Partial<SettingsData> = {};
    if (!this.overrides.has('reducedMotion')) out.reducedMotion = this._defaults.reducedMotion;
    if (!this.overrides.has('colorblind')) out.colorblind = this._defaults.colorblind;
    return out;
  }

  /** Subscribes to changes; returns the unsubscribe function. */
  onChange(cb: SettingsListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  load(): void {
    let next: SettingsData = structuredClone(this._defaults);
    this.lastLoadIssue = null;
    this.overrides.clear();
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
        const raw = migrate(parsed as Raw);
        next = sanitize(raw, this._defaults);
        // A stored (valid) system-derived value is an explicit choice.
        for (const k of SYSTEM_KEYS) if (raw[k] !== undefined && equalValue(raw[k], next[k])) this.overrides.add(k);
      } catch {
        this.lastLoadIssue = 'corrupt';
      }
    }
    this.replace(next, false);
  }

  /** Writes to storage now (cancels a pending debounced save). Values that follow the system are left out. */
  save(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const following = new Set<string>(SYSTEM_KEYS.filter((k) => !this.overrides.has(k)));
    const out = Object.fromEntries(Object.entries(this.current).filter(([k]) => !following.has(k)));
    try {
      this.storage?.setItem(this.key, JSON.stringify(out));
    } catch {
      // Quota exceeded or storage blocked: settings still work for this session.
    }
  }

  /** Saves now if a debounced save is pending. */
  flush(): void {
    if (this.saveTimer !== null) this.save();
  }

  /** Flushes pending changes and stops following the system preferences. */
  dispose(): void {
    this.flush();
    for (const c of this.cleanups.splice(0)) c();
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

  private watchSystem(): void {
    if (typeof matchMedia !== 'function') return;
    for (const q of SYSTEM_QUERIES) {
      try {
        const mql = matchMedia(q);
        const onChange = (): void => this.setEnvironment(detectEnvironment());
        mql.addEventListener('change', onChange);
        this.cleanups.push(() => mql.removeEventListener('change', onChange));
      } catch {
        // Old engines without MediaQueryList events: the preference is still read at startup.
      }
    }
  }

  private scheduleSave(): void {
    if (!this.autoSave) return;
    if (this.saveDelayMs === 0) {
      this.save();
      return;
    }
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, this.saveDelayMs);
  }

  /** Swaps in new data; returns whether anything changed. */
  private replace(next: SettingsData, save = true): boolean {
    const prev = this.current;
    const changed = new Set<SettingsKey>();
    for (const k of Object.keys(next) as SettingsKey[]) if (!equalValue(prev[k], next[k])) changed.add(k);
    if (changed.size === 0) return false;
    this.current = deepFreeze(next);
    if (this.appliedRoot) this.applyToDocument(this.appliedRoot);
    if (save) this.scheduleSave();
    this.notify(changed);
    return true;
  }

  private notify(changed: ReadonlySet<SettingsKey>): void {
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
