/**
 * Codex content checks (mirror of tools/pipeline/codex_check.py, plus numeric consistency checks).
 * Every fact must carry provenance and a resolvable citation; Measured facts need a verified citation.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Provenance } from '../../src/core/provenance';
import { AU_M, SPEED_OF_LIGHT_M_PER_S } from '../../src/core/constants';
import { parsecsToLightYears } from '../../src/core/units';

interface Citation {
  authors: string;
  year: number | null;
  title: string;
  venue: string;
  doi: string | null;
  url: string;
  accessed: string;
  verified: boolean;
  license?: string;
  note?: string;
}

interface Fact {
  label: string;
  value: string | number;
  unit?: string;
  uncertainty?: string | number;
  provenance: Provenance;
  method: string;
  citation: string;
}

interface HowWeKnow {
  claim: string;
  method: string;
  provenance: Provenance;
  citation: string;
}

interface Entry {
  id: string;
  title: string;
  kind: 'body' | 'star' | 'exoplanet' | 'concept';
  bodyId?: string;
  starName?: string;
  systemId?: string;
  unlock: 'start' | 'visit' | 'scan';
  summary: string;
  body: string[];
  facts: Fact[];
  howWeKnow: HowWeKnow[];
  related: string[];
}

interface Codex {
  version: number;
  entries: Entry[];
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

const citations = readJson('public/data/citations.json') as Record<string, Citation>;
const codex = readJson('public/data/codex/en.json') as Codex;
const bodies = (
  readJson('public/data/bodies.json') as { bodies: { id: string; name: string; radiusM: number; citation: string }[] }
).bodies;
const starNames = new Set(
  Object.values((readJson('public/data/stars.json') as { named: Record<string, { name: string }> }).named).map(
    (s) => s.name,
  ),
);
const trappist = readJson('tools/exo/trappist1_verified.json') as {
  planets: Record<string, Record<string, { value: number }>>;
};

const PROVENANCES: readonly string[] = ['measured', 'inferred', 'generated'];
const KINDS: readonly string[] = ['body', 'star', 'exoplanet', 'concept'];
const UNLOCKS: readonly string[] = ['start', 'visit', 'scan'];
const REQUIRED_KEYS = [
  'bruneton2008',
  'archinal2018',
  'nasa-factsheet',
  'nasa-saturn-factsheet',
  'hyg-v41',
  'jpl-horizons',
  'de440',
  'naif-pck00011',
  'gaia-edr3-skymap',
  'blue-marble-ng',
  'black-marble-2016',
  'etopo2022',
  'lroc-wac',
  'lola',
  'usgs-pluto-mosaic',
  'usgs-charon-mosaic',
  'solar-system-scope',
  'nasa-3d-resources',
  'nasa-exoplanet-archive',
  'agol2021',
  'gillon2016',
  'gillon2017',
  'burgasser2017',
  'greene2023',
  'zieba2023',
  'anglada2016',
];

const isNonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const entryById = new Map(codex.entries.map((e) => [e.id, e]));
const factsOf = (id: string): Fact[] => entryById.get(id)?.facts ?? [];
const numericFact = (id: string, label: string): number | undefined => {
  const v = factsOf(id).find((f) => f.label === label)?.value;
  return isNumber(v) ? v : undefined;
};

/** Citation keys written as `citation: '...'` in TypeScript sources. */
function sourceCitationKeys(dir: string): string[] {
  const keys: string[] = [];
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.ts')) continue;
    for (const m of readFileSync(join(dir, name), 'utf8').matchAll(/citation:\s*'([^']+)'/g)) {
      if (m[1]) keys.push(m[1]);
    }
  }
  return keys;
}

