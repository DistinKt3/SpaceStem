/**
 * Fuel gauge: a compact glass HUD widget for hyper-fuel and hull heat (docs/FUEL.md).
 *
 * - Fuel bar with the selected jump's cost: a hatched segment shows the share of the tank the jump would use and a
 *   tick marks what is left after it; when the tank is short the segment turns into a dashed outline up to the cost.
 * - Heat bar with ticks at the warning and critical levels; the state is also written as a word with an icon
 *   (Hot / Critical / Emergency), so it never relies on colour alone. Colours come from the theme tokens, which the
 *   colour-blind palettes override.
 * - A "Scooping" chip while the scoop collects fuel.
 * - One polite live region announces state changes only (scooping, heat level, low fuel, jump feasibility), never
 *   per-frame values. The meters carry their values for assistive technology.
 * - Sizes are in rem (text scaling); animations stop under reduced motion (the OS preference or the game setting,
 *   which sets html[data-reduced-motion]).
 *
 * Hyper-fuel, scooping and hull heat are game mechanics; the widget says so in its header.
 */
import { formatDuration } from '../format';
import { t } from '../i18n';
import { FUEL, fuelLowFor, heatStateFor, type HeatState } from './fuel';

export interface FuelGaugeState {
  /** 0..1 of the tank. */
  hyperFuel: number;
  /** 0..1 of the hull limit. */
  heat: number;
  scooping: boolean;
  /** Fraction of the tank the selected jump costs, or null without a jump target. */
  nextJumpCost: number | null;
  /** Optional: seconds until the tank is full while scooping. */
  secondsToFull?: number | null;
  /**
   * Optional: the FuelSystem's heat state. Pass it so the gauge and the ship agree exactly; without it the gauge
   * derives the state from `heat` with the same thresholds and hysteresis.
   */
  heatState?: HeatState;
}

export interface FuelGaugeOptions {
  /** 'hud' pins the widget to the top-right of a positioned parent (the HUD root); 'inline' leaves it in flow. */
  placement?: 'hud' | 'inline';
}

const STYLE_ID = 'ks-fuel-gauge-style';

