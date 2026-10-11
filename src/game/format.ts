/** Unit-aware formatting for the HUD (distances, speeds, light-travel times). */
import { AU_M, LIGHT_YEAR_M, SPEED_OF_LIGHT_M_PER_S } from '../core/constants';
import { formatNumber, t } from './i18n';

const sig = (v: number, digits = 3): number => {
  if (v === 0) return 0;
  const p = Math.pow(10, digits - Math.ceil(Math.log10(Math.abs(v))));
  return Math.round(v * p) / p;
};
const frac = (v: number, digits = 3): number => Math.max(0, digits - Math.ceil(Math.log10(Math.max(Math.abs(v), 1e-12))));

export function formatDistance(m: number): string {
  const a = Math.abs(m);
  if (a < 10_000) return t('unit.m', { v: formatNumber(sig(m, 4), frac(m, 4)) });
  if (a < 0.01 * AU_M) return t('unit.km', { v: formatNumber(sig(m / 1000, 4), frac(m / 1000, 4)) });
  if (a < 0.05 * LIGHT_YEAR_M) return t('unit.au', { v: formatNumber(sig(m / AU_M, 4), frac(m / AU_M, 4)) });
  return t('unit.ly', { v: formatNumber(sig(m / LIGHT_YEAR_M, 4), frac(m / LIGHT_YEAR_M, 4)) });
}

export function formatSpeed(mps: number): string {
  const a = Math.abs(mps);
  if (a < 1000) return t('unit.mps', { v: formatNumber(sig(mps, 3), frac(mps, 3)) });
  if (a < 0.001 * SPEED_OF_LIGHT_M_PER_S) return t('unit.kmps', { v: formatNumber(sig(mps / 1000, 4), frac(mps / 1000, 4)) });
  const c = mps / SPEED_OF_LIGHT_M_PER_S;
  return t('unit.c', { v: formatNumber(sig(c, 3), frac(c, 3)) });
}

export function formatDuration(s: number): string {
  if (s < 60) return t('time.s', { v: formatNumber(sig(s, 3), frac(s, 3)) });
  if (s < 3600) return t('time.min', { m: Math.floor(s / 60), s: Math.floor(s % 60) });
  if (s < 86_400 * 2) return t('time.h', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
  if (s < 86_400 * 365.25 * 2) return t('time.d', { v: formatNumber(sig(s / 86_400, 3), frac(s / 86_400, 3)) });
  const y = s / (86_400 * 365.25);
  return t('time.y', { v: formatNumber(sig(y, 3), frac(y, 3)) });
}
