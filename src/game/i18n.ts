/**
 * Translation-ready text. Every user-visible string goes through t(key, params); English is the only locale in the
 * PoC. Messages use {name} placeholders; numbers are formatted with Intl so locales can change separators.
 */
import en from './locales/en.json';

type Dict = Record<string, string>;
let dict: Dict = en;
let locale = 'en';

export function setLocale(code: string, messages: Dict): void {
  locale = code;
  dict = messages;
}

export function t(key: string, params: Record<string, string | number> = {}): string {
  const msg = dict[key] ?? (en as Dict)[key] ?? key;
  return msg.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    return v === undefined ? `{${k}}` : typeof v === 'number' ? formatNumber(v) : v;
  });
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

export function allKeys(): string[] {
  return Object.keys(en);
}
