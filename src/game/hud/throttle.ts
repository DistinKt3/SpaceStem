/** HUD throttle readout (no DOM or three.js imports, so it is unit-tested in node). */
import { formatNumber, t } from '../i18n';

/** Throttle range (fraction of full): reverse thrust goes to -50% (ship.ts). */
export const THROTTLE_MIN = -0.5;
export const THROTTLE_MAX = 1;

/**
 * The throttle bar as a meter (name, value and direction for assistive technology), with the value as text. Reverse
 * thrust fills from the right with a hatched pattern and reads "Reverse", so it does not rely on colour.
 */
export function throttleMeter(throttle: number): string {
  const pct = Math.round(Math.max(THROTTLE_MIN, Math.min(THROTTLE_MAX, throttle)) * 100) || 0; // || 0: no "-0%"
  const reverse = pct < 0;
  const text = reverse ? t('hud.throttleReverse', { v: formatNumber(-pct) }) : t('hud.throttleValue', { v: formatNumber(pct) });
  return (
    `<div class="ks-throttle${reverse ? ' is-reverse' : ''}" role="meter" aria-label="${t('hud.throttle')}" ` +
    `aria-valuemin="${THROTTLE_MIN * 100}" aria-valuemax="${THROTTLE_MAX * 100}" aria-valuenow="${pct}" aria-valuetext="${text}">` +
    `<div class="ks-throttle-fill" style="width:${Math.abs(pct)}%"></div></div>` +
    `<div class="ks-sub ks-throttle-value" aria-hidden="true">${text}</div>`
  );
}
