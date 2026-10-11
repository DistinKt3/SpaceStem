/**
 * Codex content and the player's discovery progress.
 *
 * Content comes from public/data/codex/<locale>.json and public/data/citations.json (same-origin static files; never
 * an external API). Progress (which entries were discovered and when, and which the player has opened since) is kept
 * in localStorage. Every storage access is guarded: in a private window or with storage blocked, progress simply lives
 * in memory for the session.
 */
import { fetchJson } from '../../data/assets';
import { t } from '../i18n';
import { normalizeSearch } from './format';
import { parseCitations, parseCodex, type CodexCitation, type CodexEntry, type CodexKind } from './types';

export type { CodexCitation, CodexEntry, CodexFact, CodexClaim, CodexKind, CodexUnlock } from './types';

export interface DiscoveryRecord {
  readonly id: string;
  /** Unix time in milliseconds. */
  readonly at: number;
}

export type DiscoverListener = (entry: CodexEntry, at: number) => void;

/** The subset of Web Storage the store needs (so tests can pass a fake). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Where the raw JSON comes from. Each loader may reject; the store then falls back to empty content. */
export interface CodexSource {
  codex(): Promise<unknown>;
  citations(): Promise<unknown>;
}

/** The shipped data under public/data. */
export function publicDataSource(locale = 'en'): CodexSource {
  // A dev server answers a missing file with its HTML page, which fails to parse: report that as "missing".
  const get = (path: string): Promise<unknown> =>
    fetchJson<unknown>(path).catch((err: unknown) => {
      throw new Error(err instanceof SyntaxError ? `${path} is missing or not JSON` : String(err));
    });
  return { codex: () => get(`codex/${locale}.json`), citations: () => get('citations.json') };
}

/** Data already in memory (tests, demos). */
export function staticSource(codex: unknown, citations: unknown): CodexSource {
  return { codex: () => Promise.resolve(codex), citations: () => Promise.resolve(citations) };
}

/** Tries `primary` for each file and uses `fallback` for any file that fails to load. */
export function withFallback(primary: CodexSource, fallback: CodexSource): CodexSource {
  return {
    codex: () => primary.codex().catch(() => fallback.codex()),
    citations: () => primary.citations().catch(() => fallback.citations()),
  };
}

export interface CodexStoreOptions {
  source?: CodexSource;
  /** null disables persistence. Defaults to window.localStorage when available. */
  storage?: StorageLike | null;
  storageKey?: string;
  /** Clock for discovery times (ms). */
  now?: () => number;
}

interface Persisted {
  v: 1;
  log: DiscoveryRecord[];
  seen: string[];
}

export const CODEX_STORAGE_KEY = 'knownsky.codex.v1';

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // Accessing localStorage itself throws when storage is blocked.
  }
}

export class CodexStore {
  private list: CodexEntry[] = [];
  private readonly ids = new Map<string, CodexEntry>();
  private readonly bodies = new Map<string, CodexEntry>();
  private cites = new Map<string, CodexCitation>();
  private records: DiscoveryRecord[] = [];
  private readonly recordIds = new Map<string, number>();
  private readonly seenIds = new Set<string>();
  private readonly discoverCbs = new Set<DiscoverListener>();
  private readonly changeCbs = new Set<() => void>();
  /** Discoveries made before the content loaded; announced once it has. */
  private early: DiscoveryRecord[] = [];
  private loading: Promise<void> | null = null;
  private readonly source: CodexSource;
  private readonly storage: StorageLike | null;
  private readonly key: string;
  private readonly now: () => number;

  /** True once load() (or setData()) has finished, whether or not the files were found. */
  loaded = false;
  /** Why loading failed, if it did; the store is then empty but usable. */
  error: string | null = null;
  /** Content problems found while parsing (dropped entries, missing citations, ...), for authors and tests. */
  problems: string[] = [];

  constructor(opts: CodexStoreOptions = {}) {
    this.source = opts.source ?? publicDataSource();
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.key = opts.storageKey ?? CODEX_STORAGE_KEY;
    this.now = opts.now ?? Date.now;
    this.restore();
  }

