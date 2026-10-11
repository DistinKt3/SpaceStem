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
import { entrySystem, normalizeSearch } from './format';
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
  // A dev server answers a missing file with its HTML page, which fails to parse: report that as "missing". Other
  // errors ("fetch codex/en.json: 404", network failures) already say what failed and pass through unchanged.
  const get = (path: string): Promise<unknown> =>
    fetchJson<unknown>(path).catch((err: unknown) => {
      throw err instanceof SyntaxError ? new Error(`${path} is missing or not JSON`) : err;
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

const errorText = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

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
  /** Star entries by normalised star name and title. */
  private readonly stars = new Map<string, CodexEntry>();
  private cites = new Map<string, CodexCitation>();
  private records: DiscoveryRecord[] = [];
  private readonly recordIds = new Map<string, number>();
  private readonly seenIds = new Set<string>();
  private readonly discoverCbs = new Set<DiscoverListener>();
  private readonly changeCbs = new Set<() => void>();
  /**
   * Discoveries asked for before the content loaded (id -> time). They are recorded, persisted and announced only once
   * the content shows that they name real, non-start entries.
   */
  private early = new Map<string, number>();
  private loading: Promise<void> | null = null;
  /** The last content that loaded, kept when a retry fails for one of the files. */
  private raw: { codex?: unknown; citations?: unknown } = {};
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

  /**
   * Loads the content. Never rejects. While a load is running, or once one has succeeded, later calls return the same
   * promise; after a failed load (`error` is set) a later call tries again, keeping whatever did load before.
   */
  load(): Promise<void> {
    this.loading ??= (async () => {
      const [codex, citations] = await Promise.allSettled([this.source.codex(), this.source.citations()]);
      const errors: string[] = [];
      if (codex.status === 'fulfilled') this.raw.codex = codex.value;
      else errors.push(`codex: ${errorText(codex.reason)}`);
      if (citations.status === 'fulfilled') this.raw.citations = citations.value;
      else errors.push(`citations: ${errorText(citations.reason)}`);
      const error = errors.length > 0 ? errors.join('; ') : null;
      // The error is part of what change listeners see, so it is set together with the content.
      this.apply(this.raw.codex ?? { version: 1, entries: [] }, this.raw.citations ?? {}, error);
      if (error) {
        console.warn(`Codex data failed to load (${error})`);
        this.loading = null; // The next load() tries again.
      }
    })();
    return this.loading;
  }

  /** Replaces the content synchronously (tests, demos) and clears any load error. */
  setData(codexRaw: unknown, citationsRaw: unknown): void {
    this.raw = { codex: codexRaw, citations: citationsRaw };
    this.apply(codexRaw, citationsRaw, null);
  }

  private apply(codexRaw: unknown, citationsRaw: unknown, error: string | null): void {
    const codex = parseCodex(codexRaw);
    const cites = parseCitations(citationsRaw);
    this.list = codex.value;
    this.ids.clear();
    this.bodies.clear();
    this.stars.clear();
    for (const e of this.list) {
      this.ids.set(e.id, e);
      if (e.bodyId !== undefined && !this.bodies.has(e.bodyId)) this.bodies.set(e.bodyId, e);
    }
    // Star names before titles, so that a title never shadows another star's catalogue name.
    const starEntries = this.list.filter((e) => e.kind === 'star');
    for (const [name, e] of [
      ...starEntries.map((x) => [x.starName, x] as const),
      ...starEntries.map((x) => [x.title, x] as const),
    ]) {
      const key = name ? normalizeSearch(name) : '';
      if (key && !this.stars.has(key)) this.stars.set(key, e);
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
    this.error = error;
    // Discoveries asked for while loading: record and announce the ones that name real, non-start entries.
    const early = this.early;
    this.early = new Map();
    const fresh: [CodexEntry, number][] = [];
    for (const [id, at] of early) {
      const e = this.ids.get(id);
      if (!e || e.unlock === 'start' || this.recordIds.has(id)) continue;
      this.recordIds.set(id, this.records.length);
      this.records.push({ id, at });
      fresh.push([e, at]);
    }
    if (fresh.length > 0) this.persist();
    for (const [e, at] of fresh) this.emitDiscover(e, at);
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

  /**
   * The star entry for a star's name, matched against the star entries' star names and titles with case and accents
   * ignored ("Proxima Centauri", "TRAPPIST-1"): for hyperspeed arrivals at catalogue stars.
   */
  byStarName(name: string): CodexEntry | undefined {
    const key = normalizeSearch(name);
    return key ? this.stars.get(key) : undefined;
  }

  /** Every entry in a star system ("sol", "trappist-1"), its star first. Solar System bodies count as "sol". */
  bySystem(systemId: string): CodexEntry[] {
    const inSystem = this.list.filter((e) => entrySystem(e) === systemId);
    return [...inSystem.filter((e) => e.kind === 'star'), ...inSystem.filter((e) => e.kind !== 'star')];
  }

  byKind(kind: CodexKind): CodexEntry[] {
    return this.list.filter((e) => e.kind === kind);
  }

  citation(key: string): CodexCitation | undefined {
    return this.cites.get(key);
  }

  /**
   * Entries with unlock "start" are always known; others once discover() has recorded them. Before the content has
   * loaded, ids passed to discover() count as discovered (provisionally, as discover() explains).
   */
  discovered(id: string): boolean {
    const e = this.ids.get(id);
    return e?.unlock === 'start' || this.recordIds.has(id) || (!this.loaded && this.early.has(id));
  }

  /** When the entry was discovered (ms), or null for start entries and undiscovered ones. */
  discoveredAt(id: string): number | null {
    const i = this.recordIds.get(id);
    return i === undefined ? null : this.records[i]!.at;
  }

  /**
   * Records a discovery. Returns true when the entry is newly discovered (listeners are then called with it), false
   * when it was already known or does not exist.
   *
   * Before the content has loaded the answer is provisional: the id is queued, and true is returned unless it was
   * already recorded or queued. When the content arrives, queued ids that name real entries (not "start" ones) are
   * recorded with the time of the call, persisted and announced; any other id is dropped without a trace.
   */
  discover(id: string): boolean {
    if (this.recordIds.has(id)) return false;
    if (!this.loaded) {
      if (this.early.has(id)) return false;
      this.early.set(id, this.now());
      return true;
    }
    const e = this.ids.get(id);
    if (!e || e.unlock === 'start') return false;
    const rec: DiscoveryRecord = { id, at: this.now() };
    this.recordIds.set(id, this.records.length);
    this.records.push(rec);
    this.persist();
    this.emitDiscover(e, rec.at);
    this.emitChange();
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
    this.early.clear();
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
