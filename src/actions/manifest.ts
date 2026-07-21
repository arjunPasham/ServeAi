'use server';

// Merchant manifest actions (Phase 1/2 pivot): confirm the AI's manifest,
// close out removed items, and declare tonight's load atomically via the
// confirm_and_declare RPC (024). All writes go through the service client;
// merchant identity is enforced here (requireVerifiedMerchant); the RPC
// re-checks scan-record ownership and item eligibility, and folds the
// write-then-declare sequence into one transaction.

import { createServiceClient } from '@/lib/supabase/server';
import { requireVerifiedMerchant, type RequireVerifiedMerchantResult } from '@/lib/authz';
import { computeSafetyExpiry } from '@/lib/safety-window';
import { currentValuations, type ValuationRow } from '@/lib/valuation';
import { isValidCalendarDate } from '@/lib/dates';
import { reportError } from '@/lib/report-error';

export interface ManifestItemInput {
  scanItemId: string | null; // null = merchant added an item the AI missed
  foodName: string;
  categoryKey: string;
  estLbs: number;
  preparedAt: string | null; // ISO; required when the category is TCS
}

export type ConfirmManifestResult =
  | { success: true; loadId: string }
  | { success: false; error: string };

export interface CategoryOption {
  categoryKey: string;
  label: string;
  temperatureSensitive: boolean;
  safetyWindowHours: number | null;
  fmvPerLbCents: number;
  basisPerLbCents: number;
}

export async function getMerchantContext(): Promise<{ merchantId: string; businessName: string } | null> {
  // Authenticated + phone-verified + owns a merchants row. An authz failure
  // returns null so the caller redirects; an infra error throws (guard).
  const authz = await requireVerifiedMerchant();
  if (!authz.ok) return null;
  return { merchantId: authz.merchant.merchantId, businessName: authz.merchant.businessName };
}

export async function getCategoriesWithValuations(): Promise<CategoryOption[]> {
  // Merchant-facing read (feeds the manifest editor): gate it too. Authz
  // failure throws — this action is only reachable from the verified-merchant
  // scan flow, so the scan UI's catch surfacing "couldn't load" is acceptable.
  const authz = await requireVerifiedMerchant();
  if (!authz.ok) throw new Error(`getCategoriesWithValuations: not a verified merchant (${authz.error})`);

  const service = await createServiceClient();

  const [{ data: cats, error: catError }, { data: vals, error: valError }] = await Promise.all([
    service.from('categories').select('category_key, label, temperature_sensitive, safety_window_hours, sort').order('sort'),
    service.from('valuation_table').select('category_key, fmv_per_lb_cents, basis_per_lb_cents, effective_from'),
  ]);
  // Same reasoning as getMerchantContext/getMerchantDashboard: a DB outage
  // must not present as "no categories" — throw so it surfaces via the error
  // boundary instead of silently rendering an empty manifest UI.
  if (catError) throw new Error(`getCategoriesWithValuations: categories lookup failed: ${catError.message}`);
  if (valError) throw new Error(`getCategoriesWithValuations: valuation_table lookup failed: ${valError.message}`);

  const rows: ValuationRow[] = (vals ?? []).map(v => ({
    categoryKey: v.category_key,
    fmvPerLbCents: v.fmv_per_lb_cents,
    basisPerLbCents: v.basis_per_lb_cents,
    effectiveFrom: v.effective_from,
  }));
  const current = currentValuations(rows);

  return (cats ?? [])
    .filter(c => current.has(c.category_key))
    .map(c => ({
      categoryKey: c.category_key,
      label: c.label,
      temperatureSensitive: c.temperature_sensitive,
      safetyWindowHours: c.safety_window_hours,
      fmvPerLbCents: current.get(c.category_key)!.fmvPerLbCents,
      basisPerLbCents: current.get(c.category_key)!.basisPerLbCents,
    }));
}