const CSS = `
.ks-fuel {
  --ks-fuel-v: 0; --ks-fuel-h: 0; --ks-fuel-a: 0; --ks-fuel-w: 0; --ks-fuel-m: 0;
  position: relative; box-sizing: border-box; width: 14.5rem; max-width: 100%;
  padding: 0.55rem 0.75rem 0.65rem; color: var(--ks-fg); font: 400 0.72rem/1.3 var(--ks-mono);
  background: linear-gradient(180deg, rgba(14, 30, 54, 0.55), var(--ks-panel));
  border: var(--ks-border-w, 1px) solid var(--ks-border); border-radius: 0.6rem;
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 0 1.5rem rgba(0, 0, 0, 0.35), inset 0 0 1.1rem rgba(127, 212, 255, 0.06);
  pointer-events: none; transition: border-color 0.3s ease, box-shadow 0.3s ease;
}
.ks-fuel[hidden] { display: none; }
.ks-fuel::before {
  content: ''; position: absolute; left: 12%; right: 12%; top: 0; height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--ks-accent) 70%, transparent), transparent);
}
.ks-fuel--hud { position: absolute; top: 1rem; right: 1.2rem; max-width: calc(100% - 2.4rem); }
.ks-fuel-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.2rem 0.5rem; margin-bottom: 0.4rem; }
.ks-fuel-title { font-size: 0.64rem; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; color: var(--ks-accent); }
.ks-fuel-tag {
  font-size: 0.54rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ks-dim); white-space: nowrap;
  border: 1px dotted currentColor; border-radius: 1rem; padding: 0.02rem 0.4rem;
}
.ks-fuel-row + .ks-fuel-row { margin-top: 0.5rem; }
.ks-fuel-line { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.1rem 0.4rem; }
.ks-fuel-k { font-size: 0.6rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ks-dim); }
.ks-fuel-vals { display: inline-flex; align-items: baseline; gap: 0.35rem; }
.ks-fuel-v { font-size: 0.84rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.ks-fuel-flag {
  display: none; align-items: center; gap: 0.2rem; font-size: 0.56rem; font-weight: 600; letter-spacing: 0.1em;
  text-transform: uppercase; padding: 0.02rem 0.35rem; border-radius: 0.25rem; border: 1px solid currentColor;
}
.ks-fuel-flag svg { width: 0.62rem; height: 0.62rem; flex: none; }
.ks-fuel-bar {
  position: relative; height: 0.5rem; margin-top: 0.3rem; border-radius: 0.25rem;
  background: color-mix(in srgb, var(--ks-fg) 9%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ks-fg) 6%, transparent);
}
.ks-fuel-fill, .ks-heat-fill {
  position: absolute; left: 0; top: 0; bottom: 0; border-radius: 0.25rem;
  transition: width 0.25s linear, background-color 0.3s ease;
}
.ks-fuel-fill {
  width: calc(var(--ks-fuel-v) * 100%);
  background: linear-gradient(90deg, color-mix(in srgb, var(--ks-accent) 40%, transparent), var(--ks-accent));
  box-shadow: 0 0 0.45rem color-mix(in srgb, var(--ks-accent) var(--ks-glow, 35%), transparent);
}
.ks-fuel-cost {
  display: none; position: absolute; top: 0; bottom: 0; box-sizing: border-box;
  left: calc(var(--ks-fuel-a) * 100%); width: calc(var(--ks-fuel-w) * 100%);
  background: repeating-linear-gradient(135deg, rgba(2, 6, 14, 0.62) 0 0.12rem, transparent 0.12rem 0.3rem);
  transition: left 0.25s linear, width 0.25s linear;
}
.ks-fuel-mark {
  display: none; position: absolute; top: -0.22rem; bottom: -0.22rem; width: 2px; margin-left: -1px;
  left: calc(var(--ks-fuel-m) * 100%); background: var(--ks-fg); border-radius: 1px;
  box-shadow: 0 0 0.3rem rgba(0, 0, 0, 0.8); transition: left 0.25s linear;
}
.ks-fuel-mark::before {
  content: ''; position: absolute; left: 50%; top: -0.32rem; transform: translateX(-50%);
  border-left: 0.22rem solid transparent; border-right: 0.22rem solid transparent; border-top: 0.28rem solid var(--ks-fg);
}
.ks-fuel[data-jump='ok'] .ks-fuel-cost, .ks-fuel[data-jump='ok'] .ks-fuel-mark,
.ks-fuel[data-jump='short'] .ks-fuel-cost, .ks-fuel[data-jump='short'] .ks-fuel-mark { display: block; }
.ks-fuel[data-jump='short'] .ks-fuel-cost {
  border: 1px dashed var(--ks-danger); border-radius: 0.25rem;
  background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--ks-danger) 32%, transparent) 0 0.12rem, transparent 0.12rem 0.3rem);
}
.ks-fuel[data-jump='short'] .ks-fuel-mark, .ks-fuel[data-jump='short'] .ks-fuel-mark::before { background: var(--ks-danger); border-top-color: var(--ks-danger); }
.ks-fuel[data-jump='short'] .ks-fuel-mark::before { background: none; }
.ks-fuel-sub { margin-top: 0.32rem; font-size: 0.62rem; color: var(--ks-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ks-fuel[data-jump='short'] .ks-fuel-sub { color: var(--ks-fg); }
.ks-fuel[data-jump='short'] .ks-fuel-sub::before { content: '\\2715\\00a0'; color: var(--ks-danger); font-weight: 700; }
.ks-fuel[data-low='true'] .ks-fuel-fill { background: linear-gradient(90deg, color-mix(in srgb, var(--ks-warn) 40%, transparent), var(--ks-warn)); }
.ks-fuel[data-low='true'] .ks-fuel-flag--low { display: inline-flex; color: var(--ks-warn); }
.ks-heat-fill { width: calc(var(--ks-fuel-h) * 100%); background: var(--ks-ok); }
.ks-heat-tick { position: absolute; top: -0.16rem; bottom: -0.16rem; width: 1px; background: color-mix(in srgb, var(--ks-fg) 55%, transparent); }
.ks-heat-tick--crit { width: 2px; margin-left: -0.5px; }
.ks-fuel[data-heat='warning'] .ks-heat-fill { background: var(--ks-warn); }
.ks-fuel[data-heat='critical'] .ks-heat-fill, .ks-fuel[data-heat='emergency'] .ks-heat-fill { background: var(--ks-danger); }
.ks-fuel[data-heat='warning'] .ks-fuel-flag--heat { display: inline-flex; color: var(--ks-warn); }
.ks-fuel[data-heat='critical'] .ks-fuel-flag--heat, .ks-fuel[data-heat='emergency'] .ks-fuel-flag--heat { display: inline-flex; color: var(--ks-danger); }
.ks-fuel[data-heat='critical'], .ks-fuel[data-heat='emergency'] {
  border-color: var(--ks-danger);
  box-shadow: 0 0 1.5rem rgba(0, 0, 0, 0.35), 0 0 0.9rem color-mix(in srgb, var(--ks-danger) var(--ks-glow, 35%), transparent);
}
.ks-fuel[data-heat='emergency'] .ks-fuel-flag--heat { background: color-mix(in srgb, var(--ks-danger) 22%, transparent); }
.ks-fuel[data-heat='critical'] .ks-heat-fill, .ks-fuel[data-heat='emergency'] .ks-heat-fill { animation: ks-fuel-throb 0.9s ease-in-out infinite alternate; }
.ks-fuel-scoop {
  display: none; align-items: center; justify-content: center; gap: 0.35rem; margin-top: 0.55rem; padding: 0.2rem 0.4rem;
  font-size: 0.62rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ks-accent);
  border: 1px solid color-mix(in srgb, var(--ks-accent) 55%, transparent); border-radius: 0.3rem;
  background: repeating-linear-gradient(90deg, color-mix(in srgb, var(--ks-accent) 14%, transparent) 0 0.5rem, transparent 0.5rem 1rem);
  background-size: 1rem 100%; animation: ks-fuel-flow 0.8s linear infinite;
}
.ks-fuel-scoop svg { width: 0.7rem; height: 0.7rem; flex: none; }
.ks-fuel-scoop .ks-fuel-eta { font-weight: 400; letter-spacing: 0.04em; text-transform: none; color: var(--ks-fg); }
.ks-fuel[data-scooping='true'] .ks-fuel-scoop { display: flex; }
.ks-fuel[data-scooping='true'] .ks-fuel-fill {
  background-image: repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.16) 0 0.25rem, transparent 0.25rem 0.75rem),
    linear-gradient(90deg, color-mix(in srgb, var(--ks-accent) 40%, transparent), var(--ks-accent));
  background-size: 0.75rem 100%, 100% 100%; animation: ks-fuel-flow-fill 0.6s linear infinite;
}
.ks-fuel-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
@keyframes ks-fuel-flow { to { background-position: 1rem 0; } }
@keyframes ks-fuel-flow-fill { to { background-position: 0.75rem 0, 0 0; } }
@keyframes ks-fuel-throb { from { opacity: 1; } to { opacity: 0.55; } }
@media (prefers-reduced-motion: reduce) {
  .ks-fuel, .ks-fuel *, .ks-fuel *::before { animation: none !important; transition: none !important; }
}
:root[data-reduced-motion='true'] .ks-fuel, :root[data-reduced-motion='true'] .ks-fuel *,
:root[data-reduced-motion='true'] .ks-fuel *::before { animation: none !important; transition: none !important; }
@media (forced-colors: active) {
  .ks-fuel-fill, .ks-heat-fill, .ks-fuel-mark { background: Highlight; forced-color-adjust: none; }
}
`;

