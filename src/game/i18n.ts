/**
 * Translation-ready text. Every user-visible string goes through t(key, params); English is the only locale in the
 * PoC. Messages use {name} placeholders; numbers are formatted with Intl so locales can change separators.
 *
 * Each feature module owns its strings in src/game/locales/en.<module>.json (plus the shared en.json); all files for
 * a locale are merged at build time. Keys must be unique across files (checked by tests/unit/i18n.test.ts).
 */
type Dict = Record<string, string>;

const modules = import.meta.glob<Dict>('./locales/en*.json', { eager: true, import: 'default' });
const en: Dict = Object.assign({}, ...Object.values(modules)) as Dict;
let dict: Dict = en;
let locale = 'en';

export function setLocale(code: string, messages: Dict): void {
  locale = code;
  dict = messages;
}

export function t(key: string, params: Record<string, string | number> = {}): string {
  const msg = dict[key] ?? en[key] ?? key;
  return msg.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    return v === undefined ? `{${k}}` : typeof v === 'number' ? formatNumber(v) : v;
  });
}

export function hasKey(key: string): boolean {
  return key in en;
}

const nfCache = new Map<string, Intl.NumberFormat>();
export function formatNumber(v: number, maxFrac = 0, minFrac = 0): string {
  const k = `${locale}|${maxFrac}|${minFrac}`;
  let nf = nfCache.get(k);
  if (!nf) {
    nf = new Intl.NumberFormat(locale, { maximumFractionDigits: maxFrac, minimumFractionDigits: minFrac });
    nfCache.set(k, nf);
  }
  return nf.format(v);
}

/** All English keys with the file that defines them (for duplicate checks). */
export function keySources(): { key: string; file: string }[] {
  return Object.entries(modules).flatMap(([file, d]) => Object.keys(d).map((key) => ({ key, file })));
}
