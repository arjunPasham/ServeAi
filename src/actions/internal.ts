'use server';

// Internal staff console reads (v3 Task 2). Every export is assertInternalStaff-
// gated (authenticated + admin + email allowlist, re-checked here since each
// 'use server' export is its own endpoint) and throws on DB error. All reads go
// over EXISTING tables/views (loads, deliveries, receipts, scan_records,
// merchants, institutions, allocations, load_items, scan_items) — no new
// pipeline. Read-only; no state changes, so no RPC/audit here.

import { createServiceClient } from '@/lib/supabase/server';
import { assertInternalStaff } from '@/lib/internal-authz';
import { LOAD_STAGES } from '@/lib/loads';

// Cost-per-interaction is DERIVED (scan pipeline does not store Gemini token
// usage — raw_response holds the parsed result, not usageMetadata). Configurable
// per-scan estimate; a labeled assumption when unset. Capturing usageMetadata
// per scan for exact costs is a documented follow-up.
const DEFAULT_COST_PER_SCAN_CENTS = 1;
function costPerScanCents(): { cents: number; configured: boolean } {
  const raw = Number(process.env.MODEL_COST_PER_SCAN_CENTS);
  const configured = Number.isFinite(raw) && raw >= 0;
  return { cents: configured ? raw : DEFAULT_COST_PER_SCAN_CENTS, configured };
}

// ─── Panel A — pipeline health ──────────────────────────────────────────────

export interface PipelineLoad {
  id: string;
  stage: string;
  windowDate: string;
  merchantBusinessName: string;
  recipientOrgName: string | null;
  method: string | null;
  windowBlown: boolean;
  hasDiscrepancy: boolean;
  receiptState: 'none' | 'draft' | 'issued';
  createdAt: string;
}

export interface PipelineHealth {
  stageCounts: Record<string, number>; // TRUE totals across all loads (not capped)
  loads: PipelineLoad[]; // most-recent detail rows, capped at RECENT_ROW_CAP
  loadsCapped: boolean; // the detail list hit the cap (there are older loads not shown; counts still total)
}

interface PipelineLoadRow {
  id: string;
  status: string;
  window_date: string;
  created_at: string;
  merchants: { business_name: string } | null;
  allocations: { status: string; institutions: { org_name: string } | null }[];
  deliveries: { method: string; window_blown: boolean; discrepancy_reason: string | null }[];
  receipts: { template_approved: boolean }[];
}

const RECENT_ROW_CAP = 200; // most-recent detail rows to render (counts are computed separately, uncapped)

/** Every load by stage (true totals) + the most-recent detail rows — the "is the whole flow working" view. Throws on DB error or a failed staff check. */
export async function getPipelineHealth(): Promise<PipelineHealth> {
  await assertInternalStaff('getPipelineHealth');

  const service = await createServiceClient();

  // Stage counts are TRUE totals via server-side COUNT per stage (head:true → no
  // row transfer), so they stay correct beyond the RECENT_ROW_CAP detail list.
  const countResults = await Promise.all(
    LOAD_STAGES.map(async stage => {
      const { count, error } = await service
        .from('loads')
        .select('id', { count: 'exact', head: true })
        .eq('status', stage);
      if (error) throw new Error(`getPipelineHealth: count(${stage}) failed: ${error.message}`);
      return [stage, count ?? 0] as const;
    })
  );
  const stageCounts: Record<string, number> = Object.fromEntries(countResults);

  const { data, error } = await service
    .from('loads')
    .select<string, PipelineLoadRow>(
      `id, status, window_date, created_at,
       merchants(business_name),
       allocations(status, institutions(org_name)),
       deliveries(method, window_blown, discrepancy_reason),
       receipts(template_approved)`
    )
    .order('created_at', { ascending: false })
    .limit(RECENT_ROW_CAP);
  if (error) throw new Error(`getPipelineHealth: loads lookup failed: ${error.message}`);

  const loads: PipelineLoad[] = (data ?? []).map(row => {
    const accepted = row.allocations.find(a => a.status === 'accepted') ?? null;
    const d = row.deliveries[0] ?? null;
    const r = row.receipts[0] ?? null;
    return {
      id: row.id,
      stage: row.status,
      windowDate: row.window_date,
      merchantBusinessName: row.merchants?.business_name ?? '—',
      recipientOrgName: accepted?.institutions?.org_name ?? null,
      method: d?.method ?? null,
      windowBlown: d?.window_blown ?? false,
      hasDiscrepancy: d?.discrepancy_reason != null,
      receiptState: r ? (r.template_approved ? 'issued' : 'draft') : 'none',
      createdAt: row.created_at,
    };
  });
  return { stageCounts, loads, loadsCapped: loads.length >= RECENT_ROW_CAP };
}

// ─── Panel B — unit economics (read-only) ─────────────────────────────────────