/** Icons (decorative; the state word next to them carries the meaning). */
const ICON_WARN =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2 11 10.4H1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 4.6v2.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="6" cy="8.8" r="0.75" fill="currentColor"/></svg>';
const ICON_CRIT =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2 11 10.4H1z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6 4.6v2.7" stroke="#000" stroke-width="1.4" stroke-linecap="round"/><circle cx="6" cy="8.8" r="0.75" fill="#000"/></svg>';
const ICON_EMERG =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 1h4l3 3v4l-3 3H4L1 8V4z" fill="currentColor"/><path d="M6 3.4v3.2" stroke="#000" stroke-width="1.4" stroke-linecap="round"/><circle cx="6" cy="8.6" r="0.75" fill="#000"/></svg>';
const ICON_LOW =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10.8V2M2.6 7.4 6 10.8l3.4-3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_SCOOP =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 2h9L7 6.6V10.5L5 9.4V6.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

function div(cls: string, parent: HTMLElement): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  parent.appendChild(e);
  return e;
}

function span(cls: string, parent: HTMLElement, text = ''): HTMLSpanElement {
  const e = document.createElement('span');
  e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

const pct = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 100);
const finite01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

interface Snapshot {
  scooping: boolean;
  heat: HeatState;
  low: boolean;
  jump: 'none' | 'ok' | 'short';
}

