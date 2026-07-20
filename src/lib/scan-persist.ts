// Server-side scan persistence — the pivot's core invariant: EVERY scan lands
// in scan_records/scan_items at capture time, whether or not it becomes a
// load. Framework-free (plain SupabaseClient in, relative imports only) so
// the Playwright suite can import and exercise it directly.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FoodScanResult } from '../types/food';
import { toCategoryKey, estimateLbs } from './food-taxonomy';

export interface PersistedScan {
  scanRecordId: string;
  scanItemIds: string[];
}

export async function persistScanResult(
  service: SupabaseClient,
  params: {
    merchantId: string;
    scannedBy: string;
    photoKey: string | null;
    modelId: string;
    result: FoodScanResult;
  }
): Promise<PersistedScan> {
  const { merchantId, scannedBy, photoKey, modelId, result } = params;

  const { data: record, error: recordError } = await service
    .from('scan_records')
    .insert({
      merchant_id: merchantId,
      scanned_by: scannedBy,
      photo_key: photoKey,
      model_id: modelId,
      overall_confidence: result.overallConfidence,
      needs_review: result.needsManualReview,
      notes: result.notes || null,
      raw_response: result as unknown as Record<string, unknown>,
    })
    .select('id')
    .single();
  if (recordError || !record) {
    throw new Error(`scan-persist: scan_records insert failed: ${recordError?.message}`);
  }

  let scanItemIds: string[] = [];
  if (result.items.length > 0) {
    const keys = [...new Set(result.items.map(i => toCategoryKey(i.category)))];
    const { data: cats, error: catError } = await service
      .from('categories')
      .select('category_key, temperature_sensitive')
      .in('category_key', keys);
    if (catError) {
      throw new Error(`scan-persist: categories lookup failed: ${catError.message}`);
    }
    const tempByKey = new Map((cats ?? []).map(c => [c.category_key as string, c.temperature_sensitive as boolean]));

    const rows = result.items.map(item => {
      const categoryKey = toCategoryKey(item.category);
      const lbs = estimateLbs(item);
      return {
        scan_record_id: record.id,
        category_key: categoryKey,
        food_name: item.foodName,
        est_lbs: lbs,
        ai_category_key: categoryKey,
        ai_food_name: item.foodName,
        ai_est_lbs: lbs,
        ai_confidence: item.confidence,
        qty_value: item.estimatedQuantity,
        qty_unit: item.unit,
        est_servings: item.estimatedServings,
        temperature_sensitive: tempByKey.get(categoryKey) ?? false,
      };
    });

    // Assumes a single multi-row INSERT ... RETURNING preserves input order:
    // callers (e.g. /api/scan) map these ids back onto `result.items` by index.
    const { data: inserted, error: itemsError } = await service
      .from('scan_items')
      .insert(rows)
      .select('id');
    if (itemsError || !inserted) {
      throw new Error(`scan-persist: scan_items insert failed: ${itemsError?.message}`);
    }
    scanItemIds = inserted.map(r => r.id as string);
  }

  const { error: auditError } = await service.from('audit_log').insert({
    entity_type: 'scan_record',
    entity_id: record.id,
    event_type: 'scan_created',
    actor_id: scannedBy,
    actor_role: 'merchant',
    payload: {
      merchant_id: merchantId,
      item_count: result.items.length,
      needs_review: result.needsManualReview,
      model_id: modelId,
    },
  });
  if (auditError) {
    throw new Error(`scan-persist: audit insert failed: ${auditError.message}`);
  }

  return { scanRecordId: record.id, scanItemIds };
}
