import { describe, it, expect } from 'vitest';
import { bytes, compactNumber, currency, percent, deltaSign, shortDate, relativeTime, cx } from '../../src/lib/format.js';

describe('bytes', () => {
  it('formats bytes', () => expect(bytes(512)).toBe('512 B'));
  it('formats kilobytes', () => expect(bytes(1500)).toBe('1.50 KB'));
  it('formats gigabytes', () => expect(bytes(1.5e9)).toBe('1.50 GB'));
  it('formats terabytes', () => expect(bytes(2e12)).toBe('2.00 TB'));
  it('handles null/NaN', () => {
    expect(bytes(null)).toBe('—');
    expect(bytes(NaN)).toBe('—');
  });
  it('handles negative values', () => expect(bytes(-1024)).toBe('-1.02 KB'));
  it('uses 1024 base with binary option', () => expect(bytes(1024, { binary: true })).toBe('1.00 KB'));
});

describe('compactNumber', () => {
  it('formats small numbers as-is', () => expect(compactNumber(42)).toBe('42'));
  it('formats thousands', () => expect(compactNumber(1500)).toBe('1.5K'));
  it('formats millions', () => expect(compactNumber(2.5e6)).toBe('2.5M'));
  it('formats billions', () => expect(compactNumber(3e9)).toBe('3.0B'));
  it('formats trillions', () => expect(compactNumber(4e12)).toBe('4.0T'));
  it('handles null/NaN', () => {
    expect(compactNumber(null)).toBe('—');
    expect(compactNumber(NaN)).toBe('—');
  });
});

describe('currency', () => {
  it('formats as USD', () => expect(currency(1234.56)).toBe('$1,234.56'));
  it('handles null/NaN', () => {
    expect(currency(null)).toBe('—');
    expect(currency(NaN)).toBe('—');
  });
  it('compact thousands', () => expect(currency(5000, { compact: true })).toBe('$5.0K'));
  it('compact millions', () => expect(currency(3e6, { compact: true })).toBe('$3.00M'));
  it('respects decimals option', () => expect(currency(9.9, { decimals: 0 })).toBe('$10'));
});

describe('percent', () => {
  it('formats a ratio as percentage', () => expect(percent(0.75)).toBe('75.0%'));
  it('respects decimals param', () => expect(percent(0.333, 2)).toBe('33.30%'));
  it('handles null/NaN', () => {
    expect(percent(null)).toBe('—');
    expect(percent(NaN)).toBe('—');
  });
});

describe('deltaSign', () => {
  it('returns + for positive', () => expect(deltaSign(5)).toBe('+'));
  it('returns empty for negative', () => expect(deltaSign(-3)).toBe(''));
  it('returns empty for zero', () => expect(deltaSign(0)).toBe(''));
  it('returns empty for null', () => expect(deltaSign(null)).toBe(''));
});

describe('shortDate', () => {
  it('formats a date string', () => {
    expect(shortDate('2024-03-15T00:00:00Z')).toBe('Mar 15');
  });
  it('returns — for null', () => expect(shortDate(null)).toBe('—'));
  it('returns — for invalid date', () => expect(shortDate('not-a-date')).toBe('—'));
});

describe('relativeTime', () => {
  it('returns — for null', () => expect(relativeTime(null)).toBe('—'));
  it('returns — for invalid', () => expect(relativeTime('garbage')).toBe('—'));

  it('formats seconds ago', () => {
    const t = Date.now() - 30_000;
    expect(relativeTime(t)).toMatch(/^\d+s ago$/);
  });

  it('formats minutes ago', () => {
    const t = Date.now() - 5 * 60_000;
    expect(relativeTime(t)).toMatch(/^\d+m ago$/);
  });

  it('formats hours ago', () => {
    const t = Date.now() - 3 * 3_600_000;
    expect(relativeTime(t)).toMatch(/^\d+h ago$/);
  });

  it('formats days ago', () => {
    const t = Date.now() - 5 * 86_400_000;
    expect(relativeTime(t)).toMatch(/^\d+d ago$/);
  });

  it('shows a date for old timestamps', () => {
    const t = new Date('2020-01-01').getTime();
    const result = relativeTime(t);
    expect(result).toMatch(/\d{4}/); // contains a year
  });

  it('accepts Date objects', () => {
    const d = new Date(Date.now() - 60_000);
    expect(relativeTime(d)).toMatch(/^1m ago$/);
  });
});

describe('cx', () => {
  it('joins truthy strings', () => expect(cx('a', 'b', 'c')).toBe('a b c'));
  it('filters falsy values', () => expect(cx('a', false, null, undefined, 'b')).toBe('a b'));
  it('handles empty input', () => expect(cx()).toBe(''));
});