export class FuelGauge {
  readonly root: HTMLElement;
  private readonly fuelVal: HTMLSpanElement;
  private readonly heatVal: HTMLSpanElement;
  private readonly heatFlag: HTMLSpanElement;
  private readonly fuelMeter: HTMLDivElement;
  private readonly heatMeter: HTMLDivElement;
  private readonly sub: HTMLDivElement;
  private readonly eta: HTMLSpanElement;
  private readonly live: HTMLDivElement;
  private prev: Snapshot | null = null;
  private heatState: HeatState = 'nominal';
  private low = false;
  /** Last written values, to touch the DOM only when something visible changes. */
  private written = { v: -1, h: -1, a: -1, w: -1, m: -1, fuelText: '', heatText: '', sub: '', eta: '', vt: '', ht: '' };
  private _lastAnnouncement = '';

  constructor(parent: HTMLElement, options: FuelGaugeOptions = {}) {
    ensureStyle(parent.ownerDocument);
    const root = document.createElement('section');
    root.className = `ks-fuel${(options.placement ?? 'hud') === 'hud' ? ' ks-fuel--hud' : ''}`;
    root.setAttribute('aria-label', t('fuel.gauge.label'));
    root.dataset['heat'] = 'nominal';
    root.dataset['scooping'] = 'false';
    root.dataset['low'] = 'false';
    root.dataset['jump'] = 'none';
    this.root = root;

    const head = div('ks-fuel-head', root);
    span('ks-fuel-title', head, t('fuel.gauge.title'));
    const tag = span('ks-fuel-tag', head, t('fuel.gauge.fiction'));
    tag.title = t('fuel.gauge.fictionNote');

    // Fuel row.
    const fuelRow = div('ks-fuel-row', root);
    const fl = div('ks-fuel-line', fuelRow);
    fl.setAttribute('aria-hidden', 'true');
    span('ks-fuel-k', fl, t('fuel.gauge.fuel'));
    const fvals = span('ks-fuel-vals', fl);
    const lowFlag = span('ks-fuel-flag ks-fuel-flag--low', fvals);
    lowFlag.innerHTML = ICON_LOW;
    lowFlag.append(t('fuel.gauge.low'));
    this.fuelVal = span('ks-fuel-v', fvals);
    this.fuelMeter = div('ks-fuel-bar', fuelRow);
    this.meter(this.fuelMeter, t('fuel.gauge.fuelMeter'));
    div('ks-fuel-fill', this.fuelMeter);
    div('ks-fuel-cost', this.fuelMeter);
    div('ks-fuel-mark', this.fuelMeter);
    this.sub = div('ks-fuel-sub', fuelRow);
    this.sub.setAttribute('aria-hidden', 'true');

    // Heat row.
    const heatRow = div('ks-fuel-row', root);
    const hl = div('ks-fuel-line', heatRow);
    hl.setAttribute('aria-hidden', 'true');
    span('ks-fuel-k', hl, t('fuel.gauge.heat'));
    const hvals = span('ks-fuel-vals', hl);
    this.heatFlag = span('ks-fuel-flag ks-fuel-flag--heat', hvals);
    this.heatVal = span('ks-fuel-v', hvals);
    this.heatMeter = div('ks-fuel-bar ks-heat-bar', heatRow);
    this.meter(this.heatMeter, t('fuel.gauge.heatMeter'));
    div('ks-heat-fill', this.heatMeter);
    const tick = (at: number, cls: string): void => {
      div(`ks-heat-tick ${cls}`, this.heatMeter).style.left = `${at * 100}%`;
    };
    tick(FUEL.heatWarning, 'ks-heat-tick--warn');
    tick(FUEL.heatCritical, 'ks-heat-tick--crit');

    // Scooping chip.
    const scoop = div('ks-fuel-scoop', root);
    scoop.setAttribute('aria-hidden', 'true');
    scoop.innerHTML = ICON_SCOOP;
    scoop.append(t('fuel.gauge.scooping'));
    this.eta = span('ks-fuel-eta', scoop);

    this.live = div('ks-fuel-sr', root);
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');
    this.live.setAttribute('aria-atomic', 'true');
    parent.appendChild(root);
  }

