/**
 * Codex data model and defensive parsing of public/data/codex/<locale>.json and public/data/citations.json.
 *
 * The files are authored by hand, so parsing never throws: malformed entries, facts and citations are dropped (or given
 * a conservative default) and described in `problems`. One rule is absolute: a fact or claim without a valid
 * provenance tier is dropped, never shown with a guessed tier, so inferred or generated content cannot appear as fact.
 */
import type { Provenance } from '../../core/provenance';

export type CodexKind = 'body' | 'star' | 'exoplanet' | 'concept';
export const CODEX_KINDS: readonly CodexKind[] = ['body', 'star', 'exoplanet', 'concept'];

/** When an entry becomes readable: known from the start, on visiting the object, or on scanning it. */
export type CodexUnlock = 'start' | 'visit' | 'scan';
const UNLOCKS: readonly CodexUnlock[] = ['start', 'visit', 'scan'];

export const PROVENANCES: readonly Provenance[] = ['measured', 'inferred', 'generated'];

export interface CodexFact {
  readonly label: string;
  readonly value: string | number;
  readonly unit?: string;
  /** One-sigma uncertainty in the value's unit (number), or a preformatted string such as "+0.013 / -0.012". */
  readonly uncertainty?: string | number;
  readonly provenance: Provenance;
  readonly method: string;
  /** Key into citations.json. */
  readonly citation: string;
}

export interface CodexClaim {
  readonly claim: string;
  readonly method: string;
  readonly provenance: Provenance;
  readonly citation: string;
}

export interface CodexEntry {
  readonly id: string;
  readonly title: string;
  readonly kind: CodexKind;
  /** NAIF id of a Solar System body (matches BodyDef.id in bodies.json), when the entry describes one. */
  readonly bodyId?: string;
  readonly starName?: string;
  readonly systemId?: string;
  readonly unlock: CodexUnlock;
  readonly summary: string;
  /** Paragraphs; `**bold**` spans are allowed. */
  readonly body: readonly string[];
  readonly facts: readonly CodexFact[];
  readonly howWeKnow: readonly CodexClaim[];
  /** Ids of related entries. */
  readonly related: readonly string[];
}

export interface CodexCitation {
  readonly authors: string;
  readonly year: number | null;
  readonly title: string;
  readonly venue: string;
  readonly doi: string | null;
  readonly url: string;
  /** ISO date the source was last checked. */
  readonly accessed: string;
  /** True once the citation was checked against the original source. */
  readonly verified: boolean;
  readonly license?: string;
  readonly note?: string;
}

