'use server';

// Surplus-intelligence reads (Task 1, transition-plan Phase 7). Admin/ops only:
// these query the 028 reporting views (merchant_surplus_patterns,
// export_scan_items) and the dangling-scan set — all SCAN/DECLARE-time supply
// signal, no delivery/receiving outcome. Every export re-checks the admin role
// (each is its own HTTP endpoint); reads throw on DB error or a failed admin
// check (house rule for a guarded read reachable only from an already-gated
// surface — same as allocations.ts / admin.ts).
//
// requireAdmin()/assertAdmin() copied VERBATIM from admin.ts (a shared
// authz.requireAdmin would retire the triplication — tracked minor).

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { DANGLE_WINDOW_DAYS, type SurplusPattern } from '@/lib/reports';

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

export interface MerchantSurplusPattern extends SurplusPattern {
  merchantId: string;
  merchantBusinessName: string;
  categoryKey: string;
  itemCount: number;
  lastSeen: string;
}

/**
 * Ranked surplus patterns across all merchants (optionally one merchant),
 * highest total lbs first — the "~22 lbs of bakery every Monday" signal from
 * merchant_surplus_patterns (028). Throws on DB error or a failed admin check.
 */
export async function getSurplusPatterns(merchantId?: string): Promise<MerchantSurplusPattern[]> {
  await assertAdmin('getSurplusPatterns');

  const service = await createServiceClient();
  let query = service
    .from('merchant_surplus_patterns')
    .select('merchant_id, merchant_business_name, category_key, category_label, local_dow, item_count, distinct_days, total_est_lbs, avg_est_lbs_per_day, last_seen')
    .order('total_est_lbs', { ascending: false });
  if (merchantId) query = query.eq('merchant_id', merchantId);

  const { data, error } = await query;
  if (error) throw new Error(`getSurplusPatterns: merchant_surplus_patterns lookup failed: ${error.message}`);

  return (data ?? []).map(r => ({
    merchantId: r.merchant_id,
    merchantBusinessName: r.merchant_business_name,
    categoryKey: r.category_key,
    categoryLabel: r.category_label,
    localDow: Number(r.local_dow),
    itemCount: Number(r.item_count),
    distinctDays: Number(r.distinct_days),
    totalEstLbs: Number(r.total_est_lbs),
    avgEstLbsPerDay: Number(r.avg_est_lbs_per_day),
    lastSeen: r.last_seen,
  }));
}

export interface ScanItemExportRow {
  merchantId: string;
  merchantBusinessName: string;
  metroId: string;
  scanItemId: string;
  scannedAt: string;
  localScannedOn: string;
  localDow: number;
  categoryKey: string;
  categoryLabel: string;
  foodName: string;
  estLbs: number;
  merchantConfirmed: boolean;
  disposition: string;
  loadId: string | null;
  loadStatus: string | null;
  fmvPerLbCents: number | null;
  basisPerLbCents: number | null;
  estFmvCents: number | null;
}

// A read cap so the export accessor can't accidentally pull the whole table
// into a request. The VIEW itself (028) is the real warehouse surface a future
// pipeline queries directly by service role; this is the app-side accessor.
const EXPORT_ROW_CAP = 5000;

/**
 * Flat per-merchant/day/item export rows from export_scan_items (028), newest
 * first, optionally filtered by merchant and a scanned-at date range. Capped at
 * EXPORT_ROW_CAP. Throws on DB error or a failed admin check.
 */
export async function getScanItemExport(opts?: {
  merchantId?: string;
  since?: string; // ISO
  until?: string; // ISO
}): Promise<ScanItemExportRow[]> {
  await assertAdmin('getScanItemExport');

  const service = await createServiceClient();
  let query = service
    .from('export_scan_items')
    .select('merchant_id, merchant_business_name, metro_id, scan_item_id, scanned_at, local_scanned_on, local_dow, category_key, category_label, food_name, est_lbs, merchant_confirmed, disposition, load_id, load_status, fmv_per_lb_cents, basis_per_lb_cents, est_fmv_cents')
    .order('scanned_at', { ascending: false })
    .limit(EXPORT_ROW_CAP);
  if (opts?.merchantId) query = query.eq('merchant_id', opts.merchantId);
  if (opts?.since) query = query.gte('scanned_at', opts.since);
  if (opts?.until) query = query.lte('scanned_at', opts.until);

  const { data, error } = await query;
  if (error) throw new Error(`getScanItemExport: export_scan_items lookup failed: ${error.message}`);

  return (data ?? []).map(r => ({
    merchantId: r.merchant_id,
    merchantBusinessName: r.merchant_business_name,
    metroId: r.metro_id,
    scanItemId: r.scan_item_id,
    scannedAt: r.scanned_at,
    localScannedOn: r.local_scanned_on,
    localDow: Number(r.local_dow),
    categoryKey: r.category_key,
    categoryLabel: r.category_label,
    foodName: r.food_name,
    estLbs: Number(r.est_lbs),
    merchantConfirmed: r.merchant_confirmed,
    disposition: r.disposition,
    loadId: r.load_id,
    loadStatus: r.load_status,
    fmvPerLbCents: r.fmv_per_lb_cents === null ? null : Number(r.fmv_per_lb_cents),
    basisPerLbCents: r.basis_per_lb_cents === null ? null : Number(r.basis_per_lb_cents),
    estFmvCents: r.est_fmv_cents === null ? null : Number(r.est_fmv_cents),
  }));
}

export interface DanglingScanSummary {
  count: number;
  oldestCreatedAt: string | null;
}

/**
 * How many scans are dangling in 'pending' with no load older than the sweep
 * window (abandoned manifests). Same predicate as the disposition-hygiene sweep;
 * surfaced in the ops console. Throws on DB error or a failed admin check.
 */
export async function getDanglingScanSummary(): Promise<DanglingScanSummary> {
  await assertAdmin('getDanglingScanSummary');

  const service = await createServiceClient();
  const cutoff = new Date(Date.now() - DANGLE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await service
    .from('scan_items')
    .select('created_at')
    .eq('disposition', 'pending')
    .is('load_id', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`getDanglingScanSummary: scan_items lookup failed: ${error.message}`);

  const rows = data ?? [];
  return { count: rows.length, oldestCreatedAt: rows[0]?.created_at ?? null };
}
