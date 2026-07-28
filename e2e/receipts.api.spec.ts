// v3 donation receipt (Task 3) — issue_receipt / set_receipt_pdf RPC invariants
// (033_receipts.sql). Exercises the RPCs directly against the dev DB. The
// 170(e)(3) math is also unit-tested in src/lib/receipt.test.ts; here we verify
// the RPC freezes totals matching the load_items snapshot, and that the four
// hard gates hold. DONATION LANE ONLY.
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createTestUser,
  createMerchant,
  createDeclaredLoad,
  createInstitution,
  cleanup,
  type TestContext,
} from './helpers';

let ctx: TestContext;
const service = getServiceClient();

// 170(e)(3) per line, mirroring the RPC + src/lib/receipt.ts.
function enhanced(fmv: number, basis: number): number {
  return Math.min(basis + Math.round(Math.max(0, fmv - basis) / 2), 2 * basis);
}

// A donation load driven to delivered + recipient-confirmed, with a verified
// donee — the precondition issue_receipt requires. `confirm=false` stops at a
// mark_delivered (no acknowledgment) to exercise the NOT_CONFIRMED gate.
async function deliveredLoad(
  label: string,
  opts: { npoVerified?: boolean; confirm?: boolean } = {}
): Promise<{ loadId: string; institutionId: string }> {
  const npoVerified = opts.npoVerified ?? true;
  const confirm = opts.confirm ?? true;
  const user = await createTestUser(ctx, 'donor', { emailLabel: label });
  const { merchantId } = await createMerchant(ctx, user.id);
  const { loadId } = await createDeclaredLoad(ctx, {
    merchantId, scannedBy: user.id,
    items: [
      { categoryKey: 'BAKERY', foodName: 'Rolls', estLbs: 5 },
      { categoryKey: 'DAIRY', foodName: 'Milk', estLbs: 2 },
    ],
  });
  const { institutionId } = await createInstitution(ctx, { orgName: `E2E Receipt ${ctx.runId} ${label}`, npoVerified });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data: alloc, error: oErr } = await service.rpc('offer_load', {
    p_load_id: loadId, p_institution_id: institutionId, p_offered_by: user.id, p_expires_at: expiresAt,
  });
  if (oErr || !alloc) throw new Error(`offer_load: ${oErr?.message}`);
  await service.rpc('respond_to_offer', { p_allocation_id: alloc.id, p_decision: 'accepted', p_actor: null, p_decline_reason: null });
  await service.rpc('set_delivery_method', {
    p_load_id: loadId, p_merchant_id: merchantId, p_allocation_id: alloc.id,
    p_method: 'pickup', p_responsible_party: 'recipient', p_notes: null, p_actor: user.id,
  });
  if (confirm) {
    await service.rpc('recipient_confirm_delivery', {
      p_allocation_id: alloc.id, p_signer_name: 'Maria', p_discrepancy_reason: null,
      p_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), p_actor: null,
    });
  } else {
    // Delivered, but NOT recipient-confirmed (no acknowledged_at).
    await service.rpc('mark_delivered', { p_load_id: loadId, p_merchant_id: merchantId, p_actor: user.id });
  }
  return { loadId, institutionId };
}

test.describe('donation receipt RPCs', () => {
  test.beforeAll(() => { ctx = newContext('receipt'); });
  test.afterAll(async () => { await cleanup(ctx); });

  test('issue_receipt freezes 170(e)(3) totals from the snapshot; set_receipt_pdf attaches the key; re-issue is rejected', async () => {
    const { loadId } = await deliveredLoad('happy');

    // Expected totals from the frozen load_items snapshot (not the live table).
    const { data: items } = await service
      .from('load_items').select('fmv_per_lb_cents, basis_per_lb_cents, est_lbs').eq('load_id', loadId);
    let expFmv = 0, expBasis = 0, expEnh = 0;
    for (const li of items!) {
      const f = Math.round(li.fmv_per_lb_cents * Number(li.est_lbs));
      const b = Math.round(li.basis_per_lb_cents * Number(li.est_lbs));
      expFmv += f; expBasis += b; expEnh += enhanced(f, b);
    }

    const { data: receipt, error } = await service.rpc('issue_receipt', {
      p_load_id: loadId, p_method_version: '170e3-v1', p_template_approved: false, p_actor: null,
    });
    expect(error).toBeNull();
    expect(receipt.fmv_total_cents).toBe(expFmv);
    expect(receipt.basis_total_cents).toBe(expBasis);
    expect(receipt.enhanced_deduction_cents).toBe(expEnh);
    expect(receipt.template_approved).toBe(false);
    expect(receipt.signer_name).toBe('Maria'); // copied from the confirm
    expect(receipt.pdf_key).toBeNull();

    const { data: withPdf, error: pdfErr } = await service.rpc('set_receipt_pdf', {
      p_receipt_id: receipt.id, p_pdf_key: `receipts/${receipt.id}.html`, p_actor: null,
    });
    expect(pdfErr).toBeNull();
    expect(withPdf.pdf_key).toBe(`receipts/${receipt.id}.html`);

    // One receipt per load.
    const { error: dupErr } = await service.rpc('issue_receipt', {
      p_load_id: loadId, p_method_version: '170e3-v1', p_template_approved: false, p_actor: null,
    });
    expect(dupErr?.message).toContain('ALREADY_ISSUED');
  });

  test('rejects the sale lane (a discounted sale is recovered revenue, not a gift)', async () => {
    const { loadId } = await deliveredLoad('sale');
    await service.from('loads').update({ lane: 'sale' }).eq('id', loadId);
    const { error } = await service.rpc('issue_receipt', {
      p_load_id: loadId, p_method_version: '170e3-v1', p_template_approved: false, p_actor: null,
    });
    expect(error?.message).toContain('NOT_DONATION_LANE');
  });

  test('rejects a delivered-but-not-confirmed load', async () => {
    const { loadId } = await deliveredLoad('notconfirmed', { confirm: false });
    const { error } = await service.rpc('issue_receipt', {
      p_load_id: loadId, p_method_version: '170e3-v1', p_template_approved: false, p_actor: null,
    });
    expect(error?.message).toContain('NOT_CONFIRMED');
  });

  test('rejects an unverified donee', async () => {
    const { loadId, institutionId } = await deliveredLoad('unverified');
    // Offer required npo_verified; un-verify AFTER the flow to isolate the gate.
    await service.from('institutions').update({ npo_verified: false }).eq('id', institutionId);
    const { error } = await service.rpc('issue_receipt', {
      p_load_id: loadId, p_method_version: '170e3-v1', p_template_approved: false, p_actor: null,
    });
    expect(error?.message).toContain('DONEE_NOT_VERIFIED');
  });
});