export interface UnitEconomics {
  scanCount: number;
  merchantCount: number;
  avgScansPerMerchant: number;
  topMerchants: { merchantId: string; scanCount: number }[];
  receiptsIssued: number;
  deliveryCount: number;
  windowBlownCount: number;
  windowBlownRate: number; // 0..1
  costPerScanCents: number;
  costConfigured: boolean;
  estimatedScanCostCents: number;
}

const SCAN_SAMPLE_CAP = 5000; // per-merchant tally reads only the merchant_id column

/** Aggregate metrics for the pilot. Throws on DB error or a failed staff check. */
export async function getUnitEconomics(): Promise<UnitEconomics> {
  await assertInternalStaff('getUnitEconomics');
  const service = await createServiceClient();

  const [{ count: scanCount, error: scanErr }, { count: merchantCount, error: merchErr }, { count: receiptsIssued, error: rcptErr }, { data: scanRows, error: scanRowsErr }, { data: deliveries, error: delErr }] =
    await Promise.all([
      service.from('scan_records').select('id', { count: 'exact', head: true }),
      service.from('merchants').select('id', { count: 'exact', head: true }),
      service.from('receipts').select('id', { count: 'exact', head: true }),
      service.from('scan_records').select('merchant_id').limit(SCAN_SAMPLE_CAP),
      service.from('deliveries').select('window_blown'),
    ]);
  if (scanErr) throw new Error(`getUnitEconomics: scan count failed: ${scanErr.message}`);
  if (merchErr) throw new Error(`getUnitEconomics: merchant count failed: ${merchErr.message}`);
  if (rcptErr) throw new Error(`getUnitEconomics: receipt count failed: ${rcptErr.message}`);
  if (scanRowsErr) throw new Error(`getUnitEconomics: scan sample failed: ${scanRowsErr.message}`);
  if (delErr) throw new Error(`getUnitEconomics: deliveries lookup failed: ${delErr.message}`);

  const perMerchant = new Map<string, number>();
  for (const row of scanRows ?? []) {
    const id = row.merchant_id as string;
    perMerchant.set(id, (perMerchant.get(id) ?? 0) + 1);
  }
  const topMerchants = [...perMerchant.entries()]
    .map(([merchantId, c]) => ({ merchantId, scanCount: c }))
    .sort((a, b) => b.scanCount - a.scanCount)
    .slice(0, 10);

  const deliveryCount = (deliveries ?? []).length;
  const windowBlownCount = (deliveries ?? []).filter(d => d.window_blown === true).length;
  const { cents, configured } = costPerScanCents();
  const scans = scanCount ?? 0;
  const merchants = merchantCount ?? 0;

  return {
    scanCount: scans,
    merchantCount: merchants,
    avgScansPerMerchant: merchants > 0 ? Math.round((scans / merchants) * 10) / 10 : 0,
    topMerchants,
    receiptsIssued: receiptsIssued ?? 0,
    deliveryCount,
    windowBlownCount,
    windowBlownRate: deliveryCount > 0 ? windowBlownCount / deliveryCount : 0,
    costPerScanCents: cents,
    costConfigured: configured,
    estimatedScanCostCents: scans * cents,
  };
}

// ─── Panel C — legal handoff (DRAFT receipts + delivery/confirm records) ──────

export interface LegalHandoffRow {
  receiptId: string;
  loadId: string;
  issuedAt: string;
  merchantBusinessName: string;
  recipientOrgName: string;
  signerName: string | null;
  fmvTotalCents: number;
  basisTotalCents: number;
  enhancedDeductionCents: number;
  methodVersion: string;
  templateApproved: boolean;
  pdfKey: string | null;
}

interface LegalHandoffListRow {
  id: string;
  load_id: string;
  issued_at: string;
  signer_name: string | null;
  fmv_total_cents: number;
  basis_total_cents: number;
  enhanced_deduction_cents: number;
  method_version: string;
  template_approved: boolean;
  pdf_key: string | null;
  merchants: { business_name: string } | null;
  institutions: { org_name: string } | null;
}

/** All donation receipts (DRAFT + issued), newest first, for CPA/counsel review. Throws on DB error or a failed staff check. */
export async function getLegalHandoffList(): Promise<LegalHandoffRow[]> {
  await assertInternalStaff('getLegalHandoffList');
  const service = await createServiceClient();
  const { data, error } = await service
    .from('receipts')
    .select<string, LegalHandoffListRow>(
      `id, load_id, issued_at, signer_name, fmv_total_cents, basis_total_cents, enhanced_deduction_cents, method_version, template_approved, pdf_key,
       merchants(business_name), institutions(org_name)`
    )
    .order('issued_at', { ascending: false })
    .limit(RECENT_ROW_CAP);
  if (error) throw new Error(`getLegalHandoffList: receipts lookup failed: ${error.message}`);

  return (data ?? []).map(r => ({
    receiptId: r.id,
    loadId: r.load_id,
    issuedAt: r.issued_at,
    merchantBusinessName: r.merchants?.business_name ?? '—',
    recipientOrgName: r.institutions?.org_name ?? '—',
    signerName: r.signer_name,
    fmvTotalCents: Number(r.fmv_total_cents),
    basisTotalCents: Number(r.basis_total_cents),
    enhancedDeductionCents: Number(r.enhanced_deduction_cents),
    methodVersion: r.method_version,
    templateApproved: r.template_approved,
    pdfKey: r.pdf_key,
  }));
}

