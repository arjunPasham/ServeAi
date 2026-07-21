import { describe, expect, test } from 'vitest';
import { isValidCalendarDate } from './dates';

// Calendar-rollover dates pass validation under Date.parse (review I3):
// Date.parse('2026-02-30') silently rolls to March 2nd instead of rejecting.
// isValidCalendarDate must reject anything that doesn't round-trip through
// its own YYYY-MM-DD components, with no timezone-dependent interpretation
// (built on Date.UTC, never Date.parse/`new Date(string)`).
describe('isValidCalendarDate', () => {
  test('accepts a normal calendar date', () => {
    expect(isValidCalendarDate('2026-07-20')).toBe(true);
  });

  test('accepts Feb 29 on a leap year', () => {
    expect(isValidCalendarDate('2028-02-29')).toBe(true);
  });

  test('rejects Feb 29 on a non-leap year', () => {
    expect(isValidCalendarDate('2026-02-29')).toBe(false);
  });

  test('rejects a rollover date (Feb 30 -> would roll to Mar 2)', () => {
    expect(isValidCalendarDate('2026-02-30')).toBe(false);
  });

  test('rejects a rollover date (Apr 31 -> would roll to May 1)', () => {
    expect(isValidCalendarDate('2026-04-31')).toBe(false);
  });

  test('rejects an out-of-range month', () => {
    expect(isValidCalendarDate('2026-13-01')).toBe(false);
  });

  test('rejects the wrong shape (unpadded month/day)', () => {
    expect(isValidCalendarDate('2026-1-5')).toBe(false);
  });

  test('rejects an empty string', () => {
    expect(isValidCalendarDate('')).toBe(false);
  });
});
