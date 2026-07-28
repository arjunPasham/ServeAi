// v3 donation receipt — pure helpers (Task 3). The IRC 170(e)(3) enhanced-
// deduction math here MIRRORS the SQL in issue_receipt (033); it's used for the
// UI preview + unit tests, while the RPC is the authoritative freeze. No DB
// access. Integer cents throughout. DONATION LANE ONLY — the sale lane never
// reaches here.

export interface ReceiptLineInput {
  fmvPerLbCents: number;
  basisPerLbCents: number;
  estLbs: number;
}

export interface ReceiptTotals {
  fmvTotalCents: number;
  basisTotalCents: number;
  enhancedDeductionCents: number;
}

/**
 * IRC 170(e)(3) enhanced deduction for ONE line, from its snapshot cents:
 *   basis + round(max(0, fmv - basis) / 2), capped at 2 * basis.
 * (basis 0 → cap 0 → 0, the formula's own edge; matches the SQL LEAST(...).)
 */
export function enhancedDeductionForItem(fmvCents: number, basisCents: number): number {
  const appreciation = Math.max(0, fmvCents - basisCents);
  const enhanced = basisCents + Math.round(appreciation / 2);
  return Math.min(enhanced, 2 * basisCents);
}

/**
 * Freeze the receipt totals from the load_items snapshots. Per line the cents
 * are round(perLb * lbs) — identical to declare_load's snapshot math and to
 * issue_receipt's SQL — so the TS preview and the DB freeze always agree.
 */
export function computeReceiptTotals(items: ReceiptLineInput[]): ReceiptTotals {
  let fmvTotalCents = 0;
  let basisTotalCents = 0;
  let enhancedDeductionCents = 0;
  for (const item of items) {
    const fmv = Math.round(item.fmvPerLbCents * item.estLbs);
    const basis = Math.round(item.basisPerLbCents * item.estLbs);
    fmvTotalCents += fmv;
    basisTotalCents += basis;
    enhancedDeductionCents += enhancedDeductionForItem(fmv, basis);
  }
  return { fmvTotalCents, basisTotalCents, enhancedDeductionCents };
}

// The receipt/valuation wording needs CPA/counsel sign-off before real use. This
// flag gates FINALIZATION only — the generator + worksheet still run when it's
// off, marked DRAFT / not-claimable. Absent env = the safe (not-approved) state,
// so this is deliberately NOT a required-in-prod var (its absence never
// fail-opens; it just keeps receipts as worksheets).
export function isReceiptTemplateApproved(): boolean {
  return process.env.RECEIPT_TEMPLATE_APPROVED === 'true';
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface ReceiptWorksheetData {
  merchantName: string;
  recipientName: string;
  windowDate: string;
  issuedAt: string;
  signerName: string | null;
  methodVersion: string;
  templateApproved: boolean;
  totals: ReceiptTotals;
  lines: { foodName: string; categoryLabel: string; estLbs: number; fmvCents: number; basisCents: number }[];
}

export const RECEIPT_DISCLAIMER =
  'Not tax advice. This worksheet estimates a charitable contribution deduction under ' +
  'IRC 170(e)(3) from FoodLink’s recorded values. The merchant’s CPA determines ' +
  'what is actually claimable.';

/**
 * A self-contained HTML worksheet for a donation receipt. Pure (no I/O): the
 * action uploads the returned string to the private bucket. Carries the
 * disclaimer always, and a DRAFT banner until the template is CPA-approved.
 */
export function buildReceiptWorksheetHtml(data: ReceiptWorksheetData): string {
  const t = data.totals;
  const rows = data.lines
    .map(
      l =>
        `<tr><td>${escapeHtml(l.foodName)}</td><td>${escapeHtml(l.categoryLabel)}</td>` +
        `<td class="num">${l.estLbs.toFixed(1)}</td><td class="num">${formatCents(l.fmvCents)}</td>` +
        `<td class="num">${formatCents(l.basisCents)}</td></tr>`
    )
    .join('');

  const draftBanner = data.templateApproved
    ? ''
    : '<p class="draft">DRAFT / WORKSHEET — pending template approval. Not a claimable receipt.</p>';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Donation receipt worksheet</title>
<style>
  body { font-family: system-ui, sans-serif; color: #111; max-width: 640px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 20px; } .num { text-align: right; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
  th, td { border-bottom: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  .totals td { font-weight: 600; border-top: 2px solid #333; }
  .draft { background: #fef3c7; border: 1px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-weight: 600; }
  .disclaimer { color: #555; font-size: 12px; margin-top: 20px; border-top: 1px solid #eee; padding-top: 12px; }
</style></head><body>
${draftBanner}
<h1>Donation receipt worksheet</h1>
<p><strong>Donor (merchant):</strong> ${escapeHtml(data.merchantName)}<br>
<strong>Donee (recipient):</strong> ${escapeHtml(data.recipientName)}<br>
<strong>Window date:</strong> ${escapeHtml(data.windowDate)}<br>
<strong>Issued:</strong> ${escapeHtml(data.issuedAt)}<br>
<strong>Received by:</strong> ${escapeHtml(data.signerName ?? '—')}<br>
<strong>Method version:</strong> ${escapeHtml(data.methodVersion)}</p>
<table>
  <thead><tr><th>Item</th><th>Category</th><th class="num">Lbs</th><th class="num">FMV</th><th class="num">Basis</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot class="totals">
    <tr><td colspan="3">Totals</td><td class="num">${formatCents(t.fmvTotalCents)}</td><td class="num">${formatCents(t.basisTotalCents)}</td></tr>
    <tr><td colspan="4">Enhanced deduction (IRC 170(e)(3))</td><td class="num">${formatCents(t.enhancedDeductionCents)}</td></tr>
  </tfoot>
</table>
<p class="disclaimer">${escapeHtml(RECEIPT_DISCLAIMER)}</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
