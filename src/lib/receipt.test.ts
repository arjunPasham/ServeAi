import { describe, expect, test } from 'vitest';
import {
  enhancedDeductionForItem,
  computeReceiptTotals,
  buildReceiptWorksheetHtml,
  type ReceiptWorksheetData,
} from './receipt';

describe('enhancedDeductionForItem (IRC 170(e)(3))', () => {
  test('appreciated item: basis + half the appreciation', () => {
    // fmv 1000, basis 400 → 400 + round(600/2)=300 → 700; cap 2*400=800 → 700
    expect(enhancedDeductionForItem(1000, 400)).toBe(700);
  });
  test('capped at twice basis for a highly appreciated item', () => {
    // fmv 2000, basis 400 → 400 + round(1600/2)=800 → 1200; cap 800 → 800
    expect(enhancedDeductionForItem(2000, 400)).toBe(800);
  });
  test('no appreciation (fmv <= basis) → basis', () => {
    expect(enhancedDeductionForItem(300, 400)).toBe(400); // 400 + 0, cap 800
    expect(enhancedDeductionForItem(400, 400)).toBe(400);
  });
  test('zero basis → zero (the formula’s 2*basis cap edge)', () => {
    expect(enhancedDeductionForItem(999, 0)).toBe(0);
  });
});

describe('computeReceiptTotals', () => {
  test('sums per-line snapshot cents and the enhanced deduction', () => {
    // line A: fmv 499*5=2495, basis 150*5=750 → enh 750+round(1745/2)=750+873=1623; cap 1500 → 1500
    // line B: fmv 299*2=598,  basis 85*2=170  → enh 170+round(428/2)=170+214=384; cap 340 → 340
    const totals = computeReceiptTotals([
      { fmvPerLbCents: 499, basisPerLbCents: 150, estLbs: 5 },
      { fmvPerLbCents: 299, basisPerLbCents: 85, estLbs: 2 },
    ]);
    expect(totals.fmvTotalCents).toBe(2495 + 598);
    expect(totals.basisTotalCents).toBe(750 + 170);
    expect(totals.enhancedDeductionCents).toBe(1500 + 340);
  });
  test('empty load → all zero', () => {
    expect(computeReceiptTotals([])).toEqual({ fmvTotalCents: 0, basisTotalCents: 0, enhancedDeductionCents: 0 });
  });
});

describe('buildReceiptWorksheetHtml', () => {
  const base: ReceiptWorksheetData = {
    merchantName: 'Bella Deli',
    recipientName: 'Shelter House',
    windowDate: '2026-07-28',
    issuedAt: '2026-07-28T18:00:00Z',
    signerName: 'Maria Lopez',
    methodVersion: '170e3-v1',
    templateApproved: false,
    totals: { fmvTotalCents: 3093, basisTotalCents: 920, enhancedDeductionCents: 1840 },
    lines: [{ foodName: 'Rolls', categoryLabel: 'Bakery & desserts', estLbs: 5, fmvCents: 2495, basisCents: 750 }],
  };

  test('always carries the not-tax-advice disclaimer and the totals', () => {
    const html = buildReceiptWorksheetHtml(base);
    expect(html).toContain('Not tax advice');
    expect(html).toContain("merchant’s CPA determines");
    expect(html).toContain('$30.93'); // fmv total
    expect(html).toContain('$18.40'); // enhanced deduction
    expect(html).toContain('Bella Deli');
  });
  test('shows a DRAFT banner until the template is approved', () => {
    expect(buildReceiptWorksheetHtml(base)).toContain('DRAFT');
    expect(buildReceiptWorksheetHtml({ ...base, templateApproved: true })).not.toContain('DRAFT');
  });
  test('escapes HTML in user-supplied names', () => {
    const html = buildReceiptWorksheetHtml({ ...base, merchantName: '<script>x</script>' });
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
  });
});
