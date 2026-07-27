import { describe, expect, test } from 'vitest';
import { weekdayLabel, describeSurplusPattern, DANGLE_WINDOW_DAYS } from './reports';

describe('weekdayLabel', () => {
  test('maps ISO weekday 1..7 to Mon..Sun', () => {
    expect(weekdayLabel(1)).toBe('Monday');
    expect(weekdayLabel(4)).toBe('Thursday');
    expect(weekdayLabel(7)).toBe('Sunday');
  });
  test('out-of-range weekday is Unknown', () => {
    expect(weekdayLabel(0)).toBe('Unknown');
    expect(weekdayLabel(8)).toBe('Unknown');
  });
});

describe('describeSurplusPattern', () => {
  test('renders the surplus-intelligence sentence', () => {
    expect(describeSurplusPattern({
      categoryLabel: 'Bakery & desserts',
      localDow: 1,
      avgEstLbsPerDay: 22,
      distinctDays: 6,
      totalEstLbs: 132,
    })).toBe('~22.0 lbs of Bakery & desserts every Monday (6 days seen)');
  });
  test('singularizes a single observed day', () => {
    expect(describeSurplusPattern({
      categoryLabel: 'Dairy',
      localDow: 3,
      avgEstLbsPerDay: 5.5,
      distinctDays: 1,
      totalEstLbs: 5.5,
    })).toBe('~5.5 lbs of Dairy every Wednesday (1 day seen)');
  });
});

describe('DANGLE_WINDOW_DAYS', () => {
  test('is a sane positive window', () => {
    expect(DANGLE_WINDOW_DAYS).toBeGreaterThan(0);
    expect(Number.isInteger(DANGLE_WINDOW_DAYS)).toBe(true);
  });
});
