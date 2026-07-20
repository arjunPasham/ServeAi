// Phase 1 pivot: every scan is persisted itemized — the dataset invariant.
// Exercises src/lib/scan-persist.ts directly (framework-free by design)
// against the real dev DB.
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createTestUser,
  createMerchant,
  cleanup,
  type TestContext,
} from './helpers';
import { persistScanResult } from '../src/lib/scan-persist';
import type { FoodScanResult } from '../src/types/food';

let ctx: TestContext;

const TWO_ITEM_SCAN: FoodScanResult = {
  items: [
    {
      foodName: 'Penne Pasta Tray',
      category: 'Pasta',
      estimatedQuantity: 8,
      unit: 'lbs',
      estimatedServings: 12,
      confidence: 0.93,
    },
    {
      foodName: 'Sourdough Loaves',
      category: 'Bread & Bakery',
      estimatedQuantity: 2,
      unit: 'trays',
      estimatedServings: 8,
      confidence: 0.88,
    },
  ],
  overallConfidence: 0.91,
  needsManualReview: false,
  notes: 'e2e fixture',
};

test.describe('scan persistence', () => {
  test.beforeAll(() => {
    ctx = newContext('scanpersist');
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test('persists every item with category keys, lbs, temp flags, and an audit row', async () => {
    const service = getServiceClient();
    const user = await createTestUser(ctx, 'donor');
    const { merchantId } = await createMerchant(ctx, user.id);

    const persisted = await persistScanResult(service, {
      merchantId,
      scannedBy: user.id,
      photoKey: `scans/${user.id}/e2e-${ctx.runId}.jpg`,
      modelId: 'dev-synthetic',
      result: TWO_ITEM_SCAN,
    });
    ctx.scanRecordIds.push(persisted.scanRecordId);

    expect(persisted.scanItemIds).toHaveLength(2);

    const { data: record } = await service
      .from('scan_records')
      .select('merchant_id, model_id, needs_review, raw_response')
      .eq('id', persisted.scanRecordId)
      .single();
    expect(record?.merchant_id).toBe(merchantId);
    expect((record?.raw_response as FoodScanResult).items).toHaveLength(2);

    const { data: items } = await service
      .from('scan_items')
      .select('category_key, est_lbs, temperature_sensitive, disposition, merchant_confirmed, ai_food_name')
      .eq('scan_record_id', persisted.scanRecordId)
      .order('created_at');
    expect(items).toHaveLength(2);
    expect(items![0].category_key).toBe('PREPARED_HOT'); // Pasta → PREPARED_HOT (TCS)
    expect(items![0].temperature_sensitive).toBe(true);
    expect(Number(items![0].est_lbs)).toBe(8);
    expect(items![1].category_key).toBe('BAKERY'); // trays → servings fallback: 8 × 0.75
    expect(items![1].temperature_sensitive).toBe(false);
    expect(Number(items![1].est_lbs)).toBe(6);
    expect(items!.every(i => i.disposition === 'pending' && i.merchant_confirmed === false)).toBe(true);

    const { data: audits } = await service
      .from('audit_log')
      .select('event_type, actor_role')
      .eq('entity_type', 'scan_record')
      .eq('entity_id', persisted.scanRecordId);
    expect(audits).toHaveLength(1);
    expect(audits![0].event_type).toBe('scan_created');
  });
});
