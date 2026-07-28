'use server';

// v3 donation-receipt actions (Task 3, DONATION LANE ONLY). Ops issues a receipt
// for a delivered + recipient-confirmed donation load; the guarded issue_receipt
// RPC (033) freezes the 170(e)(3) totals from the load_items snapshots, then we
// generate the worksheet + record its key via set_receipt_pdf.
//
// requireAdmin()/assertAdmin() copied VERBATIM from admin.ts (tracked minor: a
// shared authz.requireAdmin would retire the duplication). Reads throw on DB/authz
// error; the mutator returns a typed union the ops UI renders.

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { buildReceiptWorksheetHtml, isReceiptTemplateApproved, type ReceiptWorksheetData } from '@/lib/receipt';

const METHOD_VERSION = '170e3-v1';

async function requireAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const service = await createServiceClient();
  const { data } = await service.from('users').select('role').eq('id', user.id).single();
  return data?.role === 'admin';
}

async function assertAdmin(actionName: string): Promise<void> {
  if (!(await requireAdmin())) throw new Error(`${actionName}: not an admin`);
}

export interface AdminReceipt {
  id: string;
  loadId: string;
  issuedAt: string;
  signerName: string | null;
  fmvTotalCents: number;
  basisTotalCents: number;
  enhancedDeductionCents: number;
  methodVersion: string;
  templateApproved: boolean;
  pdfKey: string | null;
}

