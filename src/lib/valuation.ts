// Pure valuation math over versioned valuation_table rows (018).
// All amounts are integer cents; rounding happens once per item line.

export interface ValuationRow {
  categoryKey: string;
  fmvPerLbCents: number;
  basisPerLbCents: number;
  effectiveFrom: string;
}

export interface ItemToValue {
  categoryKey: string;
  estLbs: number;
}

export type ValuationResult =
  | {
      ok: true;
      totalFmvCents: number;
      totalBasisCents: number;
      perItem: { categoryKey: string; estLbs: number; fmvCents: number; basisCents: number }[];
    }
  | { ok: false; missingCategory: string };

/** Latest row per category with effectiveFrom <= now. */
export function currentValuations(rows: ValuationRow[], nowMs: number = Date.now()): Map<string, ValuationRow> {
  const current = new Map<string, ValuationRow>();
  for (const row of rows) {
    const effective = new Date(row.effectiveFrom).getTime();
    if (Number.isNaN(effective) || effective > nowMs) continue;
    const existing = current.get(row.categoryKey);
    if (!existing || effective > new Date(existing.effectiveFrom).getTime()) {
      current.set(row.categoryKey, row);
    }
  }
  return current;
}

export function valueItems(items: ItemToValue[], current: Map<string, ValuationRow>): ValuationResult {
  const perItem: { categoryKey: string; estLbs: number; fmvCents: number; basisCents: number }[] = [];
  let totalFmvCents = 0;
  let totalBasisCents = 0;

  for (const item of items) {
    const row = current.get(item.categoryKey);
    if (!row) return { ok: false, missingCategory: item.categoryKey };
    const fmvCents = Math.round(row.fmvPerLbCents * item.estLbs);
    const basisCents = Math.round(row.basisPerLbCents * item.estLbs);
    perItem.push({ categoryKey: item.categoryKey, estLbs: item.estLbs, fmvCents, basisCents });
    totalFmvCents += fmvCents;
    totalBasisCents += basisCents;
  }
  return { ok: true, totalFmvCents, totalBasisCents, perItem };
}
