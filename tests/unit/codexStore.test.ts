import { describe, expect, it, vi } from 'vitest';
import codexFixture from '../fixtures/codex_sample.json';
import citationsFixture from '../fixtures/citations_sample.json';
import {
  CodexStore,
  citationHref,
  formatCitation,
  staticSource,
  withFallback,
  type CodexSource,
  type StorageLike,
} from '../../src/game/codex/codexStore';
import { formatFactValue, formatQuantity, lockedHint, normalizeSearch, parseInline, relativeTime } from '../../src/game/codex/format';
import { parseCitations, parseCodex, type CodexCitation, type CodexEntry } from '../../src/game/codex/types';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

class BrokenStorage implements StorageLike {
  getItem(): string | null {
    throw new Error('SecurityError');
  }
  setItem(): void {
    throw new Error('QuotaExceededError');
  }
  removeItem(): void {
    throw new Error('SecurityError');
  }
}

const fixtures = (): CodexSource => staticSource(codexFixture, citationsFixture);

async function loaded(opts: { storage?: StorageLike | null; now?: () => number } = {}): Promise<CodexStore> {
  const store = new CodexStore({ source: fixtures(), storage: opts.storage ?? null, ...(opts.now ? { now: opts.now } : {}) });
  await store.load();
  return store;
}

const cite = (over: Partial<CodexCitation> = {}): CodexCitation => ({
  authors: 'Agol, E. et al.',
  year: 2021,
  title: 'Refining the Transit-timing and Photometric Analysis of TRAPPIST-1',
  venue: 'The Planetary Science Journal 2(1), 1',
  doi: '10.3847/PSJ/abd022',
  url: 'https://iopscience.iop.org/article/10.3847/PSJ/abd022',
  accessed: '2026-10-10',
  verified: true,
  ...over,
});

describe('codex fixtures', () => {
  it('parse cleanly: every fact has a tier, every citation and related link resolves', () => {
    const codex = parseCodex(codexFixture);
    const cites = parseCitations(citationsFixture);
    expect(codex.problems).toEqual([]);
    expect(cites.problems).toEqual([]);
    const ids = new Set(codex.value.map((e) => e.id));
    for (const id of ['earth', 'moon', 'trappist-1e', 'parallax']) expect(ids.has(id), id).toBe(true);
    for (const e of codex.value) {
      for (const f of [...e.facts, ...e.howWeKnow]) {
        expect(['measured', 'inferred', 'generated']).toContain(f.provenance);
        expect(cites.value.has(f.citation), `${e.id}: ${f.citation}`).toBe(true);
      }
      for (const r of e.related) expect(ids.has(r), `${e.id} -> ${r}`).toBe(true);
    }
  });

  it('cover every category, unlock state and provenance tier', () => {
    const entries = parseCodex(codexFixture).value;
    expect(new Set(entries.map((e) => e.kind))).toEqual(new Set(['body', 'star', 'exoplanet', 'concept']));
    expect(new Set(entries.map((e) => e.unlock))).toEqual(new Set(['start', 'visit']));
    expect(new Set(entries.flatMap((e) => e.facts.map((f) => f.provenance)))).toEqual(new Set(['measured', 'inferred', 'generated']));
  });
});