/** The receipt for a load (or null). Throws on DB error or a failed admin check. */
export async function getReceiptForLoad(loadId: string): Promise<AdminReceipt | null> {
  await assertAdmin('getReceiptForLoad');
  const service = await createServiceClient();
  const { data, error } = await service
    .from('receipts')
    .select('id, load_id, issued_at, signer_name, fmv_total_cents, basis_total_cents, enhanced_deduction_cents, method_version, template_approved, pdf_key')
    .eq('load_id', loadId)
    .maybeSingle();
  if (error) throw new Error(`getReceiptForLoad: receipts lookup failed: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    loadId: data.load_id,
    issuedAt: data.issued_at,
    signerName: data.signer_name,
    fmvTotalCents: Number(data.fmv_total_cents),
    basisTotalCents: Number(data.basis_total_cents),
    enhancedDeductionCents: Number(data.enhanced_deduction_cents),
    methodVersion: data.method_version,
    templateApproved: data.template_approved,
    pdfKey: data.pdf_key,
  };
}

export type IssueReceiptResult =
  | { success: true; receiptId: string; templateApproved: boolean; pdfKey: string | null }
  | {
      success: false;
      error:
        | 'NOT_ADMIN'
        | 'LOAD_NOT_FOUND'
        | 'NOT_DONATION_LANE'
        | 'NOT_DELIVERED'
        | 'NOT_CONFIRMED'
        | 'DONEE_NOT_VERIFIED'
        | 'ALREADY_ISSUED'
        | 'EMPTY_LOAD'
        | 'SERVER_ERROR';
    };

interface WorksheetContextRow {
  window_date: string;
  merchants: { business_name: string } | null;
  load_items: {
    est_lbs: number;
    fmv_per_lb_cents: number;
    basis_per_lb_cents: number;
    scan_items: { food_name: string; categories: { label: string } | null } | null;
  }[];
}

/**
 * Issues a donation receipt for a delivered + confirmed donation load: freezes
 * the 170(e)(3) totals via issue_receipt, generates the worksheet, uploads it to
 * the private bucket (dev-mode-simulated when RECEIPT_BUCKET is unset), and
 * records the key. Admin only. Finalization (template_approved) follows the
 * RECEIPT_TEMPLATE_APPROVED flag — off = a DRAFT worksheet, not a claimable receipt.
 */
export async function issueDonationReceipt(loadId: string): Promise<IssueReceiptResult> {
  if (!(await requireAdmin())) return { success: false, error: 'NOT_ADMIN' };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_ADMIN' };

  const service = await createServiceClient();
  const templateApproved = isReceiptTemplateApproved();

  const { data: receipt, error } = await service.rpc('issue_receipt', {
    p_load_id: loadId,
    p_method_version: METHOD_VERSION,
    p_template_approved: templateApproved,
    p_actor: user.id,
  });
  if (error || !receipt) {
    const msg = error?.message ?? '';
    for (const code of ['LOAD_NOT_FOUND', 'NOT_DONATION_LANE', 'NOT_DELIVERED', 'NOT_CONFIRMED', 'DONEE_NOT_VERIFIED', 'ALREADY_ISSUED', 'EMPTY_LOAD'] as const) {
      if (msg.includes(code)) return { success: false, error: code };
    }
    return { success: false, error: 'SERVER_ERROR' };
  }

  // Generate + store the worksheet (best-effort; the frozen receipt already
  // committed). Fetch the display context (names + item breakdown).
  let pdfKey: string | null = null;
  try {
    const { data: ctx } = await service
      .from('loads')
      .select<string, WorksheetContextRow>(
        `window_date, merchants(business_name),
         load_items(est_lbs, fmv_per_lb_cents, basis_per_lb_cents,
                    scan_items(food_name, categories!scan_items_category_key_fkey(label)))`
      )
      .eq('id', loadId)
      .maybeSingle();
    const { data: recipient } = await service
      .from('institutions').select('org_name').eq('id', receipt.recipient_id).maybeSingle();

    const worksheet: ReceiptWorksheetData = {
      merchantName: ctx?.merchants?.business_name ?? '—',
      recipientName: recipient?.org_name ?? '—',
      windowDate: ctx?.window_date ?? '',
      issuedAt: receipt.issued_at,
      signerName: receipt.signer_name,
      methodVersion: receipt.method_version,
      templateApproved,
      totals: {
        fmvTotalCents: Number(receipt.fmv_total_cents),
        basisTotalCents: Number(receipt.basis_total_cents),
        enhancedDeductionCents: Number(receipt.enhanced_deduction_cents),
      },
      lines: (ctx?.load_items ?? []).map(li => ({
        foodName: li.scan_items?.food_name ?? '—',
        categoryLabel: li.scan_items?.categories?.label ?? '—',
        estLbs: Number(li.est_lbs),
        fmvCents: Math.round(li.fmv_per_lb_cents * Number(li.est_lbs)),
        basisCents: Math.round(li.basis_per_lb_cents * Number(li.est_lbs)),
      })),
    };

    const html = buildReceiptWorksheetHtml(worksheet);
    pdfKey = await uploadReceiptWorksheet(service, receipt.id, html);
    await service.rpc('set_receipt_pdf', { p_receipt_id: receipt.id, p_pdf_key: pdfKey, p_actor: user.id });
  } catch (err) {
    console.error('[issueDonationReceipt] worksheet generation failed (receipt totals are still frozen):', err);
  }

  return { success: true, receiptId: receipt.id, templateApproved, pdfKey };
}

// Uploads the worksheet to the private RECEIPT_BUCKET; dev-mode-simulated (no
// real upload, synthetic key) when the bucket env is unset — the isStripeDevMode
// pattern applied to storage.
async function uploadReceiptWorksheet(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  receiptId: string,
  html: string
): Promise<string | null> {
  const bucket = process.env.RECEIPT_BUCKET;
  const path = `receipts/${receiptId}.html`;
  if (!bucket) {
    console.log(`[DEV] Simulated receipt worksheet ${path} (${html.length} bytes) — RECEIPT_BUCKET unset`);
    return path;
  }
  const { error } = await service.storage
    .from(bucket)
    .upload(path, Buffer.from(html), { contentType: 'text/html', upsert: true });
  if (error) {
    console.error('[issueDonationReceipt] worksheet upload failed:', error.message);
    return null;
  }
  return path;
}
