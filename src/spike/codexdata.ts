/**
 * Codex content review page (codexdata.html): browses public/data/codex/en.json with every fact's provenance, method
 * and resolved citation from public/data/citations.json. It is a review tool for the Codex data, not the in-game Codex
 * UI. Exposes window.__ks for tests/e2e/codexdata.spec.ts.
 *
 * URL parameters: id=<entry id> opens an entry, kind=<body|star|exoplanet|concept> filters the list.
 */
import '../game/styles.css';
import './codexdata.css';
import { formatNumber, t } from '../game/i18n';
import { fetchJson } from '../data/assets';
import type { Provenance } from '../core/provenance';

type Kind = 'body' | 'star' | 'exoplanet' | 'concept';
type Unlock = 'start' | 'visit' | 'scan';

interface Fact {
  label: string;
  value: string | number;
  unit?: string;
  uncertainty?: string | number;
  provenance: Provenance;
  method: string;
  citation: string;
}

interface Claim {
  claim: string;
  method: string;
  provenance: Provenance;
  citation: string;
}

interface Entry {
  id: string;
  title: string;
  kind: Kind;
  unlock: Unlock;
  summary: string;
  body: string[];
  facts: Fact[];
  howWeKnow: Claim[];
  related: string[];
}

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

const KINDS: readonly Kind[] = ['body', 'star', 'exoplanet', 'concept'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Plain text with **bold** spans, built with DOM nodes (no innerHTML). */
function richText(parent: HTMLElement, text: string): void {
  const parts = text.split('**');
  parts.forEach((part, i) => {
    if (!part) return;
    parent.append(i % 2 === 1 ? el('strong', '', part) : document.createTextNode(part));
  });
}

/** Digits after the decimal point in the shortest exact form of v (6e-7 has 7; 1518.6 has 1). */
function decimalsOf(v: number): number {
  if (!Number.isFinite(v) || v === 0) return 0;
  const [mant = '', exp = '0'] = Math.abs(v).toExponential().split('e');
  return Math.max(0, (mant.split('.')[1] ?? '').length - Number(exp));
}

/** Significant digits after the point of the mantissa of v in scientific notation (7.087e-4 has 3). */
const mantissaDecimals = (v: number): number => (Math.abs(v).toExponential().split('e')[0]?.split('.')[1] ?? '').length;

const superscript = (n: number): string =>
  String(n)
    .split('')
    .map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹⁻'['0123456789-'.indexOf(c)] ?? c)
    .join('');

/** Decimals a string uncertainty such as "+0.014/-0.012" is quoted with. */
const stringDecimals = (u: string): number =>
  Math.max(0, ...(u.match(/\d+\.(\d+)/g) ?? []).map((m) => (m.split('.')[1] ?? '').length));

function formatStringUncertainty(u: string): string {
  if (/^[+-]/.test(u)) return u.replace('/', ' / ').replace(/-(?=\d)/g, '−');
  return `± ${u}`;
}

/**
 * A number with its uncertainty, keeping the precision of the data. Very large or small values use ×10ⁿ, and a numeric
 * uncertainty then shares the exponent: (7.087 ± 0.006) × 10⁻⁴. The uncertainty is returned separately so the page can
 * style it.
 */
function valueParts(v: number, u?: string | number): { lead: string; unc: string; tail: string } {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e7 || a < 1e-3)) {
    const exp = Math.floor(Math.log10(a));
    const scale = 10 ** exp;
    const tail = ` × 10${superscript(exp)}`;
    if (typeof u === 'number') {
      const uDec = Math.max(0, decimalsOf(u) + exp);
      const mDec = Math.max(mantissaDecimals(v), uDec);
      const mant = formatNumber(v / scale, mDec, mDec);
      return { lead: `(${mant} `, unc: `± ${formatNumber(u / scale, uDec, uDec)}`, tail: `)${tail}` };
    }
    const mDec = mantissaDecimals(v);
    return {
      lead: `${formatNumber(v / scale, mDec, mDec)}${tail}`,
      unc: u === undefined ? '' : formatStringUncertainty(u),
      tail: '',
    };
  }
  const uDec = u === undefined ? 0 : typeof u === 'number' ? decimalsOf(u) : stringDecimals(u);
  const decimals = Math.max(decimalsOf(v), uDec);
  const unc =
    u === undefined ? '' : typeof u === 'number' ? `± ${formatNumber(u, uDec, uDec)}` : formatStringUncertainty(u);
  return { lead: formatNumber(v, decimals, decimals), unc, tail: '' };
}