describe('CodexStore content', () => {
  it('loads entries, looks them up by id, NAIF body id and kind, and resolves citations', async () => {
    const store = await loaded();
    expect(store.loaded).toBe(true);
    expect(store.error).toBeNull();
    expect(store.problems).toEqual([]);
    expect(store.entries()).toHaveLength(8);
    expect(store.entry('earth')?.title).toBe('Earth');
    expect(store.entry('nope')).toBeUndefined();
    expect(store.byBodyId('399')?.id).toBe('earth');
    expect(store.byBodyId('301')?.id).toBe('moon');
    expect(store.byBodyId('10')?.id).toBe('sun');
    expect(store.byBodyId('499')).toBeUndefined();
    expect(store.byKind('star').map((e) => e.id)).toEqual(['sun', 'proxima-centauri', 'trappist-1']);
    expect(store.citation('agol2021')?.doi).toBe('10.3847/PSJ/abd022');
    expect(store.citation('missing')).toBeUndefined();
  });

  it('load() runs once and never rejects', async () => {
    const codex = vi.fn(() => Promise.resolve<unknown>(codexFixture));
    const store = new CodexStore({ source: { codex, citations: () => Promise.resolve(citationsFixture) }, storage: null });
    await Promise.all([store.load(), store.load()]);
    expect(codex).toHaveBeenCalledTimes(1);
  });

  it('falls back to empty content when the files are missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new CodexStore({ source: { codex: () => Promise.reject(new Error('404')), citations: () => Promise.reject(new Error('404')) }, storage: null });
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.entries()).toEqual([]);
    expect(store.error).toContain('404');
    expect(store.discover('earth')).toBe(false);
    warn.mockRestore();
  });

  it('keeps entries when only citations are missing, and reports the unresolved keys', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new CodexStore({ source: { codex: () => Promise.resolve(codexFixture), citations: () => Promise.reject(new Error('404')) }, storage: null });
    await store.load();
    expect(store.entries()).toHaveLength(8);
    expect(store.problems.some((p) => p.includes('"agol2021" not found'))).toBe(true);
    warn.mockRestore();
  });

  it('withFallback uses the fallback per file', async () => {
    const source = withFallback({ codex: () => Promise.reject(new Error('404')), citations: () => Promise.resolve({}) }, fixtures());
    const store = new CodexStore({ source, storage: null });
    await store.load();
    expect(store.entries()).toHaveLength(8);
    expect(store.citation('agol2021')).toBeUndefined(); // the primary's (empty) citations were used
  });
});

