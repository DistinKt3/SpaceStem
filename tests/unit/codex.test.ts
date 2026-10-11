/**
 * Codex content checks. Mirrors tools/pipeline/codex_check.py (structure, citations, provenance rules) and adds what
 * only the game code can check: every number the Codex quotes about the game is recomputed from the file or function
 * it describes, the "In the game" paragraphs must name the texture source the pipeline really used, and prose must not
 * state as fact what the entry's own claims mark Inferred.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Provenance } from '../../src/core/provenance';
import { AU_M, JULIAN_YEAR_S, SPEED_OF_LIGHT_M_PER_S, SUN_RADIUS_M } from '../../src/core/constants';
import { parsecsToLightYears } from '../../src/core/units';
import { inferStar } from '../../src/world/starCatalog';

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

interface Body {
  id: string;
  name: string;
  radiusM: number;
  citation: string;
  surface?: { texture?: string; tiles?: string };
  rings?: { innerM: number; outerM: number };
}

const readText = (path: string): string => readFileSync(path, 'utf8');
const readJson = (path: string): unknown => JSON.parse(readText(path));

const citations = readJson('public/data/citations.json') as Record<string, Citation>;
const codex = readJson('public/data/codex/en.json') as Codex;
const bodies = (readJson('public/data/bodies.json') as { bodies: Body[] }).bodies;
const stars = readJson('public/data/stars.json') as {
  count: number;
  stride: number;
  named: Record<string, { name: string; absmag: number; bv: number }>;
};
const starNames = new Set(Object.values(stars.named).map((s) => s.name));
const trappist = readJson('tools/exo/trappist1_verified.json') as {
  planets: Record<string, Record<string, { value: number }>>;
};
const imagery = readJson('public/data/imagery.json') as { tex: Record<string, { filledFraction: number }> };

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
/** Entries the module spec requires besides one per body in bodies.json (same list as codex_check.py). */
const REQUIRED_IDS = [
  ...['', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((p) => `trappist-1${p}`),
  'sirius',
  'alpha-centauri-a',
  'alpha-centauri-b',
  'proxima-centauri',
  'proxima-centauri-b',
  'barnards-star',
  'betelgeuse',
  'polaris',
  'vega',
  ...[
    'provenance',
    'parallax',
    'transit',
    'ttv',
    'radial-velocity',
    'light-travel',
    'sky-blue',
    'tidal-locking',
    'habitable-zone',
    'ephemerides',
    'star-catalogues',
    'drive-fiction',
    'game-surfaces',
    'exoplanet-count',
    'star-brightness',
  ].map((c) => `concept-${c}`),
];
/** Known Sky self-references and the provenance tiers each may back. */
const SELF_TIERS: Readonly<Record<string, readonly string[]>> = {
  'known-sky-source': ['generated'],
  'known-sky-exo-rules': ['generated', 'inferred'],
  'known-sky-pipeline': ['measured', 'inferred', 'generated'],
};
const GAME_LABEL = /\bgame\b|\bgame's\b|\bin-game\b/i;
const PREPRINT_VENUE = /\barXiv\b|Research Notes of the AAS/i;
const CITATION_FIELDS = new Set([
  'authors',
  'year',
  'title',
  'venue',
  'doi',
  'url',
  'accessed',
  'verified',
  'license',
  'note',
]);
const ENTRY_FIELDS = new Set([
  'id',
  'title',
  'kind',
  'bodyId',
  'starName',
  'systemId',
  'unlock',
  'summary',
  'body',
  'facts',
  'howWeKnow',
  'related',
]);
const FACT_FIELDS = new Set(['label', 'value', 'unit', 'uncertainty', 'provenance', 'method', 'citation']);
const CLAIM_FIELDS = new Set(['claim', 'method', 'provenance', 'citation']);

const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const unknownFields = (o: object, allowed: Set<string>): string[] => Object.keys(o).filter((k) => !allowed.has(k));
const isSelf = (key: string): boolean => Object.hasOwn(SELF_TIERS, key);
const notPeerReviewed = (c: Citation): boolean => PREPRINT_VENUE.test(c.venue) && !c.venue.includes('IAU');
const entryById = new Map(codex.entries.map((e) => [e.id, e]));
const entry = (id: string): Entry => {
  const e = entryById.get(id);
  if (!e) throw new Error(`no Codex entry ${id}`);
  return e;
};
const factOf = (id: string, label: string): Fact => {
  const f = entry(id).facts.find((x) => x.label === label);
  if (!f) throw new Error(`no fact "${label}" in ${id}`);
  return f;
};
const numericFact = (id: string, label: string): number => {
  const v = factOf(id, label).value;
  if (!isNumber(v)) throw new Error(`fact "${label}" in ${id} is not a number`);
  return v;
};
const bodyById = new Map(bodies.map((b) => [b.id, b]));
const relErr = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b);