  /** Loads content once; later calls return the same promise. Never rejects. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      const [codex, citations] = await Promise.allSettled([this.source.codex(), this.source.citations()]);
      const errors: string[] = [];
      if (codex.status === 'rejected') errors.push(`codex: ${String(codex.reason)}`);
      if (citations.status === 'rejected') errors.push(`citations: ${String(citations.reason)}`);
      this.setData(
        codex.status === 'fulfilled' ? codex.value : { version: 1, entries: [] },
        citations.status === 'fulfilled' ? citations.value : {},
      );
      this.error = errors.length > 0 ? errors.join('; ') : null;
      if (this.error) console.warn(`Codex: ${this.error}`);
    })();
    return this.loading;
  }

  /** Replaces the content synchronously (also used by load()). */
  setData(codexRaw: unknown, citationsRaw: unknown): void {
    const codex = parseCodex(codexRaw);
    const cites = parseCitations(citationsRaw);
    this.list = codex.value;
    this.ids.clear();
    this.bodies.clear();
    for (const e of this.list) {
      this.ids.set(e.id, e);
      if (e.bodyId !== undefined && !this.bodies.has(e.bodyId)) this.bodies.set(e.bodyId, e);
    }
    this.cites = cites.value;
    const problems = [...codex.problems, ...cites.problems];
    for (const e of this.list) {
      for (const k of [...e.facts.map((f) => f.citation), ...e.howWeKnow.map((c) => c.citation)]) {
        if (k && !this.cites.has(k)) problems.push(`${e.id}: citation "${k}" not found in citations.json`);
      }
    }
    this.problems = [...new Set(problems)];
    this.loaded = true;
    this.error = null;
    // Announce discoveries made while loading.
    const early = this.early;
    this.early = [];
    for (const r of early) {
      const e = this.ids.get(r.id);
      if (e && e.unlock !== 'start') this.emitDiscover(e, r.at);
    }
    this.emitChange();
  }

  entries(): readonly CodexEntry[] {
    return this.list;
  }

  entry(id: string): CodexEntry | undefined {
    return this.ids.get(id);
  }

  /** The entry for a world object, by NAIF body id (as in bodies.json). */
  byBodyId(bodyId: string): CodexEntry | undefined {
    return this.bodies.get(bodyId);
  }

  byKind(kind: CodexKind): CodexEntry[] {
    return this.list.filter((e) => e.kind === kind);
  }

  citation(key: string): CodexCitation | undefined {
    return this.cites.get(key);
  }

  /** Entries with unlock "start" are always known; others once discover() has recorded them. */
  discovered(id: string): boolean {
    const e = this.ids.get(id);
    return e?.unlock === 'start' || this.recordIds.has(id);
  }

  /** When the entry was discovered (ms), or null for start entries and undiscovered ones. */
  discoveredAt(id: string): number | null {
    const i = this.recordIds.get(id);
    return i === undefined ? null : this.records[i]!.at;
  }

  /**
   * Records a discovery. Returns true when the entry is newly discovered (listeners are then called with it), false
   * when it was already known or does not exist. Calls made before load() finishes are recorded and announced once
   * the content is available.
   */
  discover(id: string): boolean {
    if (this.loaded) {
      const e = this.ids.get(id);
      if (!e || e.unlock === 'start') return false;
    }
    if (this.recordIds.has(id)) return false;
    const rec: DiscoveryRecord = { id, at: this.now() };
    this.recordIds.set(id, this.records.length);
    this.records.push(rec);
    this.persist();
    if (this.loaded) {
      this.emitDiscover(this.ids.get(id)!, rec.at);
      this.emitChange();
    } else this.early.push(rec);
    return true;
  }

  /** Subscribes to new discoveries; returns an unsubscribe function. */
  onDiscover(cb: DiscoverListener): () => void {
    this.discoverCbs.add(cb);
    return () => this.discoverCbs.delete(cb);
  }

  /** Subscribes to any change in content or progress (load, discover, seen, reset). */
  onChange(cb: () => void): () => void {
    this.changeCbs.add(cb);
    return () => this.changeCbs.delete(cb);
  }

  /** Discoveries in the order they happened (start entries are not discoveries). */
  log(): DiscoveryRecord[] {
    return this.records.filter((r) => {
      if (!this.loaded) return true;
      const e = this.ids.get(r.id);
      return e !== undefined && e.unlock !== 'start';
    });
  }

  /** Discovered and not yet opened in the Codex. */
  isNew(id: string): boolean {
    return this.recordIds.has(id) && !this.seenIds.has(id) && this.ids.get(id)?.unlock !== 'start';
  }

  markSeen(id: string): void {
    if (!this.isNew(id)) return;
    this.seenIds.add(id);
    this.persist();
    this.emitChange();
  }