function provBadge(p: Provenance): HTMLElement {
  return el('span', `cx-prov cx-prov-${p}`, t(`prov.${p}`));
}

class CodexReview {
  private readonly byId: Map<string, Entry>;
  private kind: Kind | 'all';
  private query = '';
  private selected: Entry | undefined;
  private readonly listEl = el('nav', 'cx-list cx-glass');
  private readonly detailEl = el('article', 'cx-detail cx-glass');
  private readonly chips = new Map<Kind | 'all', HTMLButtonElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly entries: Entry[],
    private readonly citations: Record<string, Citation>,
  ) {
    this.byId = new Map(entries.map((e) => [e.id, e]));
    const params = new URLSearchParams(location.search);
    const k = params.get('kind');
    this.kind = KINDS.find((x) => x === k) ?? 'all';
    this.selected = this.byId.get(params.get('id') ?? '') ?? this.visible()[0];
  }

  mount(): void {
    this.root.replaceChildren(this.header(), this.main());
    this.renderList();
    this.renderDetail();
    this.revealSelected();
  }

  /** Scrolls the list (only the list) so the selected entry is visible. */
  private revealSelected(): void {
    const item = this.listEl.querySelector<HTMLElement>('.cx-item[aria-current="true"]');
    if (!item) return;
    const list = this.listEl.getBoundingClientRect();
    const box = item.getBoundingClientRect();
    if (box.top < list.top) this.listEl.scrollTop += box.top - list.top - 8;
    else if (box.bottom > list.bottom) this.listEl.scrollTop += box.bottom - list.bottom + 8;
  }

  /** Counts for the header and for tests. */
  stats(): { entries: number; facts: number; measured: number; inferred: number; generated: number } {
    const facts = this.entries.flatMap((e) => e.facts);
    const n = (p: Provenance): number => facts.filter((f) => f.provenance === p).length;
    return {
      entries: this.entries.length,
      facts: facts.length,
      measured: n('measured'),
      inferred: n('inferred'),
      generated: n('generated'),
    };
  }

  select(id: string): void {
    const e = this.byId.get(id);
    if (!e) return;
    this.selected = e;
    this.renderList();
    this.renderDetail();
    this.detailEl.scrollTop = 0;
    this.revealSelected();
  }

  selectedId(): string | undefined {
    return this.selected?.id;
  }

  private visible(): Entry[] {
    const q = this.query.trim().toLowerCase();
    return this.entries.filter(
      (e) =>
        (this.kind === 'all' || e.kind === this.kind) &&
        (!q || e.title.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q)),
    );
  }

  private header(): HTMLElement {
    const head = el('header', 'cx-head cx-glass');
    const brand = el('div', 'cx-brand');
    brand.append(el('h1', '', t('codexdata.title')), el('p', '', t('codexdata.subtitle')));
    const s = this.stats();
    const cites = Object.values(this.citations);
    const stats = el('div', 'cx-stats');
    stats.append(
      el('span', 'cx-stat', t('codexdata.count.entries', { n: s.entries })),
      el('span', 'cx-stat', t('codexdata.count.facts', { n: s.facts })),
    );
    for (const p of ['measured', 'inferred', 'generated'] as const) {
      const chip = el('span', 'cx-stat');
      chip.append(provBadge(p), document.createTextNode(` ${formatNumber(s[p])}`));
      stats.append(chip);
    }
    stats.append(
      el(
        'span',
        'cx-stat',
        t('codexdata.count.citations', { verified: cites.filter((c) => c.verified).length, total: cites.length }),
      ),
    );
    const tools = el('div', 'cx-tools');
    const search = el('input', 'cx-search');
    search.type = 'search';
    search.placeholder = t('codexdata.search');
    search.setAttribute('aria-label', t('codexdata.search'));
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderList();
    });
    tools.append(search);
    for (const k of ['all', ...KINDS] as const) {
      const b = el('button', 'cx-chip', t(`codexdata.kind.${k}`));
      b.type = 'button';
      b.dataset['kind'] = k;
      b.addEventListener('click', () => {
        this.kind = k;
        this.renderList();
      });
      this.chips.set(k, b);
      tools.append(b);
    }
    tools.append(el('span', 'cx-legend', t('codexdata.legend')));
    head.append(brand, stats, tools);
    return head;
  }

  private main(): HTMLElement {
    const main = el('div', 'cx-main');
    this.listEl.setAttribute('aria-label', t('codexdata.title'));
    main.append(this.listEl, this.detailEl);
    return main;
  }

  private renderList(): void {
    for (const [k, b] of this.chips) b.setAttribute('aria-pressed', String(k === this.kind));
    const items = this.visible();
    this.listEl.replaceChildren();
    if (!items.length) {
      this.listEl.append(el('div', 'cx-empty', t('codexdata.empty')));
      return;
    }
    for (const kind of KINDS) {
      const group = items.filter((e) => e.kind === kind);
      if (!group.length) continue;
      this.listEl.append(el('div', 'cx-group', t(`codexdata.kind.${kind}`)));
      for (const e of group) {
        const b = el('button', 'cx-item', e.title);
        b.type = 'button';
        b.dataset['id'] = e.id;
        if (e.id === this.selected?.id) b.setAttribute('aria-current', 'true');
        b.addEventListener('click', () => this.select(e.id));
        this.listEl.append(b);
      }
    }
  }

  private renderDetail(): void {
    const e = this.selected;
    this.detailEl.replaceChildren();
    if (!e) return;
    this.detailEl.dataset['id'] = e.id;
    const order: string[] = [];
    const refIndex = (key: string): number => {
      let i = order.indexOf(key);
      if (i < 0) i = order.push(key) - 1;
      return i + 1;
    };
    const refLink = (key: string): HTMLElement => {
      if (!(key in this.citations)) return el('span', 'cx-ref unresolved', t('codexdata.unknownCitation', { key }));
      const a = el('a', 'cx-ref', `[${refIndex(key)}]`);
      a.href = `#src-${key}`;
      a.title = key;
      return a;
    };

    const kicker = el('div', 'cx-kicker');
    kicker.append(el('span', '', t(`codexdata.kind.${e.kind}`)), el('span', '', t(`codexdata.unlock.${e.unlock}`)));
    const body = el('div', 'cx-body');
    for (const p of e.body) {
      const para = el('p');
      richText(para, p);
      body.append(para);
    }
    const summary = el('p', 'cx-summary');
    richText(summary, e.summary);
    this.detailEl.append(kicker, el('h2', '', e.title), summary, body);

    this.detailEl.append(el('h3', '', t('codexdata.facts')));
    const table = el('table', 'cx-facts');
    for (const f of e.facts) {
      const tr = el('tr', 'cx-fact');
      const label = el('td', '', f.label);
      const value = el('td');
      const v = el('span', 'cx-val');
      if (typeof f.value === 'number') {
        const parts = valueParts(f.value, f.uncertainty);
        v.append(document.createTextNode(parts.lead));
        if (parts.unc) {
          if (!parts.lead.endsWith(' ')) v.append(document.createTextNode(' '));
          v.append(el('span', 'cx-unc', parts.unc));
        }
        v.append(document.createTextNode(parts.tail));
      } else {
        v.append(document.createTextNode(f.value));
        if (f.uncertainty !== undefined) {
          const unc =
            typeof f.uncertainty === 'number'
              ? valueParts(0, f.uncertainty).unc
              : formatStringUncertainty(f.uncertainty);
          v.append(document.createTextNode(' '), el('span', 'cx-unc', unc));
        }
      }
      if (f.unit) v.append(document.createTextNode(` ${f.unit}`));
      value.append(v, el('span', 'cx-method', f.method));
      const prov = el('td');
      prov.append(provBadge(f.provenance), refLink(f.citation));
      tr.append(label, value, prov);
      table.append(tr);
    }
    this.detailEl.append(table);

    this.detailEl.append(el('h3', '', t('codexdata.howWeKnow')));
    const how = el('ul', 'cx-how');
    for (const h of e.howWeKnow) {
      const li = el('li', 'cx-claim');
      const badge = el('div');
      badge.append(provBadge(h.provenance));
      const text = el('div', '', h.claim);
      text.append(refLink(h.citation), el('span', 'cx-method', h.method));
      li.append(badge, text);
      how.append(li);
    }
    this.detailEl.append(how);

    if (e.related.length) {
      this.detailEl.append(el('h3', '', t('codexdata.related')));
      const rel = el('div', 'cx-related');
      for (const id of e.related) {
        const target = this.byId.get(id);
        const b = el('button', 'cx-chip', target?.title ?? id);
        b.type = 'button';
        b.addEventListener('click', () => this.select(id));
        rel.append(b);
      }
      this.detailEl.append(rel);
    }

    this.detailEl.append(el('h3', '', t('codexdata.sources')));
    const list = el('ol', 'cx-sources');
    for (const key of order) {
      const c = this.citations[key];
      if (!c) continue;
      const li = el('li');
      li.id = `src-${key}`;
      const year = c.year === null ? t('codexdata.noDate') : String(c.year);
      li.append(document.createTextNode(`${c.authors} (${year}). `), el('span', 'cx-src-title', c.title));
      li.append(document.createTextNode(`. ${c.venue}. `));
      const a = el('a', '', c.doi ? t('codexdata.doi', { doi: c.doi }) : c.url);
      a.href = c.doi ? `https://doi.org/${c.doi}` : c.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      li.append(a);
      li.append(
        el(
          'span',
          `cx-flag ${c.verified ? 'ok' : 'no'}`,
          c.verified ? t('codexdata.verified', { date: c.accessed }) : t('codexdata.unverified'),
        ),
      );
      if (c.license) li.append(el('span', 'cx-note', t('codexdata.license', { license: c.license })));
      if (c.note) li.append(el('span', 'cx-note', c.note));
      list.append(li);
    }
    this.detailEl.append(list);
  }
}

async function boot(): Promise<void> {
  document.title = t('codexdata.pageTitle');
  const root = document.getElementById('cx-root');
  if (!root) return;
  const status = el('div', 'cx-status', t('codexdata.loading'));
  document.body.append(status);
  try {
    const [codex, citations] = await Promise.all([
      fetchJson<{ version: number; entries: Entry[] }>('codex/en.json'),
      fetchJson<Record<string, Citation>>('citations.json'),
    ]);
    const app = new CodexReview(root, codex.entries, citations);
    app.mount();
    status.remove();
    (window as unknown as { __ks: unknown }).__ks = {
      ready: true,
      stats: () => app.stats(),
      select: (id: string) => {
        app.select(id);
      },
      selectedId: () => app.selectedId(),
    };
  } catch (err) {
    status.textContent = t('codexdata.error', { msg: err instanceof Error ? err.message : String(err) });
  }
}

void boot();
