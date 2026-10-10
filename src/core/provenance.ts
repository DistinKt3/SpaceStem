/**
 * The epistemic layer. Every world object and every displayed fact carries provenance, a source and a citation.
 * - measured:  directly observed and catalogued
 * - inferred:  not observed, but constrained by science from measured values
 * - generated: plausible fill from physical rules where we have no data
 */
export type Provenance = 'measured' | 'inferred' | 'generated';

export const PROVENANCE_ORDER: Record<Provenance, number> = { measured: 0, inferred: 1, generated: 2 };

/** Key into public/data/citations.json. */
export type CitationKey = string;

export interface Citation {
  readonly key: CitationKey;
  readonly authors: string;
  readonly year: number;
  readonly title: string;
  readonly venue: string;
  readonly doi?: string;
  readonly url?: string;
}

/** A displayed value with its own provenance. */
export interface Sourced<T> {
  readonly value: T;
  readonly provenance: Provenance;
  /** Short human-readable dataset or method, e.g. "JPL DE421 ephemeris" or "transit photometry". */
  readonly source: string;
  readonly citation: CitationKey;
  /** One-sigma uncertainty in the same unit as value, when known. */
  readonly uncertainty?: number;
  readonly unit?: string;
  /** Caveat shown in the "How do we know this?" panel. */
  readonly note?: string;
}

export interface ProvenanceTagged {
  readonly provenance: Provenance;
  readonly source: string;
  readonly citation: CitationKey;
}

/** The weakest (least certain) of several provenances. */
export function weakest(...ps: Provenance[]): Provenance {
  let w: Provenance = 'measured';
  for (const p of ps) if (PROVENANCE_ORDER[p] > PROVENANCE_ORDER[w]) w = p;
  return w;
}

export function sourced<T>(
  value: T,
  provenance: Provenance,
  source: string,
  citation: CitationKey,
  extra: Partial<Pick<Sourced<T>, 'uncertainty' | 'unit' | 'note'>> = {},
): Sourced<T> {
  return { value, provenance, source, citation, ...extra };
}