/** Citation keys written as `citation: '...'` in TypeScript sources. */
function sourceCitationKeys(dir: string): string[] {
  const keys: string[] = [];
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.ts')) continue;
    for (const m of readText(join(dir, name)).matchAll(/citation:\s*'([^']+)'/g)) {
      if (m[1]) keys.push(m[1]);
    }
  }
  return keys;
}

/** Citation keys written as "citation": "..." in a JSON file. */
const jsonCitationKeys = (path: string): string[] =>
  [...readText(path).matchAll(/"citation":\s*"([^"]+)"/g)].map((m) => m[1] ?? '');

describe('citations.json', () => {
  it('has every required data-source and science key, and the Known Sky self-references', () => {
    for (const key of [...REQUIRED_KEYS, ...Object.keys(SELF_TIERS)]) expect(citations[key], key).toBeDefined();
  });

  it('resolves every citation key used by bodies.json, the star systems and the source code', () => {
    const used = new Set<string>([...sourceCitationKeys('src'), ...jsonCitationKeys('public/data/bodies.json')]);
    for (const name of readdirSync('public/data/systems')) {
      if (name.endsWith('.json')) for (const k of jsonCitationKeys(join('public/data/systems', name))) used.add(k);
    }
    for (const key of used) expect(citations[key], `missing citation ${key}`).toBeDefined();
  });

  it('gives every entry the required fields with valid types and no unknown fields', () => {
    for (const [key, c] of Object.entries(citations)) {
      expect(key).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(unknownFields(c, CITATION_FIELDS), key).toEqual([]);
      for (const field of ['authors', 'title', 'venue', 'url', 'accessed'] as const) {
        expect(isNonEmpty(c[field]), `${key}.${field}`).toBe(true);
      }
      expect(c.year === null || Number.isInteger(c.year), `${key}.year`).toBe(true);
      expect(c.doi === null || (typeof c.doi === 'string' && c.doi.startsWith('10.')), `${key}.doi`).toBe(true);
      expect(typeof c.verified, `${key}.verified`).toBe('boolean');
      expect(c.url.startsWith('https://'), `${key}.url`).toBe(true);
      expect(c.accessed, `${key}.accessed`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (c.license !== undefined) expect(isNonEmpty(c.license), `${key}.license`).toBe(true);
      if (c.note !== undefined) expect(isNonEmpty(c.note), `${key}.note`).toBe(true);
    }
  });
});

describe('codex/en.json structure', () => {
  it('is version 1 with unique, well-formed ids and every required entry', () => {
    expect(unknownFields(codex, new Set(['version', 'entries']))).toEqual([]);
    expect(codex.version).toBe(1);
    const ids = codex.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    for (const id of REQUIRED_IDS) expect(entryById.has(id), `missing required entry ${id}`).toBe(true);
  });

  it('has the required fields, enums, short summaries and 3-6 body paragraphs on every entry', () => {
    for (const e of codex.entries) {
      expect(unknownFields(e, ENTRY_FIELDS), e.id).toEqual([]);
      expect(isNonEmpty(e.title), e.id).toBe(true);
      expect(isNonEmpty(e.summary), e.id).toBe(true);
      expect(
        [...e.summary.matchAll(/[.!?](?:\s|$)/g)].length,
        `${e.id}: summary should be 1-2 sentences`,
      ).toBeLessThanOrEqual(2);
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
      for (const f of e.facts) expect(unknownFields(f, FACT_FIELDS), `${e.id}: ${f.label}`).toEqual([]);
      for (const h of e.howWeKnow) expect(unknownFields(h, CLAIM_FIELDS), `${e.id}: ${h.claim}`).toEqual([]);
    }
  });

  it('gives every fact and claim a provenance, a method and an existing citation, and finite numbers', () => {
    for (const e of codex.entries) {
      const items = [
        ...e.facts.map((f) => ({ ...f, text: f.label })),
        ...e.howWeKnow.map((h) => ({ ...h, text: h.claim })),
      ];
      for (const item of items) {
        const where = `${e.id}: ${item.text}`;
        expect(PROVENANCES, where).toContain(item.provenance);
        expect(isNonEmpty(item.method), where).toBe(true);
        expect(citations[item.citation], `${where} cites unknown '${item.citation}'`).toBeDefined();
      }
      for (const f of e.facts) {
        expect(isNumber(f.value) || isNonEmpty(f.value), `${e.id}: ${f.label} value`).toBe(true);
        if (f.unit !== undefined) expect(isNonEmpty(f.unit), `${e.id}: ${f.label} unit`).toBe(true);
        if (f.uncertainty !== undefined) {
          expect(isNumber(f.uncertainty) || isNonEmpty(f.uncertainty), `${e.id}: ${f.label} uncertainty`).toBe(true);
        }
      }
    }
  });

  it('links entries to real bodies and catalogue stars, and covers every body', () => {
    const covered = new Set<string>();
    for (const e of codex.entries) {
      if (e.kind === 'body') expect(e.bodyId, e.id).toBeDefined();
      if (e.bodyId !== undefined) {
        expect(e.kind, e.id).toBe('body');
        expect(bodyById.has(e.bodyId), `${e.id} bodyId ${e.bodyId}`).toBe(true);
        covered.add(e.bodyId);
      }
      if (e.starName !== undefined) expect(starNames.has(e.starName), `${e.id} starName ${e.starName}`).toBe(true);
      if (e.systemId !== undefined) expect(e.systemId).toBe('trappist-1');
      if (e.kind === 'exoplanet') expect(e.systemId ?? e.starName, e.id).toBeDefined();
    }
    for (const b of bodies) expect(covered.has(b.id), `no entry for ${b.name}`).toBe(true);
  });
});

describe('codex provenance rules', () => {
  const allItems = codex.entries.flatMap((e) => [
    ...e.facts.map((f) => ({ id: e.id, text: f.label, isFact: true, ...f })),
    ...e.howWeKnow.map((h) => ({ id: e.id, text: h.claim, isFact: false, ...h })),
  ]);

  it('never rests a Measured fact or claim on an unverified or non-peer-reviewed citation', () => {
    for (const item of allItems) {
      if (item.provenance !== 'measured') continue;
      const c = citations[item.citation];
      expect(c?.verified, `${item.id}: "${item.text}" cites unverified '${item.citation}'`).toBe(true);
      if (c) expect(notPeerReviewed(c), `${item.id}: "${item.text}" cites a preprint or note`).toBe(false);
    }
  });

  it('cites a Known Sky self-reference for Generated content and for facts about the game, and nowhere it may not', () => {
    for (const item of allItems) {
      const where = `${item.id}: "${item.text}" (${item.provenance}, ${item.citation})`;
      if (item.provenance === 'generated') expect(isSelf(item.citation), where).toBe(true);
      if (isSelf(item.citation)) expect(SELF_TIERS[item.citation], where).toContain(item.provenance);
      if (item.isFact && GAME_LABEL.test(item.text)) expect(isSelf(item.citation), where).toBe(true);
    }
  });

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
    const cites = (id: string): string[] => [...entry(id).facts, ...entry(id).howWeKnow].map((x) => x.citation);
    expect(cites('trappist-1b')).toContain('greene2023');
    expect(cites('trappist-1c')).toContain('zieba2023');
  });

  it('marks derived quantities (densities, distances in light-years, equilibrium and effective temperatures) as Inferred', () => {
    for (const e of codex.entries) {
      for (const f of e.facts) {
        if (
          /density|equilibrium temperature|effective temperature/i.test(f.label) ||
          (f.label === 'Distance' && f.unit === 'ly')
        ) {
          expect(f.provenance, `${e.id}: ${f.label}`).toBe('inferred');
        }
      }
    }
  });

  /**
   * Prose must not present an Inferred result as fact. Heuristic: for each topic that one of the entry's Inferred or
   * Generated items covers (and no Measured item does), every sentence of the summary and body that mentions the topic
   * must carry a hedge word.
   */
  it('hedges prose on topics the entry itself marks Inferred', () => {
    const topics: readonly RegExp[] = [
      /\boceans?\b/i,
      /\blakes?\b/i,
      /\bwater ice\b/i,
      /\btidal (heating|flexing|dissipation)\b|\bheated\b[^.]*\btides\b/i,
      /\bgreenhouse\b/i,
      /\bhabitable zone\b/i,
      /\bcaptur/i,
      /\bfusion\b/i,
      /\bgiant[- ]impact\b/i,
      /\breson(ant|ance)/i,
      /\bmigrat/i,
      /\bdust\b/i,
      /\btidally locked\b/i,
      /\bwarp\b/i,
    ];
    const hedge =
      /\b(thought|think|probabl\w*|likely|unlikely|may|might|could|suggest\w*|interpret\w*|appear\w*|inferred|models?|predict\w*|expect\w*|explain\w*|explanation|evidence|possibl\w*|estimat\w*|consistent|if|whether|unknowns?|not known|no known|speculati\w*|disfavou?r\w*|candidate|propos\w*|argu\w*|describes?)\b/i;
    const problems: string[] = [];
    for (const e of codex.entries) {
      const soft = [...e.facts, ...e.howWeKnow]
        .filter((i) => i.provenance !== 'measured')
        .map((i) => `${'claim' in i ? i.claim : i.label} ${i.method}`);
      const hard = [
        ...e.facts.map((f) => f.label),
        ...e.howWeKnow.filter((h) => h.provenance === 'measured').map((h) => h.claim),
      ];
      const watched = topics.filter((t) => soft.some((s) => t.test(s)) && !hard.some((s) => t.test(s)));
      for (const text of [e.summary, ...e.body]) {
        for (const sentence of text.split(/(?<=[.!?])\s+/)) {
          for (const t of watched) {
            if (t.test(sentence) && !hedge.test(sentence)) problems.push(`${e.id}: "${sentence}" (${String(t)})`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('codex numbers agree with the game data', () => {
  it('uses the same mean radii as bodies.json', () => {
    for (const b of bodies) {
      const e = codex.entries.find((x) => x.bodyId === b.id);
      const fact = e?.facts.find((f) => f.label === 'Mean radius');
      expect(fact, b.name).toBeDefined();
      if (!fact) continue;
      expect(isNumber(fact.value), `${b.name}: Mean radius must be a number`).toBe(true);
      const value = Number(fact.value);
      const gameKm = b.radiusM / 1000;
      const tol = Math.max(gameKm * 1e-3, isNumber(fact.uncertainty) ? fact.uncertainty : 0);
      expect(Math.abs(value - gameKm), b.name).toBeLessThanOrEqual(tol);
    }
  });

  it("states Saturn's ring edges as the game draws them", () => {
    const rings = bodyById.get('699')?.rings;
    expect(rings).toBeDefined();
    expect(numericFact('saturn', 'Main rings, inner edge of C ring')).toBe((rings?.innerM ?? 0) / 1000);
    expect(numericFact('saturn', 'Main rings, outer edge of A ring')).toBe((rings?.outerM ?? 0) / 1000);
  });

  it('converts parallaxes to light-years correctly', () => {
    for (const e of codex.entries) {
      const plx = e.facts.find((f) => /parallax/i.test(f.label) && f.unit === 'mas');
      const dist = e.facts.find((f) => f.label === 'Distance' && f.unit === 'ly');
      if (!plx || !dist || !isNumber(plx.value) || !isNumber(dist.value)) continue;
      const expected = parsecsToLightYears(1000 / plx.value);
      expect(relErr(dist.value, expected), e.id).toBeLessThan(0.002);
    }
  });

  it('matches the TRAPPIST-1 values used by the exoplanet pipeline', () => {
    for (const letter of ['b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const p = trappist.planets[letter];
      expect(p, letter).toBeDefined();
      if (!p) continue;
      const id = `trappist-1${letter}`;
      expect(numericFact(id, 'Radius'), id).toBe(p['radius_earth']?.value);
      expect(numericFact(id, 'Mass'), id).toBe(p['mass_earth']?.value);
      expect(numericFact(id, 'Orbital period'), id).toBe(p['period_days']?.value);
      expect(numericFact(id, 'Orbital distance (semi-major axis)'), id).toBe(p['semi_major_axis_au']?.value);
    }
  });

  it('states the light time for 1 au consistently with the constants', () => {
    expect(numericFact('concept-light-travel', 'Light time for 1 au')).toBeCloseTo(AU_M / SPEED_OF_LIGHT_M_PER_S, 5);
    expect(numericFact('concept-light-travel', 'Speed of light')).toBe(SPEED_OF_LIGHT_M_PER_S);
  });

  it('quotes the elevation grids the game ships', () => {
    const earth = readJson('public/data/heights/earth.json') as { width: number };
    const moon = readJson('public/data/heights/moon.json') as { width: number };
    expect(numericFact('earth', 'Elevation data spacing in the game')).toBe((360 * 60) / earth.width);
    expect(numericFact('moon', 'Elevation data in the game')).toBe(moon.width / 360);
    const km = (radiusKm: number, width: number): number => (2 * Math.PI * radiusKm) / width;
    expect(numericFact('concept-game-surfaces', 'Earth elevation spacing in the game')).toBeCloseTo(
      km(6371, earth.width),
      1,
    );
    expect(numericFact('concept-game-surfaces', 'Moon elevation spacing in the game')).toBeCloseTo(
      km(1737.4, moon.width),
      1,
    );
  });

  it('quotes the ephemeris window and fit errors in ephemeris.json', () => {
    const eph = readJson('public/data/ephemeris.json') as {
      window: [string, string];
      bodies: { name: string; maxHeldOutErrorMeters: number }[];
    };
    expect(factOf('concept-ephemerides', 'Game ephemeris window').value).toBe(
      `${eph.window[0].slice(0, 4)}-${eph.window[1].slice(0, 4)}`,
    );
    const moon = eph.bodies.find((b) => b.name === 'Moon');
    const worst = eph.bodies.reduce((a, b) => (b.maxHeldOutErrorMeters > a.maxHeldOutErrorMeters ? b : a));
    expect(
      relErr(numericFact('concept-ephemerides', 'Largest fit error, Moon'), moon?.maxHeldOutErrorMeters ?? NaN),
    ).toBeLessThan(0.01);
    expect(factOf('concept-ephemerides', `Largest fit error, any body (${worst.name})`).value).toBe(
      Math.round(worst.maxHeldOutErrorMeters),
    );
  });

  it('quotes the size and depth of the star catalogue the game ships', () => {
    const bin = readFileSync('public/data/stars.bin');
    const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const n = bin.byteLength / stars.stride;
    let maxPc = 0;
    for (let i = 0; i < n; i++) {
      const o = i * stars.stride;
      const x = view.getFloat32(o, true);
      const y = view.getFloat32(o + 4, true);
      const z = view.getFloat32(o + 8, true);
      maxPc = Math.max(maxPc, Math.hypot(x, y, z));
    }
    expect(n).toBe(stars.count);
    expect(numericFact('concept-star-catalogues', 'HYG stars in the game')).toBe(stars.count);
    expect(
      relErr(numericFact('concept-light-travel', "Farthest stars in the game's catalogue"), parsecsToLightYears(maxPc)),
    ).toBeLessThan(0.005);
  });

  it('quotes the star sizes inferStar gives for Proxima Centauri and Betelgeuse', () => {
    const named = Object.values(stars.named);
    const radius = (name: string): number => {
      const s = named.find((x) => x.name === name);
      if (!s) throw new Error(`${name} is not in stars.json`);
      return inferStar(s.absmag, s.bv).radiusM / SUN_RADIUS_M;
    };
    const proxima = radius('Proxima Centauri');
    const betelgeuse = radius('Betelgeuse');
    expect(
      relErr(numericFact('concept-star-brightness', "Game's size estimate for Proxima Centauri"), proxima),
    ).toBeLessThan(0.02);
    expect(
      relErr(numericFact('concept-star-brightness', "Game's size estimate for Betelgeuse"), betelgeuse),
    ).toBeLessThan(0.02);
    expect(
      relErr(numericFact('proxima-centauri', "Game's size estimate (from magnitude and colour)"), proxima),
    ).toBeLessThan(0.02);
    expect(
      relErr(numericFact('betelgeuse', "Game's size estimate (from magnitude and colour)"), betelgeuse),
    ).toBeLessThan(0.02);
    // The rounded figures in the prose.
    const proximaText = `${proxima.toFixed(2)} solar radii`;
    const betelgeuseText = `${Math.round(betelgeuse / 10) * 10} solar radii`;
    expect(entry('concept-star-brightness').body.join(' ')).toContain(proximaText);
    expect(entry('concept-star-brightness').body.join(' ')).toContain(betelgeuseText);
    expect(entry('proxima-centauri').body.join(' ')).toContain(proximaText);
    expect(entry('betelgeuse').body.join(' ')).toContain(betelgeuseText);
  });

  it('describes the jump duration and star magnitude limit the game code uses', () => {
    const hyper = /this\.duration\s*=\s*([\d.]+)\s*\+\s*([\d.]+)\s*\*\s*Math\.log10\(1 \+ ly\)/.exec(
      readText('src/game/ship/hyperspeed.ts'),
    );
    expect(hyper, 'jump duration formula in hyperspeed.ts').not.toBeNull();
    const a = Number(hyper?.[1]);
    const b = Number(hyper?.[2]);
    const duration = (ly: number): number => a + b * Math.log10(1 + ly);
    const farthestLy = numericFact('concept-light-travel', "Farthest stars in the game's catalogue");
    const range = /(\d+)-(\d+)/.exec(String(factOf('concept-drive-fiction', 'In-game jump duration').value));
    expect(Math.abs(duration(0.01) - Number(range?.[1]))).toBeLessThanOrEqual(2);
    expect(Math.abs(duration(farthestLy) - Number(range?.[2]))).toBeLessThanOrEqual(2);
    const proximaLy = 4.25;
    const timesC = (proximaLy * JULIAN_YEAR_S) / duration(proximaLy);
    const quoted = /([\d.]+) million/.exec(
      String(factOf('concept-drive-fiction', 'Implied in-game speed on a jump to Proxima').value),
    );
    const ratio = (Number(quoted?.[1]) * 1e6) / timesC;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);

    const mag = /magLimit\s*=\s*uniform\(([\d.]+)\)/.exec(readText('src/render/starfield.ts'));
    expect(numericFact('concept-star-brightness', 'Faintest stars drawn')).toBe(Number(mag?.[1]));
  });
});

describe('codex texts about the game match its texture pipeline', () => {
  const textures = readText('tools/pipeline/textures.py');
  const block = (start: string, end: string): string => {
    const i = textures.indexOf(start);
    return i < 0 ? '' : textures.slice(i, textures.indexOf(end, i));
  };
  const sss = new Set([...block('sss = {', '}').matchAll(/"(\w+)":\s*\(/g)].map((m) => m[1] ?? ''));
  const nasa3d = new Set([...block('nasa = {', '}').matchAll(/"(\w+)":/g)].map((m) => m[1] ?? ''));
  const usgs = new Set([...block('usgs = (', '))').matchAll(/\("(\w+)",\s*"[^"]+\.tif"/g)].map((m) => m[1] ?? ''));

  it('finds the texture sources in tools/pipeline/textures.py', () => {
    expect(sss.size).toBeGreaterThanOrEqual(7);
    expect(usgs.size).toBeGreaterThanOrEqual(10);
    expect(nasa3d.size).toBeGreaterThanOrEqual(1);
    expect(new Set(Object.keys(imagery.tex))).toEqual(usgs);
    expect(numericFact('concept-game-surfaces', 'Moon and dwarf-planet maps from USGS mosaics')).toBe(usgs.size);
  });

  it("names each body's real texture source in its 'In the game' paragraph", () => {
    for (const b of bodies) {
      const tex = b.surface?.texture;
      if (!tex) continue;
      const e = codex.entries.find((x) => x.bodyId === b.id);
      const para = e?.body.find((p) => /\bin the game\b|\bthe game's map\b/i.test(p)) ?? '';
      const where = `${b.name} (${tex}): ${para}`;
      expect(para, `${b.name} has no "In the game" paragraph`).not.toBe('');
      const cited = new Set([...(e?.facts ?? []), ...(e?.howWeKnow ?? [])].map((i) => i.citation));
      if (b.surface?.tiles === 'earth') {
        expect(para, where).toContain('Blue Marble');
      } else if (b.surface?.tiles === 'moon') {
        expect(para, where).toContain('Lunar Reconnaissance Orbiter');
      } else if (usgs.has(tex)) {
        expect(para, where).toContain('USGS');
        expect(para, where).not.toContain('3D Resources');
        expect(cited.has(`usgs-${tex}-mosaic`), `${b.name} should cite usgs-${tex}-mosaic`).toBe(true);
        const filled = (imagery.tex[tex]?.filledFraction ?? 0) * 100;
        if (filled >= 0.5) {
          expect(para, where).toContain('no image data');
          expect(
            Math.abs(numericFact(e?.id ?? '', 'Part of the in-game map with no image data') - filled),
          ).toBeLessThan(0.05);
        }
      } else if (sss.has(tex)) {
        expect(para, where).toContain('Solar System Scope');
      } else if (nasa3d.has(tex)) {
        expect(para, where).toContain('3D Resources');
        expect(para, where).toMatch(/not documented|undocumented/);
      } else {
        throw new Error(`texture ${tex} of ${b.name} has no known source in textures.py`);
      }
    }
  });

  it('mentions NASA 3D Resources only for the maps that still come from it', () => {
    const names = new Set([...nasa3d].map((k) => bodies.find((b) => b.surface?.texture === k)?.name ?? k));
    for (const e of codex.entries) {
      for (const p of e.body) {
        if (!p.includes('3D Resources')) continue;
        expect(
          [...names].some((n) => p.includes(n)),
          `${e.id}: ${p}`,
        ).toBe(true);
      }
    }
  });
});
