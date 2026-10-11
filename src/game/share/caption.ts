/**
 * The screenshot caption: its text (place, UTC time, data credits) and its drawing on a 2D canvas at the image's
 * native resolution. The same drawCaption() paints the live preview in screenshot mode, so what the player sees is
 * what the image gets.
 *
 * Honesty: the title and subtitle state real, computed quantities (distance, altitude, light-travel time, UTC). The
 * credits line names the data sources and says that some surface detail is Generated; the wordmark carries the
 * game's tagline, which labels the drive as fiction (PRD Section 2, "the universe is real, the drive is fiction").
 */
import { LIGHT_YEAR_M, SPEED_OF_LIGHT_M_PER_S } from '../../core/constants';
import { formatDistance, formatDuration } from '../format';
import { t } from '../i18n';

export interface CaptionText {
  /** Where: e.g. "Moon · 60 m above the surface". */
  title: string;
  /** When (UTC) and context: e.g. "2026-10-11 14:03:12 UTC · Sun 1.00 au · light time 8 min 19 s". */
  subtitle: string;
  /** Data credits (short licence names). */
  credits: string;
}

export interface CaptionInput {
  /** Display name of the nearest body or star. */
  nearName: string;
  nearIsStar: boolean;
  /** Height above the nearest body's surface (m; for a star, above its photosphere). */
  altitudeM: number;
  landed?: boolean;
  /** The system's star (the Sun, or a visited star) and the distance to its centre (m). */
  starName: string;
  starDistanceM: number;
  /** Time of the view, UTC Unix milliseconds. */
  utcMs: number;
}

/** Beyond this distance from any star the view is described as interstellar space (matches format.ts switching to ly). */
const DEEP_SPACE_M = 0.05 * LIGHT_YEAR_M;

/** "2026-10-11 14:03:12" (UTC), the HUD's format. */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().replace('T', ' ').slice(0, 19);
}

/** Caption text for a view, from values the game already computes for its HUD. */
export function captionFor(c: CaptionInput): CaptionText {
  const utc = formatUtc(c.utcMs);
  const lightTime = formatDuration(c.starDistanceM / SPEED_OF_LIGHT_M_PER_S);
  let title: string;
  let subtitle: string;
  if (c.nearIsStar && c.starDistanceM >= DEEP_SPACE_M) {
    title = t('share.caption.deepSpace', { name: c.starName, distance: formatDistance(c.starDistanceM) });
    subtitle = t('share.caption.subtitle.deep', { utc });
  } else if (c.nearIsStar) {
    title = t('share.caption.star', { name: c.nearName, distance: formatDistance(Math.max(0, c.altitudeM)) });
    subtitle = t('share.caption.subtitle.star', { utc, duration: lightTime });
  } else {
    title =
      c.landed || c.altitudeM < 1
        ? t('share.caption.landed', { name: c.nearName })
        : t('share.caption.body', { name: c.nearName, altitude: formatDistance(c.altitudeM) });
    subtitle = t('share.caption.subtitle.body', { utc, star: c.starName, distance: formatDistance(c.starDistanceM), duration: lightTime });
  }
  return { title, subtitle, credits: t('share.caption.credits') };
}

// --- Layout ---------------------------------------------------------------------------------------------------------

export interface CaptionLayout {
  /** Scale unit: 1 at 1600×900. */
  s: number;
  padX: number;
  padBottom: number;
  titlePx: number;
  subtitlePx: number;
  creditsPx: number;
  creditsLineH: number;
  brandPx: number;
  taglinePx: number;
  /** Gap between the main row and the credits. */
  gap: number;
  /** Accent bar width and the indent of the title after it. */
  barW: number;
  indent: number;
}

/** Sizes for an image of w × h pixels. Fonts keep a legible minimum on small images. */
export function captionLayout(w: number, h: number): CaptionLayout {
  const s = Math.min(6, Math.max(0.3, Math.min(w / 1600, h / 900)));
  const titlePx = Math.max(13, 34 * s);
  const creditsPx = Math.max(9, 14 * s);
  return {
    s,
    padX: Math.max(12, 48 * s),
    padBottom: Math.max(8, 26 * s),
    titlePx,
    subtitlePx: Math.max(10, 17 * s),
    creditsPx,
    creditsLineH: creditsPx * 1.4,
    brandPx: Math.max(10, 19 * s),
    taglinePx: Math.max(9, 13 * s),
    gap: Math.max(8, 20 * s),
    barW: Math.max(2, 3 * s),
    indent: Math.max(8, 20 * s),
  };
}

// --- Drawing --------------------------------------------------------------------------------------------------------