  /** The text most recently sent to the live region (for tests). */
  get lastAnnouncement(): string {
    return this._lastAnnouncement;
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }

  get isVisible(): boolean {
    return !this.root.hidden;
  }

  dispose(): void {
    this.root.remove();
  }

  update(state: FuelGaugeState): void {
    const fuel = finite01(state.hyperFuel);
    const heat = finite01(state.heat);
    const cost = state.nextJumpCost !== null && Number.isFinite(state.nextJumpCost) ? Math.max(0, state.nextJumpCost) : null;
    this.heatState = state.heatState ?? heatStateFor(this.heatState, heat);
    this.low = fuelLowFor(this.low, fuel);
    const jump: Snapshot['jump'] = cost === null ? 'none' : fuel + 1e-9 >= cost ? 'ok' : 'short';
    const r = this.root;
    const d = r.dataset;
    if (d['heat'] !== this.heatState) d['heat'] = this.heatState;
    const sc = String(state.scooping);
    if (d['scooping'] !== sc) d['scooping'] = sc;
    const lo = String(this.low);
    if (d['low'] !== lo) d['low'] = lo;
    if (d['jump'] !== jump) d['jump'] = jump;

    // Bars (CSS custom properties; written only when they move by at least 0.05% of the bar).
    const w = this.written;
    const setVar = (key: 'v' | 'h' | 'a' | 'w' | 'm', v: number): void => {
      if (Math.abs(w[key] - v) < 5e-4) return;
      w[key] = v;
      r.style.setProperty(`--ks-fuel-${key}`, v.toFixed(4));
    };
    setVar('v', fuel);
    setVar('h', heat);
    if (cost !== null) {
      if (jump === 'ok') {
        setVar('a', fuel - cost);
        setVar('w', cost);
        setVar('m', fuel - cost);
      } else {
        const c = Math.min(1, cost);
        setVar('a', 0);
        setVar('w', c);
        setVar('m', c);
      }
    }

    // Text.
    const fuelText = t('fuel.gauge.percent', { v: pct(fuel) });
    if (w.fuelText !== fuelText) this.fuelVal.textContent = w.fuelText = fuelText;
    const heatText = t('fuel.gauge.percent', { v: pct(heat) });
    if (w.heatText !== heatText) this.heatVal.textContent = w.heatText = heatText;
    const sub =
      cost === null
        ? t('fuel.gauge.noJump')
        : jump === 'ok'
          ? t('fuel.gauge.jump', { cost: pct(cost), left: pct(fuel - cost) })
          : t('fuel.gauge.jumpShort', { cost: Math.round(cost * 100) });
    if (w.sub !== sub) this.sub.textContent = w.sub = sub;
    const eta =
      state.scooping && typeof state.secondsToFull === 'number' && Number.isFinite(state.secondsToFull)
        ? t('fuel.gauge.fullIn', { t: formatDuration(Math.max(1, Math.ceil(state.secondsToFull))) })
        : '';
    if (w.eta !== eta) this.eta.textContent = w.eta = eta;
    if (this.heatFlag.dataset['state'] !== this.heatState) {
      this.heatFlag.dataset['state'] = this.heatState;
      const icon = this.heatState === 'emergency' ? ICON_EMERG : this.heatState === 'critical' ? ICON_CRIT : this.heatState === 'warning' ? ICON_WARN : '';
      this.heatFlag.innerHTML = icon;
      if (this.heatState !== 'nominal') this.heatFlag.append(t(`fuel.heat.${this.heatState}`));
    }

    // Meter values for assistive technology.
    const vt =
      cost === null
        ? t('fuel.gauge.fuelValueText', { v: pct(fuel) })
        : jump === 'ok'
          ? t('fuel.gauge.fuelValueTextJump', { v: pct(fuel), cost: pct(cost) })
          : t('fuel.gauge.fuelValueTextShort', { v: pct(fuel), cost: Math.round(cost * 100) });
    if (w.vt !== vt) {
      w.vt = vt;
      this.fuelMeter.setAttribute('aria-valuenow', String(pct(fuel)));
      this.fuelMeter.setAttribute('aria-valuetext', vt);
    }
    const ht = t('fuel.gauge.heatValueText', { v: pct(heat), state: t(`fuel.heat.${this.heatState}`) });
    if (w.ht !== ht) {
      w.ht = ht;
      this.heatMeter.setAttribute('aria-valuenow', String(pct(heat)));
      this.heatMeter.setAttribute('aria-valuetext', ht);
    }

    this.announce({ scooping: state.scooping, heat: this.heatState, low: this.low, jump }, fuel);
  }