export interface LegalHandoffDetail {
  header: LegalHandoffRow;
  windowDate: string;
  lines: { foodName: string; categoryLabel: string; estLbs: number; fmvCents: number; basisCents: number }[];
  delivery: {
    method: string;
    responsibleParty: string;
    pickedUpAt: string | null;
    deliveredAt: string | null;
    acknowledgedAt: string | null;
    windowBlown: boolean;
    discrepancyReason: string | null;
  } | null;
}

interface HandoffDetailReceiptRow extends LegalHandoffListRow {
  merchant_id: string;
  recipient_id: string;
}

interface HandoffLoadRow {
  window_date: string;
  load_items: {
    est_lbs: number;
    fmv_per_lb_cents: number;
    basis_per_lb_cents: number;
    scan_items: { food_name: string; categories: { label: string } | null } | null;
  }[];
  deliveries: {
    method: string;
    responsible_party: string;
    picked_up_at: string | null;
    delivered_at: string | null;
    acknowledged_at: string | null;
    window_blown: boolean;
    discrepancy_reason: string | null;
  }[];
}

/** One receipt's full worksheet data + delivery/confirm record. Returns null for an unknown id. Throws on DB error or a failed staff check. */
export async function getLegalHandoffDetail(receiptId: string): Promise<LegalHandoffDetail | null> {
  await assertInternalStaff('getLegalHandoffDetail');
  const service = await createServiceClient();

  const { data: receipt, error: rErr } = await service
    .from('receipts')
    .select<string, HandoffDetailReceiptRow>(
      `id, load_id, merchant_id, recipient_id, issued_at, signer_name, fmv_total_cents, basis_total_cents, enhanced_deduction_cents, method_version, template_approved, pdf_key,
       merchants(business_name), institutions(org_name)`
    )
    .eq('id', receiptId)
    .maybeSingle();
  if (rErr) throw new Error(`getLegalHandoffDetail: receipt lookup failed: ${rErr.message}`);
  if (!receipt) return null;

  const { data: load, error: lErr } = await service
    .from('loads')
    .select<string, HandoffLoadRow>(
      `window_date,
       load_items(est_lbs, fmv_per_lb_cents, basis_per_lb_cents,
                  scan_items(food_name, categories!scan_items_category_key_fkey(label))),
       deliveries(method, responsible_party, picked_up_at, delivered_at, acknowledged_at, window_blown, discrepancy_reason)`
    )
    .eq('id', receipt.load_id)
    .maybeSingle();
  if (lErr) throw new Error(`getLegalHandoffDetail: load lookup failed: ${lErr.message}`);

  const d = load?.deliveries[0] ?? null;
  return {
    header: {
      receiptId: receipt.id,
      loadId: receipt.load_id,
      issuedAt: receipt.issued_at,
      merchantBusinessName: receipt.merchants?.business_name ?? '—',
      recipientOrgName: receipt.institutions?.org_name ?? '—',
      signerName: receipt.signer_name,
      fmvTotalCents: Number(receipt.fmv_total_cents),
      basisTotalCents: Number(receipt.basis_total_cents),
      enhancedDeductionCents: Number(receipt.enhanced_deduction_cents),
      methodVersion: receipt.method_version,
      templateApproved: receipt.template_approved,
      pdfKey: receipt.pdf_key,
    },
    windowDate: load?.window_date ?? '',
    lines: (load?.load_items ?? []).map(li => ({
      foodName: li.scan_items?.food_name ?? '—',
      categoryLabel: li.scan_items?.categories?.label ?? '—',
      estLbs: Number(li.est_lbs),
      fmvCents: Math.round(li.fmv_per_lb_cents * Number(li.est_lbs)),
      basisCents: Math.round(li.basis_per_lb_cents * Number(li.est_lbs)),
    })),
    delivery: d
      ? {
          method: d.method,
          responsibleParty: d.responsible_party,
          pickedUpAt: d.picked_up_at,
          deliveredAt: d.delivered_at,
          acknowledgedAt: d.acknowledged_at,
          windowBlown: d.window_blown,
          discrepancyReason: d.discrepancy_reason,
        }
      : null,
  };
}
