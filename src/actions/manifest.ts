'use server';

// Merchant manifest actions (Phase 1 pivot): confirm the AI's manifest,
// close out removed items, and declare tonight's load atomically via the
// declare_load RPC. All writes go through the service client; ownership is
// enforced here (the RPC re-checks merchant ownership).

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { computeSafetyExpiry } from '@/lib/safety-window';
import { currentValuations, type ValuationRow } from '@/lib/valuation';

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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const service = await createServiceClient();
  const { data, error } = await service
    .from('merchants')
    .select('id, business_name')
    .eq('user_id', user.id)
    .maybeSingle();
  // A DB outage must surface as an error, not silently masquerade as "not a
  // merchant" (which would send an authenticated merchant to a login/signup
  // redirect). No repo-wide precedent for read-path error handling in
  // null-returning getters, so throw and let the error boundary handle it.
  if (error) throw new Error(`getMerchantContext: merchants lookup failed: ${error.message}`);
  if (!data) return null;
  return { merchantId: data.id, businessName: data.business_name };
}

export async function getCategoriesWithValuations(): Promise<CategoryOption[]> {
  const service = await createServiceClient();

  const [{ data: cats, error: catError }, { data: vals, error: valError }] = await Promise.all([
    service.from('categories').select('category_key, label, temperature_sensitive, safety_window_hours, sort').order('sort'),
    service.from('valuation_table').select('category_key, fmv_per_lb_cents, basis_per_lb_cents, effective_from'),
  ]);
  if (catError || valError) return [];

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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  if (!params.items.length) return { success: false, error: 'EMPTY_MANIFEST' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.windowDate) || Number.isNaN(Date.parse(params.windowDate))) {
    return { success: false, error: 'INVALID_WINDOW_DATE' };
  }

  const service = await createServiceClient();

  const { data: merchant, error: merchantError } = await service
    .from('merchants')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (merchantError) return { success: false, error: 'SERVER_ERROR' };
  if (!merchant) return { success: false, error: 'NOT_A_MERCHANT' };

  const { data: scanRecord, error: scanRecordError } = await service
    .from('scan_records')
    .select('id')
    .eq('id', params.scanRecordId)
    .eq('merchant_id', merchant.id)
    .maybeSingle();
  if (scanRecordError) return { success: false, error: 'SERVER_ERROR' };
  if (!scanRecord) return { success: false, error: 'SCAN_NOT_FOUND' };

  // Category lookup (also validates every key)
  const keys = [...new Set(params.items.map(i => i.categoryKey))];
  const { data: cats, error: catError } = await service
    .from('categories')
    .select('category_key, temperature_sensitive, safety_window_hours')
    .in('category_key', keys);
  if (catError) return { success: false, error: 'SERVER_ERROR' };
  const catByKey = new Map((cats ?? []).map(c => [c.category_key as string, c]));
  for (const item of params.items) {
    if (!catByKey.has(item.categoryKey)) return { success: false, error: 'UNKNOWN_CATEGORY' };
    if (!item.foodName.trim()) return { success: false, error: 'FOOD_NAME_REQUIRED' };
    if (!(item.estLbs > 0)) return { success: false, error: 'INVALID_QUANTITY' };
  }

  // Pre-flight valuation check, before any write. declare_load's own
  // VALUATION_MISSING check only runs after the scan_items mutations below
  // (confirm updates, manual-item inserts, not_shipped closeouts) have already
  // been written, so a category with no current valuation would otherwise
  // burn those writes before the RPC rejects the declare. The UI's dropdown
  // already filters to valued categories, but this action is directly
  // callable, so re-check here as cheap insurance against a partial write.
  const { data: valRows, error: valError } = await service
    .from('valuation_table')
    .select('category_key, fmv_per_lb_cents, basis_per_lb_cents, effective_from')
    .in('category_key', keys);
  if (valError) return { success: false, error: 'SERVER_ERROR' };
  const currentVals = currentValuations(
    (valRows ?? []).map((v): ValuationRow => ({
      categoryKey: v.category_key,
      fmvPerLbCents: v.fmv_per_lb_cents,
      basisPerLbCents: v.basis_per_lb_cents,
      effectiveFrom: v.effective_from,
    }))
  );
  for (const key of keys) {
    if (!currentVals.has(key)) return { success: false, error: 'VALUATION_MISSING' };
  }

  // Existing, still-pending items on this scan record
  const { data: existing, error: existingError } = await service
    .from('scan_items')
    .select('id')
    .eq('scan_record_id', params.scanRecordId)
    .is('load_id', null)
    .eq('disposition', 'pending');
  if (existingError) return { success: false, error: 'SERVER_ERROR' };
  const existingIds = new Set((existing ?? []).map(r => r.id as string));

  const keptIds = params.items.filter(i => i.scanItemId).map(i => i.scanItemId as string);
  for (const id of keptIds) {
    if (!existingIds.has(id)) return { success: false, error: 'ITEM_NOT_IN_SCAN' };
  }

  const nowIso = new Date().toISOString();
  const confirmedIds: string[] = [];

  for (const item of params.items) {
    const cat = catByKey.get(item.categoryKey)!;
    const safety = computeSafetyExpiry(
      { temperatureSensitive: cat.temperature_sensitive, safetyWindowHours: cat.safety_window_hours },
      item.preparedAt
    );
    if (!safety.ok) return { success: false, error: safety.error };

    const fields = {
      food_name: item.foodName.trim(),
      category_key: item.categoryKey,
      est_lbs: item.estLbs,
      temperature_sensitive: cat.temperature_sensitive,
      prepared_at: cat.temperature_sensitive ? item.preparedAt : null,
      safety_expires_at: safety.safetyExpiresAt,
      merchant_confirmed: true,
      confirmed_at: nowIso,
    };

    if (item.scanItemId) {
      const { error } = await service
        .from('scan_items')
        .update(fields)
        .eq('id', item.scanItemId)
        .eq('scan_record_id', params.scanRecordId);
      if (error) return { success: false, error: 'SERVER_ERROR' };
      confirmedIds.push(item.scanItemId);
    } else {
      // Merchant-added item the AI missed — ai_* fields record that origin
      const { data: added, error } = await service
        .from('scan_items')
        .insert({
          scan_record_id: params.scanRecordId,
          ...fields,
          ai_food_name: '(added manually)',
          ai_confidence: 0,
        })
        .select('id')
        .single();
      if (error || !added) return { success: false, error: 'SERVER_ERROR' };
      confirmedIds.push(added.id);
    }
  }

  // Items the merchant removed from the manifest: closed out as not_shipped —
  // the disposition dataset must never dangle (analysis/03, schema decision 1).
  const removedIds = [...existingIds].filter(id => !keptIds.includes(id));
  if (removedIds.length) {
    const { error } = await service
      .from('scan_items')
      .update({ disposition: 'not_shipped', disposition_at: nowIso })
      .in('id', removedIds);
    if (error) return { success: false, error: 'SERVER_ERROR' };
  }

  const { data: load, error: declareError } = await service.rpc('declare_load', {
    p_merchant_id: merchant.id,
    p_declared_by: user.id,
    p_window_date: params.windowDate,
    p_scan_item_ids: confirmedIds,
  });
  if (declareError || !load) {
    const msg = declareError?.message ?? '';
    if (msg.includes('ITEMS_NOT_DECLARABLE')) return { success: false, error: 'ITEMS_NOT_DECLARABLE' };
    if (msg.includes('VALUATION_MISSING')) return { success: false, error: 'VALUATION_MISSING' };
    if (msg.includes('EMPTY_LOAD')) return { success: false, error: 'EMPTY_MANIFEST' };
    return { success: false, error: 'SERVER_ERROR' };
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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const service = await createServiceClient();
  const { data: merchant, error: merchantError } = await service
    .from('merchants')
    .select('id, business_name')
    .eq('user_id', user.id)
    .maybeSingle();
  // Same reasoning as getMerchantContext: a DB outage must not present as
  // "no merchant profile" — throw so it surfaces via the error boundary
  // instead of silently rendering an empty/wrong dashboard state.
  if (merchantError) throw new Error(`getMerchantDashboard: merchants lookup failed: ${merchantError.message}`);
  if (!merchant) return null;

  const { data: loads, error: loadsError } = await service
    .from('loads')
    .select('id, window_date, status, earliest_safety_expires_at, created_at, load_items(id, est_lbs, fmv_per_lb_cents)')
    .eq('merchant_id', merchant.id)
    .order('created_at', { ascending: false })
    .limit(20);
  // Worst case if unchecked: a failed loads query renders as `loads: []`,
  // showing the merchant an empty dashboard instead of an error.
  if (loadsError) throw new Error(`getMerchantDashboard: loads lookup failed: ${loadsError.message}`);

  return {
    businessName: merchant.business_name,
    loads: (loads ?? []) as unknown as DashboardLoad[],
  };
}