  private meter(el: HTMLElement, label: string): void {
    el.setAttribute('role', 'meter');
    el.setAttribute('aria-label', label);
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    el.setAttribute('aria-valuenow', '0');
  }

  /** Speaks state changes (not values). The first update only records the starting state. */
  private announce(now: Snapshot, fuel: number): void {
    const prev = this.prev;
    this.prev = now;
    if (!prev) return;
    const msgs: string[] = [];
    if (now.scooping && !prev.scooping) msgs.push(t('fuel.say.scoopStart'));
    if (!now.scooping && prev.scooping) msgs.push(fuel >= 0.999 ? t('fuel.say.tankFull') : t('fuel.say.scoopStop'));
    const rank = (s: HeatState): number => ['nominal', 'warning', 'critical', 'emergency'].indexOf(s);
    if (rank(now.heat) > rank(prev.heat)) msgs.push(t(`fuel.say.heat.${now.heat}`));
    else if (now.heat === 'nominal' && prev.heat !== 'nominal') msgs.push(t('fuel.say.heat.nominal'));
    if (now.low && !prev.low) msgs.push(t('fuel.say.fuelLow', { v: pct(fuel) }));
    if (now.jump === 'short' && prev.jump !== 'short') msgs.push(t('fuel.say.jumpShort'));
    else if (now.jump === 'ok' && prev.jump === 'short') msgs.push(t('fuel.say.jumpOk'));
    if (msgs.length === 0) return;
    let text = msgs.join(' ');
    // Screen readers skip a live-region update that does not change the text; vary it invisibly when repeating.
    if (text === this.live.textContent) text += ' ';
    this.live.textContent = text;
    this._lastAnnouncement = text.trim();
  }
}