export async function confirmManifest(params: {
  scanRecordId: string;
  windowDate: string; // YYYY-MM-DD
  items: ManifestItemInput[];
}): Promise<ConfirmManifestResult> {
  // merchantId is unknown until authz resolves; held in a mutable field
  // (rather than a reassigned `let`) so `fail` below can close over it while
  // it's still `const` from ESLint's point of view.
  const ctx: { merchantId: string | undefined } = { merchantId: undefined };

  // Every failure exit in this action goes through here (review I7:
  // confirmManifest previously had zero logging, so a 2am declare failure
  // left no trace anywhere). Logs merchantId/scanRecordId/windowDate, the
  // typed error code returned to the caller, and the underlying
  // supabase/thrown error where one is present — mirrors the persist-failure
  // log style at src/app/api/scan/route.ts. Does not change the return
  // contract: every call site returns exactly what it returned before.
  function fail(error: string, underlyingError?: unknown): ConfirmManifestResult {
    const underlying =
      underlyingError == null
        ? undefined
        : (underlyingError as { message?: string }).message ?? String(underlyingError);
    reportError('[manifest] confirmManifest failed', {
      merchantId: ctx.merchantId,
      scanRecordId: params.scanRecordId,
      windowDate: params.windowDate,
      error,
      ...(underlying !== undefined ? { underlyingError: underlying } : {}),
    });
    return { success: false, error };
  }

  // Gate on the full invariant (authenticated + phone-verified + merchant).
  // An infra error from the guard maps to SERVER_ERROR to preserve this
  // action's typed-result contract (the guard throws on DB outage).
  let authz: RequireVerifiedMerchantResult;
  try {
    authz = await requireVerifiedMerchant();
  } catch (err) {
    return fail('SERVER_ERROR', err);
  }
  if (!authz.ok) return fail(authz.error);
  const merchantId = authz.merchant.merchantId;
  ctx.merchantId = merchantId;

  if (!params.items.length) return fail('EMPTY_MANIFEST');
  if (!isValidCalendarDate(params.windowDate)) {
    return fail('INVALID_WINDOW_DATE');
  }

  const service = await createServiceClient();

  // Category lookup (also validates every key). Ownership of the scan record
  // and eligibility of each scan_item_id are re-checked by confirm_and_declare
  // itself (SCAN_NOT_FOUND / ITEM_NOT_IN_SCAN) — no need to duplicate those
  // reads here before the RPC call.
  const keys = [...new Set(params.items.map(i => i.categoryKey))];
  const { data: cats, error: catError } = await service
    .from('categories')
    .select('category_key, temperature_sensitive, safety_window_hours')
    .in('category_key', keys);
  if (catError) return fail('SERVER_ERROR', catError);
  const catByKey = new Map((cats ?? []).map(c => [c.category_key as string, c]));
  for (const item of params.items) {
    if (!catByKey.has(item.categoryKey)) return fail('UNKNOWN_CATEGORY');
    if (!item.foodName.trim()) return fail('FOOD_NAME_REQUIRED');
    if (!(item.estLbs > 0)) return fail('INVALID_QUANTITY');
  }

  // Compute per-item safety fields in TS (computeSafetyExpiry stays the
  // single safety-math source) and hand the whole manifest to
  // confirm_and_declare, which persists the confirm/insert/close-out writes
  // and declares the load in one transaction (review I5: was a non-atomic
  // write-then-declare_load sequence across separate PostgREST calls).
  const rpcItems: {
    scan_item_id: string | null;
    food_name: string;
    category_key: string;
    est_lbs: number;
    temperature_sensitive: boolean;
    prepared_at: string | null;
    safety_expires_at: string | null;
  }[] = [];
  for (const item of params.items) {
    const cat = catByKey.get(item.categoryKey)!;
    const safety = computeSafetyExpiry(
      { temperatureSensitive: cat.temperature_sensitive, safetyWindowHours: cat.safety_window_hours },
      item.preparedAt
    );
    if (!safety.ok) return fail(safety.error);

    rpcItems.push({
      scan_item_id: item.scanItemId,
      food_name: item.foodName.trim(),
      category_key: item.categoryKey,
      est_lbs: item.estLbs,
      temperature_sensitive: cat.temperature_sensitive,
      prepared_at: cat.temperature_sensitive ? item.preparedAt : null,
      safety_expires_at: safety.safetyExpiresAt,
    });
  }

  const { data: load, error } = await service.rpc('confirm_and_declare', {
    p_merchant_id: merchantId,
    p_declared_by: authz.merchant.userId,
    p_scan_record_id: params.scanRecordId,
    p_window_date: params.windowDate,
    p_items: rpcItems,
  });
  if (error || !load) {
    const msg = error?.message ?? '';
    if (msg.includes('SCAN_NOT_FOUND')) return fail('SCAN_NOT_FOUND', error);
    if (msg.includes('ITEM_NOT_IN_SCAN')) return fail('ITEM_NOT_IN_SCAN', error);
    if (msg.includes('UNKNOWN_CATEGORY')) return fail('UNKNOWN_CATEGORY', error);
    if (msg.includes('ITEMS_NOT_DECLARABLE')) return fail('ITEMS_NOT_DECLARABLE', error);
    if (msg.includes('VALUATION_MISSING')) return fail('VALUATION_MISSING', error);
    return fail('SERVER_ERROR', error);
  }

  return { success: true, loadId: load.id };
}

export interface DashboardLoad {
  id: string;
  window_date: string;
  status: string;
  earliest_safety_expires_at: string | null;
  created_at: string;
  load_items: { id: string; est_lbs: number; fmv_per_lb_cents: number }[];
}

export async function getMerchantDashboard(): Promise<{ businessName: string; loads: DashboardLoad[] } | null> {
  // Authz failure returns null so the page redirects to /login; infra error
  // throws (guard) and surfaces via the error boundary.
  const authz = await requireVerifiedMerchant();
  if (!authz.ok) return null;

  const service = await createServiceClient();
  // .select<Query, Row>() is supabase-js's own escape valve for a client with
  // no generated Database schema: it types `data` as DashboardLoad[] | null
  // directly (no `as unknown as` needed) so tsc actually checks the shape
  // below, instead of trusting an untyped `any[]` cast.
  const { data: loads, error: loadsError } = await service
    .from('loads')
    .select<string, DashboardLoad>(
      'id, window_date, status, earliest_safety_expires_at, created_at, load_items(id, est_lbs, fmv_per_lb_cents)'
    )
    .eq('merchant_id', authz.merchant.merchantId)
    .order('created_at', { ascending: false })
    .limit(20);
  // Worst case if unchecked: a failed loads query renders as `loads: []`,
  // showing the merchant an empty dashboard instead of an error.
  if (loadsError) throw new Error(`getMerchantDashboard: loads lookup failed: ${loadsError.message}`);

  return {
    businessName: authz.merchant.businessName,
    loads: loads ?? [],
  };
}
