import { describe, expect, test } from 'vitest';
import { currentValuations, valueItems, parseValuationInput, type ValuationRow } from './valuation';

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

describe('parseValuationInput', () => {
  test('parses dollar strings into rounded integer cents', () => {
    expect(parseValuationInput({ fmvDollars: '4.49', basisDollars: '1.40' }))
      .toEqual({ ok: true, fmvPerLbCents: 449, basisPerLbCents: 140 });
  });

  test('accepts zero basis (a give-away category has no cost basis)', () => {
    expect(parseValuationInput({ fmvDollars: '1.99', basisDollars: '0' }))
      .toEqual({ ok: true, fmvPerLbCents: 199, basisPerLbCents: 0 });
  });

  test('rounds a sub-cent entry to the nearest cent', () => {
    expect(parseValuationInput({ fmvDollars: '1.999', basisDollars: '0.501' }))
      .toEqual({ ok: true, fmvPerLbCents: 200, basisPerLbCents: 50 });
  });

  test('rejects a non-numeric, empty, or negative fmv as INVALID_FMV', () => {
    expect(parseValuationInput({ fmvDollars: 'abc', basisDollars: '1.00' }).ok).toBe(false);
    expect(parseValuationInput({ fmvDollars: '', basisDollars: '1.00' }))
      .toEqual({ ok: false, error: 'INVALID_FMV' });
    expect(parseValuationInput({ fmvDollars: '-1', basisDollars: '1.00' }))
      .toEqual({ ok: false, error: 'INVALID_FMV' });
  });

  test('rejects a bad basis as INVALID_BASIS (fmv is checked first)', () => {
    expect(parseValuationInput({ fmvDollars: '4.00', basisDollars: '-2' }))
      .toEqual({ ok: false, error: 'INVALID_BASIS' });
    // both bad -> fmv error wins (validated first)
    expect(parseValuationInput({ fmvDollars: 'x', basisDollars: 'y' }))
      .toEqual({ ok: false, error: 'INVALID_FMV' });
  });
});
