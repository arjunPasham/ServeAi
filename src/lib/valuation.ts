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

export type ParsedValuationInput =
  | { ok: true; fmvPerLbCents: number; basisPerLbCents: number }
  | { ok: false; error: 'INVALID_FMV' | 'INVALID_BASIS' };

/**
 * Parses the ops valuation-editor form (dollar strings) into non-negative
 * integer cents, rounding to the nearest cent. Pure — the append action calls
 * this before insert_valuation so a bad entry never reaches the RPC, and the
 * RPC's own >= 0 guard is the DB-side backstop. fmv is validated first, so a
 * form with both fields bad reports INVALID_FMV.
 */
export function parseValuationInput(raw: { fmvDollars: string; basisDollars: string }): ParsedValuationInput {
  const fmv = dollarsToCents(raw.fmvDollars);
  if (fmv === null) return { ok: false, error: 'INVALID_FMV' };
  const basis = dollarsToCents(raw.basisDollars);
  if (basis === null) return { ok: false, error: 'INVALID_BASIS' };
  return { ok: true, fmvPerLbCents: fmv, basisPerLbCents: basis };
}

/** A finite, non-negative dollar string → integer cents, else null. An empty string parses to 0 under Number(), so guard it explicitly. */
function dollarsToCents(raw: string): number | null {
  if (raw.trim() === '') return null;
  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
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