describe('CodexStore discovery', () => {
  it('treats start entries as known and others as locked', async () => {
    const store = await loaded();
    expect(store.discovered('earth')).toBe(true);
    expect(store.discovered('parallax')).toBe(true);
    expect(store.discovered('moon')).toBe(false);
    expect(store.discovered('trappist-1e')).toBe(false);
    expect(store.progress()).toEqual({ discovered: 4, total: 8 });
    expect(store.progress('body')).toEqual({ discovered: 1, total: 2 });
  });

  it('discover() returns true only when new, records the time and notifies listeners', async () => {
    let now = 1_000;
    const store = await loaded({ now: () => now });
    const seen: [string, number][] = [];
    const off = store.onDiscover((e, at) => seen.push([e.id, at]));
    expect(store.discover('moon')).toBe(true);
    now = 2_000;
    expect(store.discover('moon')).toBe(false);
    expect(store.discover('earth')).toBe(false); // known from the start
    expect(store.discover('no-such-entry')).toBe(false);
    expect(store.discover('trappist-1e')).toBe(true);
    off();
    expect(store.discover('trappist-1')).toBe(true);
    expect(seen).toEqual([
      ['moon', 1_000],
      ['trappist-1e', 2_000],
    ]);
    expect(store.log()).toEqual([
      { id: 'moon', at: 1_000 },
      { id: 'trappist-1e', at: 2_000 },
      { id: 'trappist-1', at: 2_000 },
    ]);
    expect(store.discoveredAt('moon')).toBe(1_000);
    expect(store.discoveredAt('earth')).toBeNull();
  });

  it('marks discoveries as new until seen', async () => {
    const store = await loaded();
    expect(store.isNew('earth')).toBe(false);
    store.discover('moon');
    expect(store.isNew('moon')).toBe(true);
    expect(store.newCount()).toBe(1);
    expect(store.newCount('body')).toBe(1);
    expect(store.newCount('star')).toBe(0);
    const changes = vi.fn();
    store.onChange(changes);
    store.markSeen('moon');
    expect(store.isNew('moon')).toBe(false);
    expect(changes).toHaveBeenCalledTimes(1);
    store.markSeen('moon');
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('persists progress to storage and restores it', async () => {
    const storage = new MemoryStorage();
    const a = await loaded({ storage, now: () => 42 });
    a.discover('moon');
    a.discover('proxima-centauri');
    a.markSeen('moon');
    const b = await loaded({ storage });
    expect(b.discovered('moon')).toBe(true);
    expect(b.discovered('proxima-centauri')).toBe(true);
    expect(b.log()).toEqual([
      { id: 'moon', at: 42 },
      { id: 'proxima-centauri', at: 42 },
    ]);
    expect(b.isNew('moon')).toBe(false);
    expect(b.isNew('proxima-centauri')).toBe(true);
    b.reset();
    expect(b.discovered('moon')).toBe(false);
    expect(storage.data.size).toBe(0);
  });

  it('survives corrupt or blocked storage', async () => {
    const storage = new MemoryStorage();
    storage.setItem('knownsky.codex.v1', '{not json');
    const a = await loaded({ storage });
    expect(a.log()).toEqual([]);
    expect(a.discover('moon')).toBe(true);
    storage.setItem('knownsky.codex.v1', JSON.stringify({ v: 1, log: [{ id: 'moon', at: 'x' }, null, { id: 'sun', at: 5 }], seen: [3] }));
    expect((await loaded({ storage })).log()).toEqual([]); // sun is a start entry, moon's time is invalid
    const b = await loaded({ storage: new BrokenStorage() });
    expect(b.discover('moon')).toBe(true);
    expect(b.discovered('moon')).toBe(true);
    expect(() => b.reset()).not.toThrow();
  });

  it('records discoveries made before load() and announces them afterwards', async () => {
    const store = new CodexStore({ source: fixtures(), storage: null, now: () => 7 });
    const seen: string[] = [];
    store.onDiscover((e) => seen.push(e.id));
    expect(store.discover('moon')).toBe(true);
    expect(store.discover('not-an-entry')).toBe(true); // unknown until the content arrives
    expect(seen).toEqual([]);
    await store.load();
    expect(seen).toEqual(['moon']);
    expect(store.log()).toEqual([{ id: 'moon', at: 7 }]);
  });

  it('searches discovered entries only, ignoring case and accents', async () => {
    const store = await loaded();
    expect(store.search('radius').map((e) => e.id)).toEqual(['sun', 'earth']); // not the locked Moon
    expect(store.search('TRAPPIST')).toEqual([]);
    store.discover('trappist-1e');
    expect(store.search('trappist').map((e) => e.id)).toEqual(['trappist-1e']);
    expect(store.search('proxima centauri').map((e) => e.id)).toEqual(['parallax']); // the locked star itself does not match
    expect(store.search('parállax')[0]?.id).toBe('parallax');
    expect(store.search('   ')).toEqual([]);
  });
});

describe('codex parsing', () => {
  const base = { id: 'x', title: 'X', kind: 'body', unlock: 'visit', summary: '', body: [], howWeKnow: [], related: [] };

  it('drops facts without a valid tier instead of guessing one', () => {
    const r = parseCodex({
      version: 1,
      entries: [
        {
          ...base,
          facts: [
            { label: 'A', value: 1, provenance: 'measured', method: 'm', citation: 'c' },
            { label: 'B', value: 2, provenance: 'Measured', method: 'm', citation: 'c' },
            { label: 'C', value: 3, method: 'm', citation: 'c' },
            { label: 'D', value: Number.NaN, provenance: 'inferred', method: 'm', citation: 'c' },
          ],
        },
      ],
    });
    expect(r.value[0]!.facts.map((f) => f.label)).toEqual(['A']);
    expect(r.problems.filter((p) => p.includes('no valid provenance'))).toHaveLength(2);
  });

  it('drops malformed entries, de-duplicates ids and repairs what it can', () => {
    const r = parseCodex({
      version: 2,
      entries: [
        { ...base, facts: [], related: ['x', 'y', 'ghost'] },
        { ...base, id: 'y', unlock: 'teleport', facts: [] },
        { ...base, facts: [] },
        { ...base, id: 'z', kind: 'galaxy', facts: [] },
        { ...base, id: '', facts: [] },
        'nonsense',
      ],
    });
    expect(r.value.map((e) => e.id)).toEqual(['x', 'y']);
    expect(r.value[0]!.related).toEqual(['y']);
    expect(r.value[1]!.unlock).toBe('visit');
    expect(r.problems.length).toBeGreaterThanOrEqual(6);
    expect(parseCodex(null).value).toEqual([]);
  });

  it('reads citations conservatively', () => {
    const r = parseCitations({ ok: { authors: 'A', title: 'T', year: 2020, venue: 'V', doi: null, url: 'https://x.org', accessed: '2026-01-01', verified: true }, bad: { title: 'T' }, maybe: { authors: 'A', title: 'T' } });
    expect([...r.value.keys()]).toEqual(['ok', 'maybe']);
    expect(r.value.get('maybe')).toMatchObject({ year: null, doi: null, url: '', verified: false });
  });
});

describe('citation formatting', () => {
  it('formats authors, year, title, venue and DOI', () => {
    expect(formatCitation(cite())).toBe(
      'Agol, E. et al. (2021). Refining the Transit-timing and Photometric Analysis of TRAPPIST-1. The Planetary Science Journal 2(1), 1. doi:10.3847/PSJ/abd022',
    );
  });
  it('uses n.d. without a year, the URL without a DOI, and avoids doubled punctuation', () => {
    expect(formatCitation(cite({ year: null, doi: null, title: 'Is it a planet?', venue: 'Web page.' }))).toBe(
      'Agol, E. et al. (n.d.). Is it a planet? Web page. https://iopscience.iop.org/article/10.3847/PSJ/abd022',
    );
    expect(formatCitation(cite({ doi: null, url: '', venue: '' }))).toBe('Agol, E. et al. (2021). Refining the Transit-timing and Photometric Analysis of TRAPPIST-1.');
  });
  it('links only to the DOI resolver or http(s) URLs', () => {
    expect(citationHref(cite())).toBe('https://doi.org/10.3847/PSJ/abd022');
    expect(citationHref(cite({ doi: null }))).toBe('https://iopscience.iop.org/article/10.3847/PSJ/abd022');
    expect(citationHref(cite({ doi: null, url: 'javascript:alert(1)' }))).toBeNull();
    expect(citationHref(cite({ doi: null, url: '' }))).toBeNull();
  });
  it('formats every fixture citation as one line ending in a link or a full stop', () => {
    for (const c of parseCitations(citationsFixture).value.values()) expect(formatCitation(c)).toMatch(/(\.|doi:\S+|https?:\/\/\S+)$/);
  });
});

describe('codex value formatting', () => {
  it('keeps the precision given and switches to powers of ten only at extremes', () => {
    expect(formatQuantity(6378.1366)).toBe('6,378.1366');
    expect(formatQuantity(0.1)).toBe('0.1');
    expect(formatQuantity(0.000553)).toBe('0.000553');
    expect(formatQuantity(3.828e26)).toBe('3.828 × 10²⁶');
    expect(formatQuantity(-1.5e-7)).toBe('-1.5 × 10⁻⁷');
    expect(formatQuantity(0)).toBe('0');
  });
  it('joins value, uncertainty and unit', () => {
    expect(formatFactValue({ value: 6378.1366, uncertainty: 0.0001, unit: 'km' }).text).toBe('6,378.1366 ± 0.0001 km');
    expect(formatFactValue({ value: 3.828e26, unit: 'W' }).text).toBe('3.828 × 10²⁶ W');
    expect(formatFactValue({ value: 'Ruled out' }).text).toBe('Ruled out');
    expect(formatFactValue({ value: 65, unit: '%' }).text).toBe('65%');
    const asym = formatFactValue({ value: 0.92, uncertainty: '+0.013/-0.012', unit: 'R⊕' });
    expect(asym.text).toBe('0.92 +0.013/−0.012 R⊕');
    expect(asym.asym).toEqual({ plus: '+0.013', minus: '−0.012' });
    expect(formatFactValue({ value: 5, uncertainty: '10%' }).uncertainty).toBe('± 10%');
  });
  it('describes times relative to now', () => {
    const now = Date.UTC(2026, 9, 11, 12);
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 3 * 60_000, now)).toBe('3 minutes ago');
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe('2 hours ago');
    expect(relativeTime(now - 24 * 3_600_000, now)).toBe('yesterday');
    expect(relativeTime(now - 60 * 86_400_000, now)).toMatch(/2026/);
  });
  it('parses **bold** spans and leaves stray markers alone', () => {
    expect(parseInline('a **b** c')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c', bold: false },
    ]);
    expect(parseInline('5 ** 2')).toEqual([{ text: '5 ** 2', bold: false }]);
    expect(normalizeSearch(' Ångström **X** ')).toBe('angstrom x');
  });
  it('gives locked entries a hint without revealing them', () => {
    const entries = parseCodex(codexFixture).value;
    const get = (id: string): CodexEntry => entries.find((e) => e.id === id)!;
    expect(lockedHint(get('moon'), entries)).toBe('Visit this world in the Solar System to unlock it.');
    expect(lockedHint(get('trappist-1e'), entries)).toBe('Travel to the TRAPPIST-1 system to unlock it.');
    expect(lockedHint(get('proxima-centauri'), entries)).toBe('Jump to Proxima Centauri to unlock it.');
    expect(lockedHint({ ...get('moon'), unlock: 'scan', systemId: 'nowhere' }, entries)).toBe('Scan this object up close to unlock it.');
    expect(lockedHint({ ...get('parallax'), unlock: 'visit' }, entries)).toBe('Keep exploring: this entry unlocks along the way.');
  });
});
