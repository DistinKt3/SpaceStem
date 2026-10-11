/**
 * Provenance badge: the visible sign of the Measured / Inferred / Generated layer.
 *
 * Shape-coded so colour is never the only cue (PRD section 5): Measured has a solid border and a filled disc,
 * Inferred a dashed border and a half-filled disc, Generated a dotted border and a hollow ring. The full badge always
 * shows its text label; the compact badge shows the glyph with the label as visually hidden text. Colours come from
 * the --ks-measured / --ks-inferred / --ks-generated tokens, which the colour-blind palettes override.
 */
import type { Provenance } from '../../core/provenance';
import { t } from '../i18n';
import './codex.css';

const SVG_NS = 'http://www.w3.org/2000/svg';

function glyph(p: Provenance): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('class', 'ks-badge-glyph');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', '6');
  ring.setAttribute('cy', '6');
  ring.setAttribute('r', '4.6');
  ring.setAttribute('fill', p === 'measured' ? 'currentColor' : 'none');
  ring.setAttribute('stroke', 'currentColor');
  ring.setAttribute('stroke-width', '1.4');
  svg.append(ring);
  if (p === 'inferred') {
    // Left half filled: known in part.
    const half = document.createElementNS(SVG_NS, 'path');
    half.setAttribute('d', 'M6 1.4a4.6 4.6 0 0 0 0 9.2Z');
    half.setAttribute('fill', 'currentColor');
    svg.append(half);
  }
  return svg;
}

/** Accessible description of a tier, e.g. "Measured: directly observed and catalogued". */
export function provenanceDescription(p: Provenance): string {
  return t(`codex.tier.${p}.aria`);
}

export function provenanceLabel(p: Provenance): string {
  return t(`codex.tier.${p}`);
}

export function provenanceBadge(p: Provenance, opts: { compact?: boolean } = {}): HTMLElement {
  const el = document.createElement('span');
  el.className = `ks-badge ks-badge--${p}${opts.compact ? ' ks-badge--compact' : ''}`;
  el.dataset['provenance'] = p;
  const description = provenanceDescription(p);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', description);
  el.title = description;
  const label = document.createElement('span');
  label.className = opts.compact ? 'ks-badge-label ks-badge-sr' : 'ks-badge-label';
  label.textContent = provenanceLabel(p);
  el.append(glyph(p), label);
  return el;
}
