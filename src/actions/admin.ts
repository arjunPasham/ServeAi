'use server';

// Ops console actions (Task A — real admin tooling, closes audit I4). Two
// things the pre-pivot admin page never did for real:
//
//   1. An APPEND-ONLY valuation_table editor (appendValuation) — the live
//      replacement for the dead usda_commodity_prices editor. The state
//      transition (a new effective_from row + its audit) lives in the guarded
//      insert_valuation RPC (026_valuation_admin.sql); this action validates
//      input and maps the RPC's typed (message-as-code) errors, exactly the
//      way offerLoad maps offer_load's.
//   2. Read-only visibility into merchants / loads / scans (there was none).
//
// Admin guard: requireAdmin()/assertAdmin() are copied VERBATIM from
// src/actions/allocations.ts (itself copied from the admin page). Every export
// in a 'use server' module is independently reachable as its own HTTP
// endpoint, so each one re-checks the admin role itself — the page-level
// checkAdmin never covers a server action. Reads throw on a DB error OR a
// failed admin check (house rule for a guarded read only reachable from an
// already-gated surface — same as allocations.ts getMatchableLoads). The
// mutating appendValuation instead returns a typed { success:false, error }
// union the console renders — a rejected price entry is an expected outcome,
// not an infra failure.
//
// (A shared authz.requireAdmin would retire this triplicated copy — tracked as
// a Minor, consistent with how the repo has carried the same duplication in
// allocations.ts + both admin pages rather than refactor mid-task.)

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { parseValuationInput, type ValuationRow } from '@/lib/valuation';

// Server actions are HTTP endpoints callable by any authenticated user — each
// one must verify the admin role itself; the page-level check doesn't cover them.
async function requireAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const service = await createServiceClient();
  const { data } = await service
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  return data?.role === 'admin';
}

async function assertAdmin(actionName: string): Promise<void> {
  if (!(await requireAdmin())) {
    throw new Error(`${actionName}: not an admin`);
  }
}

// ─── Valuation catalog (read) ───────────────────────────────────────────────

export interface AdminCategory {
  categoryKey: string;
  label: string;
  temperatureSensitive: boolean;
  safetyWindowHours: number | null;
  sort: number;
}

export interface ValuationCatalog {
  categories: AdminCategory[];
  /** Every valuation row (admin sees basis via the service client, which
   *  bypasses the 026 column restriction). The page derives the current row
   *  per category with currentValuations() so "latest effective" stays
   *  single-sourced in src/lib/valuation.ts. */
  valuations: ValuationRow[];
}

/** The full valuation catalog for the ops editor. Throws on DB error or a failed admin check. */
export async function getValuationCatalog(): Promise<ValuationCatalog> {
  await assertAdmin('getValuationCatalog');

  const service = await createServiceClient();
  const [{ data: cats, error: catError }, { data: vals, error: valError }] = await Promise.all([
    service.from('categories').select('category_key, label, temperature_sensitive, safety_window_hours, sort').order('sort'),
    service.from('valuation_table').select('category_key, fmv_per_lb_cents, basis_per_lb_cents, effective_from').order('effective_from', { ascending: false }),
  ]);
  if (catError) throw new Error(`getValuationCatalog: categories lookup failed: ${catError.message}`);
  if (valError) throw new Error(`getValuationCatalog: valuation_table lookup failed: ${valError.message}`);

  return {
    categories: (cats ?? []).map(c => ({
      categoryKey: c.category_key,
      label: c.label,
      temperatureSensitive: c.temperature_sensitive,
      safetyWindowHours: c.safety_window_hours,
      sort: c.sort,
    })),
    valuations: (vals ?? []).map(v => ({
      categoryKey: v.category_key,
      fmvPerLbCents: v.fmv_per_lb_cents,
      basisPerLbCents: v.basis_per_lb_cents,
      effectiveFrom: v.effective_from,
    })),
  };
}

// ─── Valuation append (mutate) ───────────────────────────────────────────────

export type AppendValuationResult =
  | { success: true }
  | {
      success: false;
      error: 'NOT_ADMIN' | 'INVALID_FMV' | 'INVALID_BASIS' | 'UNKNOWN_CATEGORY' | 'INVALID_VALUATION' | 'SERVER_ERROR';
    };

/**
 * Appends a new valuation_table row for a category (a price change is a new
 * effective_from row — never an edit; see insert_valuation, 026). requireAdmin
 * first, then parse the dollar inputs to integer cents (parseValuationInput),
 * then the guarded RPC. Maps the RPC's typed errors the way offerLoad maps
 * offer_load's.
 */
