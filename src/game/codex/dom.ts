/**
 * Small DOM helpers for the Codex UI. Content from data files is only ever inserted as text nodes (never as HTML).
 */
import { t } from '../i18n';
import { citationHref, formatCitation } from './codexStore';
import { parseInline } from './format';
import type { CodexCitation } from './types';

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | null | undefined | false;

/** Creates an element; attributes with null/undefined/false values are skipped, true sets an empty attribute. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Visually hidden text for assistive technology. */
export function srOnly(text: string): HTMLSpanElement {
  return h('span', { class: 'ks-cx-sr' }, text);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icon paths on a 16 x 16 grid, stroked with currentColor unless the shape says otherwise. */
const ICONS = {
  body: '<circle cx="8" cy="8" r="5.2"/><path d="M4.2 11.6c2.6-1 5.6-3.4 7.4-7" opacity=".7"/>',
  star: '<path d="M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8 6.6 6.6Z"/>',
  exoplanet: '<ellipse cx="8" cy="8" rx="6.6" ry="2.6" opacity=".7"/><circle cx="8" cy="8" r="2.2"/><circle cx="13.4" cy="6.6" r="1" fill="currentColor" stroke="none"/>',
  concept: '<path d="M8 1.8 13.4 4.9v6.2L8 14.2 2.6 11.1V4.9Z"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/>',
  log: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/>',
  lock: '<rect x="3.2" y="7" width="9.6" height="6.8" rx="1.4"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>',
  search: '<circle cx="7" cy="7" r="4.4"/><path d="m10.4 10.4 3.6 3.6"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  external: '<path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v3.4a.6.6 0 0 1-.6.6H3.1a.6.6 0 0 1-.6-.6V5.1a.6.6 0 0 1 .6-.6h3.4"/>',
  back: '<path d="M10 3 5 8l5 5"/>',
  forward: '<path d="m6 3 5 5-5 5"/>',
  question: '<circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.5"/><circle cx="8" cy="11.6" r=".6" fill="currentColor" stroke="none"/>',
  codex: '<path d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8Z"/><path d="M8 1.6v12.8M2.4 4.8 13.6 11.2M13.6 4.8 2.4 11.2" opacity=".45"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>',
  warn: '<path d="M8 2.2 14.2 13H1.8Z"/><path d="M8 6.4v3"/><circle cx="8" cy="11.1" r=".6" fill="currentColor" stroke="none"/>',
} as const;
export type IconName = keyof typeof ICONS;

export function icon(name: IconName, cls = 'ks-cx-icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // Static markup from the table above (no data), parsed in the SVG namespace.
  const tmp = document.createElementNS(SVG_NS, 'g');
  tmp.innerHTML = ICONS[name];
  svg.append(...tmp.childNodes);
  return svg;
}

/** Paragraph text with **bold** spans rendered as <strong>. */
export function richText(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const s of parseInline(text)) frag.append(s.bold ? h('strong', {}, s.text) : document.createTextNode(s.text));
  return frag;
}

/** Focusable, visible elements inside root, in tab order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll<HTMLElement>(sel)].filter((el) => {
    if (el.tabIndex < 0 || el.closest('[hidden], [inert]')) return false;
    const r = el.getClientRects();
    return r.length > 0;
  });
}

/** Keeps Tab and Shift+Tab inside root. Returns true when it moved focus. */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  if (e.key !== 'Tab') return false;
  const items = focusables(root);
  if (items.length === 0) {
    e.preventDefault();
    return true;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && root.contains(active) && items.includes(active);
  if (e.shiftKey && (active === first || !inside)) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/** Moves focus to the next/previous focusable in root (gamepad and arrow navigation outside lists). */
export function moveFocus(root: HTMLElement, dir: 1 | -1): boolean {
  const items = focusables(root);
  if (items.length === 0) return false;
  const active = document.activeElement;
  const i = active instanceof HTMLElement ? items.indexOf(active) : -1;
  const next = i < 0 ? (dir > 0 ? items[0] : items[items.length - 1]) : items[i + dir];
  if (!next) return false;
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
  return true;
}

export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset['reducedMotion'] === 'true') return true;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** True while any modal <dialog> is open (its backdrop hides everything else). */
export function modalOpen(): boolean {
  try {
    return document.querySelector('dialog:modal') !== null;
  } catch {
    return document.querySelector('dialog[open][aria-modal="true"]') !== null;
  }
}

/** Opens a dialog modally, falling back to a non-modal show() where showModal is unavailable. */
export function showDialog(d: HTMLDialogElement): void {
  if (d.open) return;
  try {
    d.showModal();
  } catch {
    d.show();
  }
}

/** Citation as text with its DOI or URL as an external link; marks unverified and missing sources honestly. */
export function citationView(key: string, c: CodexCitation | undefined, opts: { accessed?: 'always' | 'web' | 'never' } = {}): HTMLElement {
  const wrap = h('span', { class: 'ks-cx-cite' });
  if (!key) {
    wrap.classList.add('is-missing');
    wrap.append(icon('warn'), t('codex.cite.none'));
    return wrap;
  }
  if (!c) {
    wrap.classList.add('is-missing');
    wrap.append(icon('warn'), t('codex.cite.missing', { key }));
    return wrap;
  }
  const text = formatCitation(c);
  const href = citationHref(c);
  const linkText = c.doi ? `doi:${c.doi}` : c.url.trim();
  if (href && linkText && text.endsWith(linkText)) {
    wrap.append(text.slice(0, text.length - linkText.length));
    // The icon is kept on one line with the last characters so it never wraps alone.
    const cut = Math.max(0, linkText.length - 5);
    wrap.append(
      h(
        'a',
        { class: 'ks-cx-link', href, target: '_blank', rel: 'noopener noreferrer' },
        linkText.slice(0, cut),
        h('span', { class: 'ks-cx-nowrap' }, linkText.slice(cut), icon('external', 'ks-cx-icon ks-cx-ext')),
        srOnly(` ${t('codex.cite.newTab')}`),
      ),
    );
  } else wrap.append(text);
  const accessed = opts.accessed ?? 'web';
  if (c.accessed && (accessed === 'always' || (accessed === 'web' && !c.doi))) wrap.append(' ', h('span', { class: 'ks-cx-accessed' }, t('codex.cite.accessed', { date: c.accessed })));
  if (c.license) wrap.append(' ', h('span', { class: 'ks-cx-accessed' }, t('codex.cite.license', { license: c.license })));
  if (!c.verified) {
    wrap.append(' ', h('span', { class: 'ks-cx-unverified', title: t('codex.cite.unverifiedTitle') }, t('codex.cite.unverified'), srOnly(`: ${t('codex.cite.unverifiedTitle')}`)));
  }
  return wrap;
}