describe('citations.json', () => {
  it('has every required data-source and science key', () => {
    for (const key of REQUIRED_KEYS) expect(citations[key], key).toBeDefined();
  });

  it('resolves every citation key used by bodies.json and the source code', () => {
    const used = new Set<string>(sourceCitationKeys('src'));
    for (const b of bodies) used.add(b.citation);
    const raw = readFileSync('public/data/bodies.json', 'utf8');
    for (const m of raw.matchAll(/"citation":\s*"([^"]+)"/g)) if (m[1]) used.add(m[1]);
    for (const key of used) expect(citations[key], `missing citation ${key}`).toBeDefined();
  });

  it('gives every entry the required fields with valid types', () => {
    for (const [key, c] of Object.entries(citations)) {
      expect(key).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      for (const field of ['authors', 'title', 'venue', 'url', 'accessed'] as const) {
        expect(isNonEmpty(c[field]), `${key}.${field}`).toBe(true);
      }
      expect(c.year === null || Number.isInteger(c.year), `${key}.year`).toBe(true);
      expect(c.doi === null || (typeof c.doi === 'string' && c.doi.startsWith('10.')), `${key}.doi`).toBe(true);
      expect(typeof c.verified, `${key}.verified`).toBe('boolean');
      expect(c.url.startsWith('https://'), `${key}.url`).toBe(true);
      expect(c.accessed, `${key}.accessed`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('codex/en.json structure', () => {
  it('is version 1 with unique, well-formed ids', () => {
    expect(codex.version).toBe(1);
    const ids = codex.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('has the required fields, enums and 3-6 body paragraphs on every entry', () => {
    for (const e of codex.entries) {
      expect(isNonEmpty(e.title), e.id).toBe(true);
      expect(isNonEmpty(e.summary), e.id).toBe(true);
      expect(KINDS, e.id).toContain(e.kind);
      expect(UNLOCKS, e.id).toContain(e.unlock);
      expect(e.body.length, e.id).toBeGreaterThanOrEqual(3);
      expect(e.body.length, e.id).toBeLessThanOrEqual(6);
      for (const p of e.body) expect(isNonEmpty(p), e.id).toBe(true);
      expect(e.howWeKnow.length, e.id).toBeGreaterThan(0);
      for (const r of e.related) {
        expect(entryById.has(r), `${e.id} -> ${r}`).toBe(true);
        expect(r, e.id).not.toBe(e.id);
      }
    }
  });

  it('gives every fact and claim a provenance and an existing citation', () => {
    for (const e of codex.entries) {
      const items: { provenance: string; citation: string; text: string; method: string }[] = [
        ...e.facts.map((f) => ({ ...f, text: f.label })),
        ...e.howWeKnow.map((h) => ({ ...h, text: h.claim })),
      ];
      for (const it of items) {
        const where = `${e.id}: ${it.text}`;
        expect(PROVENANCES, where).toContain(it.provenance);
        expect(isNonEmpty(it.method), where).toBe(true);
        expect(citations[it.citation], `${where} cites unknown '${it.citation}'`).toBeDefined();
      }
      for (const f of e.facts) {
        expect(isNumber(f.value) || isNonEmpty(f.value), `${e.id}: ${f.label} value`).toBe(true);
      }
    }
  });

  it('never rests a Measured fact or claim on an unverified citation', () => {
    for (const e of codex.entries) {
      for (const it of [...e.facts, ...e.howWeKnow]) {
        if (it.provenance !== 'measured') continue;
        expect(citations[it.citation]?.verified, `${e.id} cites unverified '${it.citation}'`).toBe(true);
      }
    }
  });

  it('links entries to real bodies and catalogue stars, and covers every body', () => {
    const ids = new Set(bodies.map((b) => b.id));
    const covered = new Set<string>();
    for (const e of codex.entries) {
      if (e.kind === 'body') expect(e.bodyId, e.id).toBeDefined();
      if (e.bodyId !== undefined) {
        expect(ids.has(e.bodyId), `${e.id} bodyId ${e.bodyId}`).toBe(true);
        covered.add(e.bodyId);
      }
      if (e.starName !== undefined) expect(starNames.has(e.starName), `${e.id} starName ${e.starName}`).toBe(true);
      if (e.systemId !== undefined) expect(e.systemId).toBe('trappist-1');
    }
    for (const b of bodies) expect(covered.has(b.id), `no entry for ${b.name}`).toBe(true);
  });
});

describe('codex honesty rules', () => {
  it('labels every exoplanet surface as Generated', () => {
    const planets = codex.entries.filter((e) => e.kind === 'exoplanet');
    expect(planets.length).toBeGreaterThanOrEqual(8);
    for (const p of planets) {
      expect(
        p.facts.some((f) => f.provenance === 'generated'),
        p.id,
      ).toBe(true);
      expect(
        p.body.some((para) => para.includes('Generated')),
        p.id,
      ).toBe(true);
    }
  });

  it('includes the JWST results for TRAPPIST-1 b and c', () => {
    const cites = (id: string): string[] =>
      [...factsOf(id), ...(entryById.get(id)?.howWeKnow ?? [])].map((x) => x.citation);
    expect(cites('trappist-1b')).toContain('greene2023');
    expect(cites('trappist-1c')).toContain('zieba2023');
  });

  it('marks derived quantities (densities, distances in light-years, equilibrium temperatures) as Inferred', () => {
    for (const e of codex.entries) {
      for (const f of e.facts) {
        if (/density|equilibrium temperature/i.test(f.label) || (f.label === 'Distance' && f.unit === 'ly')) {
          expect(f.provenance, `${e.id}: ${f.label}`).toBe('inferred');
        }
      }
    }
  });
});

describe('codex numbers agree with the game data', () => {
  it('uses the same mean radii as bodies.json', () => {
    for (const b of bodies) {
      const e = codex.entries.find((x) => x.bodyId === b.id);
      const fact = e?.facts.find((f) => f.label === 'Mean radius');
      expect(fact, b.name).toBeDefined();
      if (!fact || !isNumber(fact.value)) continue;
      const gameKm = b.radiusM / 1000;
      const tol = Math.max(gameKm * 1e-3, isNumber(fact.uncertainty) ? fact.uncertainty : 0);
      expect(Math.abs(fact.value - gameKm), b.name).toBeLessThanOrEqual(tol);
    }
  });

  it('converts parallaxes to light-years correctly', () => {
    for (const e of codex.entries) {
      const plx = e.facts.find((f) => /parallax/i.test(f.label) && f.unit === 'mas');
      const dist = e.facts.find((f) => f.label === 'Distance' && f.unit === 'ly');
      if (!plx || !dist || !isNumber(plx.value) || !isNumber(dist.value)) continue;
      const expected = parsecsToLightYears(1000 / plx.value);
      expect(Math.abs(dist.value - expected) / expected, e.id).toBeLessThan(0.002);
    }
  });

  it('matches the TRAPPIST-1 values used by the exoplanet pipeline', () => {
    for (const letter of ['b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const p = trappist.planets[letter];
      expect(p, letter).toBeDefined();
      if (!p) continue;
      const id = `trappist-1${letter}`;
      expect(numericFact(id, 'Radius'), id).toBe(p.radius_earth?.value);
      expect(numericFact(id, 'Mass'), id).toBe(p.mass_earth?.value);
      expect(numericFact(id, 'Orbital period'), id).toBe(p.period_days?.value);
      expect(numericFact(id, 'Orbital distance (semi-major axis)'), id).toBe(p.semi_major_axis_au?.value);
    }
  });

  it('states the light time for 1 au consistently with the constants', () => {
    expect(numericFact('concept-light-travel', 'Light time for 1 au')).toBeCloseTo(AU_M / SPEED_OF_LIGHT_M_PER_S, 5);
    expect(numericFact('concept-light-travel', 'Speed of light')).toBe(SPEED_OF_LIGHT_M_PER_S);
  });
});
