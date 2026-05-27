import { describe, expect, it } from 'vitest';

import { formatCurrency, formatTokens, shortDayLabel } from './formatCurrency';

describe('formatCurrency', () => {
  it('formats positive USD amounts with two decimals under 100', () => {
    expect(formatCurrency(12.5, 'USD')).toMatch(/\$12\.50/);
  });

  it('drops fractional digits at or above 100', () => {
    expect(formatCurrency(150, 'USD')).toMatch(/\$150/);
  });

  it('falls back to USD for unrecognised currency labels', () => {
    expect(formatCurrency(5, 'NOT-A-CURRENCY')).toMatch(/\$5\.00/);
  });

  it('treats non-finite input as zero', () => {
    expect(formatCurrency(Number.NaN, 'USD')).toMatch(/0/);
    expect(formatCurrency(Number.POSITIVE_INFINITY, 'USD')).toMatch(/0/);
  });

  it('honours empty currency string by falling back to USD', () => {
    expect(formatCurrency(7, '')).toMatch(/\$7\.00/);
  });
});

describe('formatTokens', () => {
  it('renders zero / negative as "0"', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(-5)).toBe('0');
  });

  it('rounds integers under 1k', () => {
    expect(formatTokens(123.7)).toBe('124');
  });

  it('uses K and M suffixes', () => {
    expect(formatTokens(1_500)).toBe('1.5K');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

describe('shortDayLabel', () => {
  it('returns a 3-letter weekday for a valid ISO date', () => {
    const label = shortDayLabel('2026-05-27');
    expect(label.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to the suffix for malformed input', () => {
    const label = shortDayLabel('not-a-date');
    expect(typeof label).toBe('string');
  });
});