export interface CaptionStyle {
  fg: string;
  dim: string;
  accent: string;
  font: string;
  mono: string;
  brand: string;
  tagline: string;
}

/** Colours and fonts from the page's tokens (styles.css / ui.css), so colourblind palettes apply to the caption too. */
export function captionStyleFromDocument(brand: string, tagline: string): CaptionStyle {
  const css = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const v = (name: string, fallback: string): string => css?.getPropertyValue(name).trim() || fallback;
  return {
    fg: v('--ks-fg', '#d8e6ff'),
    dim: v('--ks-dim', '#8aa0c0'),
    accent: v('--ks-accent', '#7fd4ff'),
    font: v('--ks-font', 'system-ui, sans-serif'),
    mono: v('--ks-mono', 'ui-monospace, monospace'),
    brand,
    tagline,
  };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** Anything that measures text like a 2D context (tests pass a fixed-width stand-in). */
export interface TextMeasurer {
  measureText(text: string): { readonly width: number };
}

/** Longest prefix of `text` that fits `maxW` with an ellipsis (the whole text when it fits). */
export function fitText(ctx: TextMeasurer, text: string, maxW: number): string {
  if (maxW <= 0) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${chars.slice(0, mid).join('').trimEnd()}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '' : `${chars.slice(0, lo).join('').trimEnd()}…`;
}

/**
 * Wraps a " · "-separated credits line onto at most `maxLines` lines, keeping segments whole where possible. When it
 * does not fit, the last segment (the provenance note) keeps its own line and the text before it is shortened.
 */
export function wrapSegments(ctx: TextMeasurer, text: string, maxW: number, maxLines: number, sep = ' · ', keepLast = true): string[] {
  const parts = text.split(sep);
  const lines: string[] = [];
  let cur = '';
  for (const p of parts) {
    const next = cur ? `${cur}${sep}${p}` : p;
    if (ctx.measureText(next).width <= maxW || !cur) cur = next;
    else {
      lines.push(cur);
      cur = p;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    if (keepLast && parts.length > 1 && maxLines > 1) {
      const head = wrapSegments(ctx, parts.slice(0, -1).join(sep), maxW, maxLines - 1, sep, false);
      return [...head, fitText(ctx, parts[parts.length - 1]!, maxW)];
    }
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!}${sep}${lines.slice(maxLines).join(sep)}`;
    return kept.map((l) => fitText(ctx, l, maxW));
  }
  return lines.map((l) => fitText(ctx, l, maxW));
}

/**
 * Paints the caption over the bottom of a w × h image: a soft scrim, the place and time on the left, the wordmark
 * and tagline on the right, and the credits across the bottom. When the place would not fit beside the wordmark
 * (narrow or portrait images), the wordmark and tagline lead the credits instead. Returns the top of the scrim (px).
 */
export function drawCaption(ctx: Ctx, w: number, h: number, text: CaptionText, style: CaptionStyle): number {
  const L = captionLayout(w, h);
  const font = (weight: number, px: number, family = style.font): string => `${weight} ${px.toFixed(2)}px ${family}`;
  const brand = style.brand.toUpperCase();
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = '0px';

  // Wordmark block size (orbit mark + spaced wordmark, tagline below).
  const brandFont = font(300, L.brandPx);
  const brandW = measureSpaced(ctx, brand, brandFont, '0.38em');
  ctx.font = font(400, L.taglinePx);
  const tagW = ctx.measureText(style.tagline).width;
  const markR = L.brandPx * 0.36;
  const trail = L.brandPx * 0.38;
  const blockW = Math.max(brandW - trail + markR * 3.1 + L.brandPx * 0.5, tagW);
  // Place and time widths decide the layout.
  const textX = L.padX + L.barW + L.indent;
  ctx.font = font(600, L.titlePx);
  const titleW = ctx.measureText(text.title).width;
  ctx.font = font(500, L.subtitlePx, style.mono);
  const subW = ctx.measureText(text.subtitle).width;
  const narrow = textX + Math.max(titleW, subW) + 40 * L.s + blockW > w - L.padX;

  // Credits set the height of the band; in the narrow layout they carry the wordmark and tagline.
  const creditsW = w - 2 * L.padX;
  const lead = narrow ? `${brand}  ` : '';
  const leadW = lead ? measureSpaced(ctx, lead, font(600, L.creditsPx), '0.18em') : 0;
  ctx.font = font(400, L.creditsPx);
  const creditsText = narrow ? [style.tagline, text.credits].filter(Boolean).join(' · ') : text.credits;
  const credits = creditsText ? wrapSegments(ctx, creditsText, creditsW - leadW, narrow ? 5 : 3) : [];
  const creditsH = credits.length * L.creditsLineH;
  const mainH = L.titlePx * 1.15 + L.subtitlePx * 1.5;
  const bottom = h - L.padBottom;
  const creditsTop = bottom - creditsH;
  const mainBottom = creditsTop - (credits.length ? L.gap : 0);
  const mainTop = mainBottom - mainH;
  const scrimTop = Math.max(0, mainTop - 70 * L.s - 24);

  // Scrim: transparent at the top, deep blue-black at the bottom edge (keeps the image, frames the text).
  const g = ctx.createLinearGradient(0, scrimTop, 0, h);
  g.addColorStop(0, 'rgba(2, 5, 12, 0)');
  g.addColorStop(0.45, 'rgba(2, 5, 12, 0.52)');
  g.addColorStop(1, 'rgba(2, 5, 12, 0.88)');
  ctx.fillStyle = g;
  ctx.fillRect(0, scrimTop, w, h - scrimTop);

  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 6 * L.s;
  const titleBase = mainTop + L.titlePx * 0.95;
  const subBase = mainTop + L.titlePx * 1.15 + L.subtitlePx * 1.1;

  // Right block: orbit mark, wordmark, tagline.
  if (!narrow) {
    const right = w - L.padX;
    const brandBase = titleBase - (L.titlePx - L.brandPx) * 0.35;
    const brandLeft = right + trail - brandW;
    ctx.fillStyle = style.fg;
    ctx.font = brandFont;
    ctx.letterSpacing = '0.38em';
    ctx.textAlign = 'right';
    // Letter spacing adds space after the last glyph; shift so the wordmark ends flush with the tagline.
    ctx.fillText(brand, right + trail, brandBase);
    ctx.letterSpacing = '0px';
    drawOrbitMark(ctx, brandLeft - markR * 1.55 - L.brandPx * 0.5, brandBase - L.brandPx * 0.36, markR, style, L.s);
    ctx.font = font(400, L.taglinePx);
    ctx.fillStyle = style.dim;
    ctx.fillText(style.tagline, right, subBase);
  }

  // Left block: accent bar, title, subtitle.
  const maxTitleW = w - L.padX - textX - (narrow ? 0 : blockW + 40 * L.s);
  ctx.textAlign = 'left';
  ctx.shadowBlur = 0;
  ctx.fillStyle = style.accent;
  ctx.fillRect(L.padX, mainTop + L.titlePx * 0.12, L.barW, mainH - L.titlePx * 0.12);
  ctx.shadowBlur = 6 * L.s;
  ctx.fillStyle = style.fg;
  ctx.font = font(600, L.titlePx);
  ctx.fillText(fitText(ctx, text.title, maxTitleW), textX, titleBase);
  ctx.fillStyle = style.dim;
  ctx.font = font(500, L.subtitlePx, style.mono);
  ctx.fillText(fitText(ctx, text.subtitle, maxTitleW), textX, subBase);

  // Credits: a hairline, then the lines.
  if (credits.length) {
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(216, 230, 255, 0.14)';
    ctx.fillRect(L.padX, creditsTop - L.gap * 0.5, w - 2 * L.padX, Math.max(1, L.s));
    ctx.shadowBlur = 4 * L.s;
    credits.forEach((line, i) => {
      const y = creditsTop + L.creditsLineH * (i + 0.78);
      let x = L.padX;
      if (i === 0 && lead) {
        ctx.font = font(600, L.creditsPx);
        ctx.letterSpacing = '0.18em';
        ctx.fillStyle = style.fg;
        ctx.fillText(lead, x, y);
        ctx.letterSpacing = '0px';
        x += leadW;
      }
      ctx.font = font(400, L.creditsPx);
      ctx.fillStyle = style.dim;
      ctx.fillText(line, x, y);
    });
  }
  ctx.restore();
  return scrimTop;
}

function measureSpaced(ctx: Ctx, text: string, font: string, spacing: string): number {
  ctx.save();
  ctx.font = font;
  ctx.letterSpacing = spacing;
  const wpx = ctx.measureText(text).width;
  ctx.restore();
  return wpx;
}

/** A small ringed-planet mark (the "known sky" orbit), drawn in the accent colour. */
function drawOrbitMark(ctx: Ctx, cx: number, cy: number, r: number, style: CaptionStyle, s: number): void {
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = style.accent;
  ctx.lineWidth = Math.max(1, 1.4 * s);
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 1.55, r * 0.55, -0.35, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = style.fg;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