  newCount(kind?: CodexKind): number {
    return this.list.filter((e) => (kind === undefined || e.kind === kind) && this.isNew(e.id)).length;
  }

  progress(kind?: CodexKind): { discovered: number; total: number } {
    const set = kind === undefined ? this.list : this.list.filter((e) => e.kind === kind);
    return { discovered: set.filter((e) => this.discovered(e.id)).length, total: set.length };
  }

  /**
   * Discovered entries matching every word of the query (title first, then summary, body and fact labels).
   * Locked entries never match, so search cannot reveal what is still undiscovered.
   */
  search(query: string): CodexEntry[] {
    const words = normalizeSearch(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const scored: { e: CodexEntry; score: number }[] = [];
    for (const e of this.list) {
      if (!this.discovered(e.id)) continue;
      const title = normalizeSearch(e.title);
      const rest = normalizeSearch(
        [e.summary, ...e.body, ...e.facts.map((f) => f.label), e.starName ?? '', t(`codex.kind.${e.kind}`)].join(' '),
      );
      let score = 0;
      for (const w of words) {
        if (title.startsWith(w)) score += 4;
        else if (title.includes(w)) score += 3;
        else if (rest.includes(w)) score += 1;
        else {
          score = -1;
          break;
        }
      }
      if (score > 0) scored.push({ e, score });
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.e);
  }

  /** Forgets all progress (and clears it from storage). */
  reset(): void {
    this.records = [];
    this.recordIds.clear();
    this.seenIds.clear();
    this.early = [];
    try {
      this.storage?.removeItem(this.key);
    } catch {
      // Storage blocked: progress was in memory only.
    }
    this.emitChange();
  }

  private emitDiscover(e: CodexEntry, at: number): void {
    for (const cb of [...this.discoverCbs]) {
      try {
        cb(e, at);
      } catch (err) {
        console.error('Codex discover listener failed', err);
      }
    }
  }

  private emitChange(): void {
    for (const cb of [...this.changeCbs]) {
      try {
        cb();
      } catch (err) {
        console.error('Codex change listener failed', err);
      }
    }
  }

  private restore(): void {
    let raw: string | null;
    try {
      raw = this.storage?.getItem(this.key) ?? null;
    } catch {
      return;
    }
    if (!raw) return;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return; // Corrupt progress: start fresh rather than fail.
    }
    if (typeof data !== 'object' || data === null) return;
    const d = data as Partial<Persisted>;
    if (Array.isArray(d.log)) {
      for (const r of d.log as unknown[]) {
        if (typeof r !== 'object' || r === null) continue;
        const { id, at } = r as Record<string, unknown>;
        if (typeof id !== 'string' || typeof at !== 'number' || !Number.isFinite(at) || this.recordIds.has(id))
          continue;
        this.recordIds.set(id, this.records.length);
        this.records.push({ id, at });
      }
    }
    if (Array.isArray(d.seen)) for (const s of d.seen as unknown[]) if (typeof s === 'string') this.seenIds.add(s);
  }

  private persist(): void {
    if (!this.storage) return;
    const data: Persisted = { v: 1, log: this.records, seen: [...this.seenIds] };
    try {
      this.storage.setItem(this.key, JSON.stringify(data));
    } catch {
      // Quota exceeded or storage blocked: keep going in memory.
    }
  }
}

const endsWithPunct = (s: string): boolean => /[.?!]$/.test(s.trim());
const sentence = (s: string): string => (endsWithPunct(s) ? s.trim() : `${s.trim()}.`);

/**
 * Plain-text reference, e.g. "Agol, E. et al. (2021). Refining the ... Ephemerides. The Planetary Science Journal
 * 2(1), 1. doi:10.3847/PSJ/abd022". The DOI is preferred over the URL.
 */
export function formatCitation(c: CodexCitation): string {
  const parts = [`${c.authors.trim()} (${c.year ?? t('codex.cite.noDate')}).`, sentence(c.title)];
  if (c.venue.trim()) parts.push(sentence(c.venue));
  const link = c.doi ? `doi:${c.doi}` : c.url.trim();
  if (link) parts.push(link);
  return parts.join(' ');
}

/** Safe link target for a citation (https DOI resolver, else an http(s) URL), or null. */
export function citationHref(c: CodexCitation): string | null {
  if (c.doi) return `https://doi.org/${encodeURI(c.doi)}`;
  try {
    const u = new URL(c.url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
