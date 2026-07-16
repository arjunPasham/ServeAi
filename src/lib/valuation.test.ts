import { describe, expect, test } from 'vitest';
import { currentValuations, valueItems, type ValuationRow } from './valuation';

const NOW = Date.parse('2026-07-16T18:00:00Z');

const rows: ValuationRow[] = [
  { categoryKey: 'SEAFOOD', fmvPerLbCents: 899, basisPerLbCents: 320, effectiveFrom: '2026-01-01T00:00:00Z' },
  { categoryKey: 'SEAFOOD', fmvPerLbCents: 950, basisPerLbCents: 340, effectiveFrom: '2026-07-01T00:00:00Z' },
  { categoryKey: 'SEAFOOD', fmvPerLbCents: 999, basisPerLbCents: 350, effectiveFrom: '2027-01-01T00:00:00Z' }, // future
  { categoryKey: 'BAKERY',  fmvPerLbCents: 299, basisPerLbCents: 85,  effectiveFrom: '2026-01-01T00:00:00Z' },
];

describe('currentValuations', () => {
  test('picks the latest effective row per category, ignoring future rows', () => {
    const current = currentValuations(rows, NOW);
    expect(current.get('SEAFOOD')?.fmvPerLbCents).toBe(950);
    expect(current.get('BAKERY')?.fmvPerLbCents).toBe(299);
  });
});

describe('valueItems', () => {
  test('computes rounded cents per item and totals', () => {
    const current = currentValuations(rows, NOW);
    const result = valueItems(
      [{ categoryKey: 'SEAFOOD', estLbs: 8 }, { categoryKey: 'BAKERY', estLbs: 2.5 }],
      current
    );
    expect(result).toEqual({
      ok: true,
      totalFmvCents: 950 * 8 + Math.round(299 * 2.5), // 7600 + 748 = 8348
      totalBasisCents: 340 * 8 + Math.round(85 * 2.5), // 2720 + 213 = 2933
      perItem: [
        { categoryKey: 'SEAFOOD', estLbs: 8, fmvCents: 7600, basisCents: 2720 },
        { categoryKey: 'BAKERY', estLbs: 2.5, fmvCents: 748, basisCents: 213 },
      ],
    });
  });
  test('reports the first missing category', () => {
    const current = currentValuations(rows, NOW);
    expect(valueItems([{ categoryKey: 'DELI', estLbs: 1 }], current))
      .toEqual({ ok: false, missingCategory: 'DELI' });
  });
});
