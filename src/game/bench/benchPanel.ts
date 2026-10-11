/**
 * Benchmark UI: a progress card while the benchmark runs (a polite live region names each view as it starts) and a
 * modal results dialog: overall verdict, a table with one row per view (a p95 meter against the 60 and 30 fps budgets,
 * with the numbers in text), and Copy / Download JSON. Native <dialog>: Escape closes it and focus returns to where it
 * was. Every string goes through t(); verdicts carry an icon and a word, never colour alone.
 */
import './bench.css';
import { formatNumber, t } from '../i18n';
import type { BenchProgress, BenchReport, BenchVerdict, BenchViewResult } from './bench';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Meter scale: 0 .. 3 x the 60 fps budget (50 ms), so both budget lines sit inside it. */
const METER_MAX_MS = 50;

let uid = 0;

const FOCUSABLE = 'button:not([disabled]), [href], summary, [tabindex]';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Small line icons (stroke = currentColor); decorative, the adjacent text carries the meaning. */
function icon(kind: BenchVerdict | 'close' | 'copy' | 'download'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('ks-bench-ico');
  const paths: Record<typeof kind, string[]> = {
    smooth: ['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18Z', 'M7.8 12.4l2.8 2.8l5.6-6'],
    playable: ['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18Z', 'M7.5 12h9'],
    slow: ['M12 3.5L2.8 19.5h18.4Z', 'M12 9.5v4.6', 'M12 16.9v.2'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    copy: ['M9 9h10v11H9Z', 'M5 15V4h10'],
    download: ['M12 4v11', 'M7.5 10.5L12 15l4.5-4.5', 'M5 19.5h14'],
  };
  for (const d of paths[kind]) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

const ms = (v: number): string => t('quality.bench.ms', { v: formatNumber(v, 1, 1) });

function count(v: number): string {
  if (v >= 1e6) return t('quality.bench.millions', { v: formatNumber(v / 1e6, 2, 2) });
  if (v >= 1e4) return t('quality.bench.thousands', { v: formatNumber(v / 1e3, 0) });
  if (v >= 1e3) return t('quality.bench.thousands', { v: formatNumber(v / 1e3, 1, 1) });
  return formatNumber(v);
}

function duration(msTotal: number): string {
  return t('quality.bench.seconds', { v: formatNumber(msTotal / 1000, 0) });
}

/** Localised view name, or the raw name for views without a message. */
export function viewLabel(view: string): string {
  const key = `quality.view.${view}`;
  const s = t(key);
  return s === key ? view : s;
}

function backendLabel(backend: string): string {
  const key = `quality.bench.backend.${backend}`;
  const s = t(key);
  return s === key ? backend : s;
}

export class BenchPanel {
  readonly root: HTMLDialogElement;
  /** Called after the results dialog closes (Close button, Escape, or close()). */
  onClose: (() => void) | null = null;
  private readonly progressCard: HTMLElement;
  private readonly progressView: HTMLElement;
  private readonly progressPhase: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly status: HTMLElement;
  private readonly content: HTMLElement;
  private report: BenchReport | null = null;
  private lastAnnounced = -1;
  private readonly id = ++uid;
  private readonly resizeObserver: ResizeObserver | null;

  constructor(readonly parent: HTMLElement) {
    // Progress card (non-modal; the game keeps rendering behind it).
    this.progressCard = el('section', 'ks-bench-progress');
    this.progressCard.hidden = true;
    this.progressCard.setAttribute('aria-labelledby', `ks-bench-run-${this.id}`);
    const eyebrow = el('p', 'ks-bench-eyebrow', t('quality.bench.running'));
    eyebrow.id = `ks-bench-run-${this.id}`;
    this.progressView = el('p', 'ks-bench-progress-view');
    this.progressView.setAttribute('role', 'status');
    this.progressView.setAttribute('aria-live', 'polite');
    this.progressPhase = el('p', 'ks-bench-progress-phase');
    this.progressBar = el('div', 'ks-bench-progress-bar');
    this.progressBar.setAttribute('role', 'progressbar');
    this.progressBar.setAttribute('aria-label', t('quality.bench.progressLabel'));
    this.progressBar.setAttribute('aria-valuemin', '0');
    this.progressBar.setAttribute('aria-valuemax', '100');
    this.progressBar.setAttribute('aria-valuenow', '0');
    this.progressFill = el('span', 'ks-bench-progress-fill');
    this.progressBar.appendChild(this.progressFill);
    this.progressCard.append(eyebrow, this.progressView, this.progressPhase, this.progressBar);

    // Results dialog.
    this.root = el('dialog', 'ks-bench');
    this.root.setAttribute('aria-labelledby', `ks-bench-title-${this.id}`);
    this.root.setAttribute('aria-describedby', `ks-bench-verdict-${this.id}`);
    this.content = el('div', 'ks-bench-frame');
    this.status = el('p', 'ks-bench-status');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.root.appendChild(this.content);
    this.root.addEventListener('close', () => {
      this.onClose?.();
    });
    // A click on the backdrop (outside the frame) closes the dialog, as Escape does.
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    // Pinned actions are convenient until they would cover too much of a short dialog (large text, small window).
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.fitActions()) : null;
    this.resizeObserver?.observe(this.content);
    parent.append(this.progressCard, this.root);
  }

  get isOpen(): boolean {
    return this.root.open;
  }

  /** Shows the progress card; the live region announces each new view once. */
  progress(p: BenchProgress): void {
    this.progressCard.hidden = false;
    const view = t('quality.bench.progressView', { view: viewLabel(p.view), n: p.index + 1, total: p.total });
    if (p.index !== this.lastAnnounced) {
      this.lastAnnounced = p.index;
      this.progressView.textContent = view;
    }
    this.progressPhase.textContent = t(`quality.bench.phase.${p.phase}`);
    // Each view is an equal share; within a view, loading takes the first 10%, warm-up the next 10%, measuring 80%.
    const done = p.frames ? p.frame / p.frames : 1;
    const within = p.phase === 'loading' ? 0 : p.phase === 'warmup' ? 0.1 + 0.1 * done : 0.2 + 0.8 * done;
    const pct = Math.round(((p.index + within) / Math.max(1, p.total)) * 100);
    this.progressBar.setAttribute('aria-valuenow', String(pct));
    this.progressFill.style.width = `${pct}%`;
  }

  hideProgress(): void {
    this.progressCard.hidden = true;
    this.lastAnnounced = -1;
  }

  /** Renders the report and opens the dialog (modal when the browser supports it). */
  show(report: BenchReport): void {
    this.report = report;
    this.hideProgress();
    this.render(report);
    if (!this.root.open) {
      if (typeof this.root.showModal === 'function') this.root.showModal();
      else this.root.setAttribute('open', '');
    }
    this.fitActions();
    // Start at the title so screen readers read the dialog from the top (the table can be long).
    this.content.querySelector<HTMLElement>('.ks-bench-title')?.focus();
  }

  /** Unpins the action bar when it would take more than a fifth of the dialog's height. */
  private fitActions(): void {
    const foot = this.content.querySelector<HTMLElement>('.ks-bench-actions');
    if (!foot || !this.root.open) return;
    this.content.classList.toggle('is-tight', foot.offsetHeight > this.content.clientHeight * 0.2);
  }

  close(): void {
    if (!this.root.open) return;
    if (typeof this.root.close === 'function') this.root.close();
    else {
      this.root.removeAttribute('open');
      this.onClose?.();
    }
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.close();
    this.root.remove();
    this.progressCard.remove();
  }

  private render(r: BenchReport): void {
    const c = this.content;
    c.replaceChildren();
    c.dataset['verdict'] = r.overall.verdict;

    // Header.
    const head = el('header', 'ks-bench-head');
    const titles = el('div', 'ks-bench-titles');
    titles.appendChild(el('p', 'ks-bench-eyebrow', t('quality.bench.eyebrow')));
    const h = el('h2', 'ks-bench-title', t('quality.bench.title'));
    h.id = `ks-bench-title-${this.id}`;
    h.tabIndex = -1;
    titles.appendChild(h);
    const i = r.info;
    titles.appendChild(
      el(
        'p',
        'ks-bench-device',
        t('quality.bench.device', { backend: backendLabel(i.backend), adapter: i.adapter || '—', width: Math.round(i.width), height: Math.round(i.height), dpr: formatNumber(i.dpr, 2) }),
      ),
    );
    const meta = el('p', 'ks-bench-meta');
    meta.append(
      el('span', '', r.quality ? t('quality.bench.measuredAt', { level: t(`quality.level.${r.quality}`) }) : t('quality.bench.levelUnknown')),
      el('span', '', t('quality.bench.run', { frames: r.framesPerView, warmup: r.warmup, duration: duration(r.durationMs) })),
    );
    titles.appendChild(meta);
    const close = el('button', 'ks-bench-btn ks-bench-close');
    close.type = 'button';
    close.setAttribute('aria-label', t('quality.bench.close'));
    close.title = t('quality.bench.close');
    close.appendChild(icon('close'));
    close.addEventListener('click', () => this.close());
    head.append(titles, close);
    c.appendChild(head);

    const body = el('div', 'ks-bench-body');
    if (r.synthetic) {
      const s = el('p', 'ks-bench-synthetic');
      s.append(el('strong', 'ks-bench-synthetic-tag', t('quality.bench.synthetic')), el('span', '', t('quality.bench.syntheticNote')));
      body.appendChild(s);
    }

    // Summary: verdict with icon and word, three figures.
    const worst = r.views.find((v) => v.view === r.overall.worstView);
    const summary = el('section', 'ks-bench-summary');
    const verdict = el('div', 'ks-bench-verdict');
    verdict.dataset['verdict'] = r.overall.verdict;
    verdict.id = `ks-bench-verdict-${this.id}`;
    verdict.append(this.badge(r.overall.verdict, 'ks-bench-badge-lg'));
    verdict.appendChild(
      el('p', 'ks-bench-verdict-desc', t(`quality.bench.verdict.${r.overall.verdict}.desc`, { view: viewLabel(r.overall.worstView), ms: ms(worst?.p95Ms ?? r.overall.p95Ms) })),
    );
    const stats = el('dl', 'ks-bench-stats');
    const stat = (label: string, value: string, cls = ''): void => {
      const d = el('div', `ks-bench-stat ${cls}`.trim());
      d.append(el('dt', '', label), el('dd', '', value));
      stats.appendChild(d);
    };
    stat(t('quality.bench.stat.p50'), ms(r.overall.p50Ms));
    stat(t('quality.bench.stat.p95'), ms(r.overall.p95Ms));
    stat(t('quality.bench.stat.suggested'), t(`quality.level.${r.overall.suggestedPreset}`), 'is-accent');
    summary.append(verdict, stats);
    body.appendChild(summary);

    // Per-view table in a keyboard-scrollable region.
    const wrap = el('div', 'ks-bench-tablewrap');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-labelledby', `ks-bench-caption-${this.id}`);
    const table = el('table', 'ks-bench-table');
    // Explicit roles keep table semantics when narrow layouts restyle rows as cards (display: block/flex).
    table.setAttribute('role', 'table');
    const caption = el('caption', '', t('quality.bench.caption', { smooth: ms(r.overall.budgets.smoothMs), playable: ms(r.overall.budgets.playableMs) }));
    caption.id = `ks-bench-caption-${this.id}`;
    table.appendChild(caption);
    const thead = el('thead');
    const hr = el('tr');
    const cols: [string, string][] = [
      ['quality.bench.col.view', 'is-view'],
      ['quality.bench.col.p95', 'is-meter'],
      ['quality.bench.col.p50', 'is-num'],
      ['quality.bench.col.max', 'is-num'],
      ['quality.bench.col.drawCalls', 'is-num'],
      ['quality.bench.col.triangles', 'is-num'],
      ['quality.bench.col.result', 'is-result'],
    ];
    hr.setAttribute('role', 'row');
    for (const [key, cls] of cols) {
      const th = el('th', cls, t(key));
      th.scope = 'col';
      th.setAttribute('role', 'columnheader');
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    thead.setAttribute('role', 'rowgroup');
    const tbody = el('tbody');
    tbody.setAttribute('role', 'rowgroup');
    for (const v of r.views) tbody.appendChild(this.row(v, r));
    table.append(thead, tbody);
    wrap.appendChild(table);
    body.appendChild(wrap);
    body.appendChild(el('p', 'ks-bench-foot', t('quality.bench.note')));
    if (!r.synthetic) body.appendChild(el('p', 'ks-bench-foot', t('quality.bench.definition')));

    // Raw JSON for manual copying.
    const raw = el('details', 'ks-bench-raw');
    raw.appendChild(el('summary', '', t('quality.bench.raw')));
    const pre = el('pre', 'ks-bench-json', JSON.stringify(r, null, 2));
    pre.tabIndex = 0;
    raw.appendChild(pre);
    body.appendChild(raw);
    c.appendChild(body);

    // Actions.
    const foot = el('footer', 'ks-bench-actions');
    const copy = el('button', 'ks-bench-btn ks-bench-primary');
    copy.type = 'button';
    copy.append(icon('copy'), el('span', '', t('quality.bench.copy')));
    copy.addEventListener('click', () => void this.copy());
    const download = el('button', 'ks-bench-btn');
    download.type = 'button';
    download.append(icon('download'), el('span', '', t('quality.bench.download')));
    download.addEventListener('click', () => this.download());
    const closeText = el('button', 'ks-bench-btn ks-bench-close-text', t('quality.bench.close'));
    closeText.type = 'button';
    closeText.addEventListener('click', () => this.close());
    this.status.textContent = '';
    foot.append(copy, download, closeText, this.status);
    c.appendChild(foot);
  }

  /** Focus trap (Tab wraps inside the dialog, as in the settings dialog) and Escape kept away from the game. */
  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...this.root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.tabIndex >= 0 && x.getClientRects().length > 0);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    const inside = active instanceof Node && this.root.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  }

  private badge(v: BenchVerdict, extra = ''): HTMLElement {
    const b = el('span', `ks-bench-badge ${extra}`.trim());
    b.dataset['verdict'] = v;
    b.append(icon(v), el('span', '', t(`quality.bench.verdict.${v}`)));
    return b;
  }

  private row(v: BenchViewResult, r: BenchReport): HTMLTableRowElement {
    const tr = el('tr');
    tr.setAttribute('role', 'row');
    tr.dataset['view'] = v.view;
    tr.dataset['verdict'] = v.verdict;
    const th = el('th', 'is-view', viewLabel(v.view));
    th.scope = 'row';
    th.setAttribute('role', 'rowheader');
    tr.appendChild(th);
    const cell = (cls: string, labelKey: string, text?: string): HTMLTableCellElement => {
      const td = el('td', cls, text);
      td.setAttribute('role', 'cell');
      td.dataset['label'] = t(labelKey);
      return td;
    };

    const meter = cell('is-meter', 'quality.bench.col.p95');
    const box = el('div', 'ks-bench-meter');
    const track = el('span', 'ks-bench-meter-track');
    track.setAttribute('aria-hidden', 'true');
    const fill = el('span', 'ks-bench-meter-fill');
    fill.dataset['verdict'] = v.verdict;
    fill.style.width = `${Math.min(100, (v.p95Ms / METER_MAX_MS) * 100).toFixed(1)}%`;
    if (v.p95Ms > METER_MAX_MS) fill.classList.add('is-clipped');
    const tick = (at: number, cls: string): HTMLElement => {
      const k = el('span', `ks-bench-meter-tick ${cls}`);
      k.style.left = `${((at / METER_MAX_MS) * 100).toFixed(2)}%`;
      return k;
    };
    track.append(fill, tick(r.overall.budgets.smoothMs, 'is-60'), tick(r.overall.budgets.playableMs, 'is-30'));
    box.append(track, el('span', 'ks-bench-meter-value', ms(v.p95Ms)));
    meter.appendChild(box);
    tr.appendChild(meter);

    tr.appendChild(cell('is-num', 'quality.bench.col.p50', ms(v.p50Ms)));
    tr.appendChild(cell('is-num', 'quality.bench.col.max', ms(v.maxMs)));
    const dc = cell('is-num', 'quality.bench.col.drawCalls', formatNumber(v.meanDrawCalls));
    const tri = cell('is-num', 'quality.bench.col.triangles', count(v.meanTriangles));
    for (const [td, key, budget] of [
      [dc, 'drawCalls', formatNumber(r.overall.budgets.drawCalls)],
      [tri, 'triangles', count(r.overall.budgets.triangles)],
    ] as const) {
      if (!v.overBudget.includes(key)) continue;
      td.classList.add('is-over');
      const note = el('span', 'ks-bench-over');
      note.append(icon('slow'), el('span', '', t('quality.bench.overBudget', { budget })));
      td.append(' ', note);
    }
    tr.append(dc, tri);
    const res = el('td', 'is-result');
    res.setAttribute('role', 'cell');
    res.appendChild(this.badge(v.verdict));
    tr.appendChild(res);
    return tr;
  }

  private json(): string {
    return this.report ? JSON.stringify(this.report, null, 2) : '';
  }

  private async copy(): Promise<void> {
    const text = this.json();
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = this.legacyCopy(text);
    this.say(ok ? t('quality.bench.copied') : t('quality.bench.copyFailed'));
    if (!ok) {
      const raw = this.content.querySelector('details');
      if (raw) raw.open = true;
    }
  }

  /** Clipboard fallback for browsers without the async API (or without permission). */
  private legacyCopy(text: string): boolean {
    try {
      const ta = el('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'ks-bench-offscreen';
      this.root.appendChild(ta);
      ta.select();
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only synchronous fallback
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  private download(): void {
    if (!this.report) return;
    const stamp = this.report.createdAt.replace(/[:]/g, '-').replace(/\.\d+Z$/, 'Z');
    const file = `known-sky-bench-${stamp}.json`;
    const url = URL.createObjectURL(new Blob([this.json()], { type: 'application/json' }));
    const a = el('a');
    a.href = url;
    a.download = file;
    a.className = 'ks-bench-offscreen';
    this.root.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.say(t('quality.bench.downloaded', { file }));
  }

  private say(msg: string): void {
    // Clear first so repeating the same message is announced again.
    this.status.textContent = '';
    setTimeout(() => (this.status.textContent = msg), 60);
  }
}