export async function appendValuation(
  categoryKey: string,
  fmvDollars: string,
  basisDollars: string
): Promise<AppendValuationResult> {
  if (!(await requireAdmin())) return { success: false, error: 'NOT_ADMIN' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_ADMIN' }; // defensive; requireAdmin already implies this

  const parsed = parseValuationInput({ fmvDollars, basisDollars });
  if (!parsed.ok) return { success: false, error: parsed.error };

  const service = await createServiceClient();
  const { data, error } = await service.rpc('insert_valuation', {
    p_category_key: categoryKey,
    p_fmv_per_lb_cents: parsed.fmvPerLbCents,
    p_basis_per_lb_cents: parsed.basisPerLbCents,
    p_created_by: user.id,
  });
  if (error || !data) {
    const msg = error?.message ?? '';
    if (msg.includes('UNKNOWN_CATEGORY')) return { success: false, error: 'UNKNOWN_CATEGORY' };
    if (msg.includes('INVALID_VALUATION')) return { success: false, error: 'INVALID_VALUATION' };
    return { success: false, error: 'SERVER_ERROR' };
  }

  return { success: true };
}

// ─── Read-only ops visibility: merchants / loads / scans ─────────────────────

export interface AdminMerchant {
  id: string;
  businessName: string;
  ein: string | null;
  contactName: string | null;
  phone: string | null;
  address: string;
  plan: string;
  feeCents: number;
  status: string;
  metroId: string;
  createdAt: string;
}

/** All merchants, newest first. Throws on DB error or a failed admin check. */
export async function getAdminMerchants(): Promise<AdminMerchant[]> {
  await assertAdmin('getAdminMerchants');

  const service = await createServiceClient();
  const { data, error } = await service
    .from('merchants')
    .select('id, business_name, ein, contact_name, phone, address, plan, fee_cents, status, metro_id, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getAdminMerchants: merchants lookup failed: ${error.message}`);

  return (data ?? []).map(m => ({
    id: m.id,
    businessName: m.business_name,
    ein: m.ein,
    contactName: m.contact_name,
    phone: m.phone,
    address: m.address,
    plan: m.plan,
    feeCents: m.fee_cents,
    status: m.status,
    metroId: m.metro_id,
    createdAt: m.created_at,
  }));
}

// How many recent rows the loads/scans views show. A read cap, not a data-layer
// limit — the ops console is a monitoring surface, not a report.
const RECENT_ROW_LIMIT = 50;

export interface AdminLoad {
  id: string;
  windowDate: string;
  lane: string;
  status: string;
  earliestSafetyExpiresAt: string | null;
  merchantBusinessName: string;
  itemCount: number;
  createdAt: string;
}

interface AdminLoadRow {
  id: string;
  window_date: string;
  lane: string;
  status: string;
  earliest_safety_expires_at: string | null;
  created_at: string;
  merchants: { business_name: string } | null;
  scan_items: { id: string }[];
}

/** The most recent loads across all merchants, newest first. Throws on DB error or a failed admin check. */
export async function getAdminLoads(): Promise<AdminLoad[]> {
  await assertAdmin('getAdminLoads');

  const service = await createServiceClient();
  const { data, error } = await service
    .from('loads')
    .select<string, AdminLoadRow>(
      'id, window_date, lane, status, earliest_safety_expires_at, created_at, merchants(business_name), scan_items(id)'
    )
    .order('created_at', { ascending: false })
    .limit(RECENT_ROW_LIMIT);
  if (error) throw new Error(`getAdminLoads: loads lookup failed: ${error.message}`);

  return (data ?? []).map(l => ({
    id: l.id,
    windowDate: l.window_date,
    lane: l.lane,
    status: l.status,
    earliestSafetyExpiresAt: l.earliest_safety_expires_at,
    merchantBusinessName: l.merchants?.business_name ?? '—',
    itemCount: l.scan_items.length,
    createdAt: l.created_at,
  }));
}

export interface AdminScan {
  id: string;
  scannedAt: string;
  modelId: string;
  overallConfidence: number;
  needsReview: boolean;
  merchantBusinessName: string;
  itemCount: number;
}

interface AdminScanRow {
  id: string;
  scanned_at: string;
  model_id: string;
  overall_confidence: number;
  needs_review: boolean;
  merchants: { business_name: string } | null;
  scan_items: { id: string }[];
}

/** The most recent scans across all merchants, newest first. Throws on DB error or a failed admin check. */
export async function getAdminScans(): Promise<AdminScan[]> {
  await assertAdmin('getAdminScans');

  const service = await createServiceClient();
  const { data, error } = await service
    .from('scan_records')
    .select<string, AdminScanRow>(
      'id, scanned_at, model_id, overall_confidence, needs_review, merchants(business_name), scan_items(id)'
    )
    .order('scanned_at', { ascending: false })
    .limit(RECENT_ROW_LIMIT);
  if (error) throw new Error(`getAdminScans: scan_records lookup failed: ${error.message}`);

  return (data ?? []).map(s => ({
    id: s.id,
    scannedAt: s.scanned_at,
    modelId: s.model_id,
    overallConfidence: Number(s.overall_confidence),
    needsReview: s.needs_review,
    merchantBusinessName: s.merchants?.business_name ?? '—',
    itemCount: s.scan_items.length,
  }));
}
