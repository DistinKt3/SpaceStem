import { describe, expect, it } from 'vitest';
import { formatNumber, keySources, t } from '../../src/game/i18n';

describe('i18n', () => {
  it('has no duplicate keys across locale files', () => {
    const seen = new Map<string, string>();
    for (const { key, file } of keySources()) {
      expect(seen.has(key), `${key} defined in ${seen.get(key)} and ${file}`).toBe(false);
      seen.set(key, file);
    }
  });
  it('substitutes parameters and formats numbers', () => {
    expect(t('unit.km', { v: '12' })).toBe('12 km');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
  it('falls back to the key for unknown messages', () => {
    expect(t('does.not.exist')).toBe('does.not.exist');
  });
});
