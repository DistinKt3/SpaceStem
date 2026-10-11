/**
 * Pure text helpers for the Codex UI: fact values with uncertainty, relative times, inline **bold** parsing, search
 * normalisation and locked-entry hints. No DOM access, so they run in unit tests.
 */
import { t, hasKey } from '../i18n';
import type { CodexEntry, CodexFact, CodexKind } from './types';

/** Language tag for Intl formatting: the document's lang attribute (set per locale), else English. */
export function uiLang(): string {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : '';
  return lang || 'en';
}

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(lang: string): Intl.NumberFormat {
  let f = nfCache.get(lang);
  if (!f) {
    // Up to 20 fraction digits: values are printed with exactly the precision the data file gives (ICU prints the
    // shortest round-trip form, so 0.1 stays "0.1").
    f = new Intl.NumberFormat(lang, { maximumFractionDigits: 20 });
    nfCache.set(lang, f);
  }
  return f;
}

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '-': '⁻',
  '+': '',
};

/** True when formatQuantity would use "m × 10ⁿ" for this value. */
export function usesScientific(v: number): boolean {
  const a = Math.abs(v);
  return v !== 0 && (a >= 1e7 || a < 1e-4);
}

/**
 * Formats a measured number without inventing or dropping precision: grouping for ordinary magnitudes, and
 * "m × 10ⁿ" for very large or very small ones (|v| ≥ 1e7 or < 1e-4). `plain` keeps small numbers positional (used for
 * an uncertainty next to a positional value: "6,378.1366 ± 0.0001", not "± 1 × 10⁻⁴").
 */
export function formatQuantity(v: number, lang = uiLang(), plain = false): string {
  const a = Math.abs(v);
  if (usesScientific(v) && !(plain && a < 1 && a >= 1e-12)) {
    const [m = '0', e = '0'] = v.toExponential().split('e');
    const exp = e.replace(/[-+0-9]/g, (ch) => SUPERSCRIPT[ch] ?? ch);
    return t('codex.value.sci', { mantissa: nf(lang).format(Number(m)), exp });
  }
  return nf(lang).format(v);
}

export interface FactValueParts {
  /** The value itself. */
  readonly value: string;
  /** "± 0.0001" or an asymmetric "+0.013/−0.012"; null when no uncertainty is recorded. */
  readonly uncertainty: string | null;
  /** The two halves of an asymmetric uncertainty, for stacked display. */
  readonly asym: { readonly plus: string; readonly minus: string } | null;
  readonly unit: string | null;
  /** Everything joined, for plain-text use and accessible names. */
  readonly text: string;
}

/** Units written without a space after the number. */
const TIGHT_UNITS = new Set(['%', '°', '′', '″', '‰', '×']);

/** True for units written straight after the number ("65%", "2.5×"). */
export function isTightUnit(unit: string): boolean {
  return TIGHT_UNITS.has(unit);
}

export function formatFactValue(f: Pick<CodexFact, 'value' | 'unit' | 'uncertainty'>, lang = uiLang()): FactValueParts {
  const value = typeof f.value === 'number' ? formatQuantity(f.value, lang) : f.value;
  const plain = typeof f.value !== 'number' || !usesScientific(f.value);
  let uncertainty: string | null = null;
  let asym: FactValueParts['asym'] = null;
  if (typeof f.uncertainty === 'number')
    uncertainty = t('codex.value.pm', { unc: formatQuantity(f.uncertainty, lang, plain) });
  else if (typeof f.uncertainty === 'string') {
    const u = f.uncertainty.trim();
    // Already signed ("±0.2", "+0.013/-0.012") strings are shown as given, with typographic minus signs.
    uncertainty = /^[±+\-−]/.test(u) ? u.replace(/-/g, '−') : t('codex.value.pm', { unc: u });
    const m = /^\+\s*([^/\s]+)\s*\/\s*[-−]\s*([^/\s]+)$/.exec(u);
    if (m) asym = { plus: `+${m[1]!}`, minus: `−${m[2]!}` };
  }
  const unit = f.unit ?? null;
  let text = uncertainty ? `${value} ${uncertainty}` : value;
  if (unit) text = TIGHT_UNITS.has(unit) ? `${text}${unit}` : `${text} ${unit}`;
  return { value, uncertainty, asym, unit, text };
}

/** Plural-aware lookup: uses `${base}.one` / `${base}.other` (Intl.PluralRules) with {n}. */
export function tCount(base: string, n: number, params: Record<string, string | number> = {}): string {
  const cat = new Intl.PluralRules(uiLang()).select(n);
  const key = hasKey(`${base}.${cat}`) ? `${base}.${cat}` : `${base}.other`;
  return t(key, { n: String(n), ...params });
}

/** "just now", "3 minutes ago", "yesterday", then a calendar date after about four weeks. */
export function relativeTime(at: number, now: number, lang = uiLang()): string {
  const s = (now - at) / 1000;
  if (s < 45) return t('codex.time.justNow');
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const min = s / 60;
  if (min < 45) return rtf.format(-Math.max(1, Math.round(min)), 'minute');
  const h = min / 60;
  if (h < 22) return rtf.format(-Math.max(1, Math.round(h)), 'hour');
  const d = h / 24;
  if (d < 26) return rtf.format(-Math.max(1, Math.round(d)), 'day');
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(new Date(at));
}

export interface InlineSegment {
  readonly text: string;
  readonly bold: boolean;
}

/** Splits text on **bold** markers. Unpaired markers stay literal. */
export function parseInline(s: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), bold: false });
    out.push({ text: m[1]!, bold: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), bold: false });
  return out;
}

/** Lower-case, accent-free form for search matching. */
export function normalizeSearch(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\*\*/g, '').trim();
}

export function kindLabel(kind: CodexKind): string {
  return t(`codex.kind.${kind}`);
}

/** Display name of a system id, e.g. "the Solar System" or "the TRAPPIST-1 system"; null when unknown. */
/** The entry's system id; a Solar System body (NAIF body id, no system given) belongs to "sol". */
export function entrySystem(e: Pick<CodexEntry, 'systemId' | 'bodyId'>): string | undefined {
  return e.systemId ?? (e.bodyId !== undefined ? 'sol' : undefined);
}

export function systemName(systemId: string | undefined, entries: readonly CodexEntry[]): string | null {
  if (!systemId) return null;
  const key = `codex.system.${systemId}`;
  if (hasKey(key)) return t(key);
  const star = entries.find((e) => e.kind === 'star' && e.systemId === systemId && e.starName)?.starName;
  return star ? t('codex.system.named', { star }) : null;
}

/** A hint for a locked entry that says how to unlock it without giving its contents away. */
export function lockedHint(e: CodexEntry, entries: readonly CodexEntry[]): string {
  // Ideas are learned along the way, however they unlock; objects say where to go.
  if (e.kind === 'concept') return t('codex.locked.hint.concept');
  const sys = systemName(entrySystem(e), entries);
  if (e.unlock === 'scan') return sys ? t('codex.locked.hint.scanIn', { system: sys }) : t('codex.locked.hint.scan');
  switch (e.kind) {
    case 'body':
      return sys ? t('codex.locked.hint.bodyIn', { system: sys }) : t('codex.locked.hint.body');
    case 'star':
      return e.starName ? t('codex.locked.hint.star', { star: e.starName }) : t('codex.locked.hint.starAnon');
    case 'exoplanet':
      return sys ? t('codex.locked.hint.exoplanetIn', { system: sys }) : t('codex.locked.hint.exoplanet');
  }
}