export interface Parsed<T> {
  readonly value: T;
  readonly problems: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isProvenance(v: unknown): v is Provenance {
  return typeof v === 'string' && (PROVENANCES as readonly string[]).includes(v);
}

function parseFact(raw: unknown, where: string, problems: string[]): CodexFact | null {
  if (!isObj(raw)) {
    problems.push(`${where}: fact is not an object; dropped`);
    return null;
  }
  const label = nonEmpty(raw['label']);
  if (!label) {
    problems.push(`${where}: fact without a label; dropped`);
    return null;
  }
  const value = raw['value'];
  if (!(typeof value === 'string' || finite(value))) {
    problems.push(`${where}: fact "${label}" has no string or finite number value; dropped`);
    return null;
  }
  if (!isProvenance(raw['provenance'])) {
    problems.push(`${where}: fact "${label}" has no valid provenance; dropped (a value is never shown without its tier)`);
    return null;
  }
  const method = str(raw['method']) ?? '';
  const citation = str(raw['citation']) ?? '';
  if (!method) problems.push(`${where}: fact "${label}" has no method`);
  if (!citation) problems.push(`${where}: fact "${label}" has no citation`);
  const unit = nonEmpty(raw['unit']);
  const unc = raw['uncertainty'];
  const uncertainty = finite(unc) || nonEmpty(unc) ? (unc as string | number) : undefined;
  return {
    label,
    value,
    provenance: raw['provenance'],
    method,
    citation,
    ...(unit !== undefined ? { unit } : {}),
    ...(uncertainty !== undefined ? { uncertainty } : {}),
  };
}

function parseClaim(raw: unknown, where: string, problems: string[]): CodexClaim | null {
  if (!isObj(raw)) {
    problems.push(`${where}: claim is not an object; dropped`);
    return null;
  }
  const claim = nonEmpty(raw['claim']);
  if (!claim) {
    problems.push(`${where}: claim without text; dropped`);
    return null;
  }
  if (!isProvenance(raw['provenance'])) {
    problems.push(`${where}: claim "${claim.slice(0, 40)}" has no valid provenance; dropped`);
    return null;
  }
  const method = str(raw['method']) ?? '';
  const citation = str(raw['citation']) ?? '';
  if (!citation) problems.push(`${where}: claim "${claim.slice(0, 40)}" has no citation`);
  return { claim, method, provenance: raw['provenance'], citation };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
}

function parseEntry(raw: unknown, index: number, problems: string[]): CodexEntry | null {
  if (!isObj(raw)) {
    problems.push(`entries[${index}]: not an object; dropped`);
    return null;
  }
  const id = nonEmpty(raw['id']);
  if (!id) {
    problems.push(`entries[${index}]: missing id; dropped`);
    return null;
  }
  const title = nonEmpty(raw['title']);
  if (!title) {
    problems.push(`${id}: missing title; dropped`);
    return null;
  }
  const kind = raw['kind'];
  if (!(CODEX_KINDS as readonly unknown[]).includes(kind)) {
    problems.push(`${id}: unknown kind ${JSON.stringify(kind)}; dropped`);
    return null;
  }
  let unlock = raw['unlock'] as CodexUnlock;
  if (!UNLOCKS.includes(unlock)) {
    problems.push(`${id}: unknown unlock ${JSON.stringify(raw['unlock'])}; treated as "visit"`);
    unlock = 'visit';
  }
  const facts = (Array.isArray(raw['facts']) ? raw['facts'] : [])
    .map((f, i) => parseFact(f, `${id}.facts[${i}]`, problems))
    .filter((f): f is CodexFact => f !== null);
  const howWeKnow = (Array.isArray(raw['howWeKnow']) ? raw['howWeKnow'] : [])
    .map((c, i) => parseClaim(c, `${id}.howWeKnow[${i}]`, problems))
    .filter((c): c is CodexClaim => c !== null);
  const bodyId = nonEmpty(raw['bodyId']);
  const starName = nonEmpty(raw['starName']);
  const systemId = nonEmpty(raw['systemId']);
  return {
    id,
    title,
    kind: kind as CodexKind,
    unlock,
    summary: str(raw['summary']) ?? '',
    body: strings(raw['body']),
    facts,
    howWeKnow,
    related: strings(raw['related']).filter((r) => r !== id),
    ...(bodyId !== undefined ? { bodyId } : {}),
    ...(starName !== undefined ? { starName } : {}),
    ...(systemId !== undefined ? { systemId } : {}),
  };
}

/** Parses a codex file ({ version: 1, entries: [...] }). Duplicate ids keep the first entry. */
export function parseCodex(raw: unknown): Parsed<CodexEntry[]> {
  const problems: string[] = [];
  if (!isObj(raw) || !Array.isArray(raw['entries'])) {
    return { value: [], problems: ['codex: expected an object with an "entries" array'] };
  }
  if (raw['version'] !== 1) problems.push(`codex: unexpected version ${JSON.stringify(raw['version'])}; reading as version 1`);
  const seen = new Set<string>();
  const out: CodexEntry[] = [];
  raw['entries'].forEach((e, i) => {
    const entry = parseEntry(e, i, problems);
    if (!entry) return;
    if (seen.has(entry.id)) {
      problems.push(`${entry.id}: duplicate id; later copy dropped`);
      return;
    }
    seen.add(entry.id);
    out.push(entry);
  });
  // Related links must point at entries that exist.
  const fixed = out.map((e) => {
    const missing = e.related.filter((r) => !seen.has(r));
    if (missing.length === 0) return e;
    problems.push(`${e.id}: related ids not found: ${missing.join(', ')}`);
    return { ...e, related: e.related.filter((r) => seen.has(r)) };
  });
  return { value: fixed, problems };
}

function parseCitation(key: string, raw: unknown, problems: string[]): CodexCitation | null {
  if (!isObj(raw)) {
    problems.push(`citation ${key}: not an object; dropped`);
    return null;
  }
  const authors = nonEmpty(raw['authors']);
  const title = nonEmpty(raw['title']);
  if (!authors || !title) {
    problems.push(`citation ${key}: missing authors or title; dropped`);
    return null;
  }
  const year = finite(raw['year']) ? raw['year'] : null;
  const verified = raw['verified'] === true;
  if (typeof raw['verified'] !== 'boolean') problems.push(`citation ${key}: "verified" is not a boolean; treated as false`);
  const license = nonEmpty(raw['license']);
  const note = nonEmpty(raw['note']);
  return {
    authors,
    year,
    title,
    venue: str(raw['venue']) ?? '',
    doi: nonEmpty(raw['doi']) ?? null,
    url: str(raw['url']) ?? '',
    accessed: str(raw['accessed']) ?? '',
    verified,
    ...(license !== undefined ? { license } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

/** Parses citations.json ({ [key]: citation }). */
export function parseCitations(raw: unknown): Parsed<Map<string, CodexCitation>> {
  const problems: string[] = [];
  const out = new Map<string, CodexCitation>();
  if (!isObj(raw)) return { value: out, problems: ['citations: expected an object keyed by citation id'] };
  for (const [key, v] of Object.entries(raw)) {
    const c = parseCitation(key, v, problems);
    if (c) out.set(key, c);
  }
  return { value: out, problems };
}
