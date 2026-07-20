// Phase 1 pivot: declare_load RPC invariants — merchant ownership, confirmed
// items only, no double-declare, valuation snapshot, atomic audit row.
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createTestUser,
  createMerchant,
  createScanRecord,
  cleanup,
  type TestContext,
} from './helpers';

let ctx: TestContext;

test.describe('declare_load', () => {
  test.beforeAll(() => {
    ctx = newContext('declareload');
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test('declares a load with valuation snapshots, links items, audits', async () => {
    const service = getServiceClient();
    const user = await createTestUser(ctx, 'donor');
    const { merchantId } = await createMerchant(ctx, user.id);
    const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const { scanItemIds } = await createScanRecord(ctx, {
      merchantId,
      scannedBy: user.id,
      items: [
        { categoryKey: 'SEAFOOD', foodName: 'Salmon fillets', estLbs: 8, confirmed: true,
          temperatureSensitive: true, preparedAt: new Date().toISOString(), safetyExpiresAt: expiresAt },
        { categoryKey: 'BAKERY', foodName: 'Sourdough', estLbs: 4, confirmed: true },
      ],
    });

    const { data: load, error } = await service.rpc('declare_load', {
      p_merchant_id: merchantId,
      p_declared_by: user.id,
      p_window_date: new Date().toISOString().slice(0, 10),
      p_scan_item_ids: scanItemIds,
    });
    expect(error).toBeNull();
    expect(load.status).toBe('declared');
    expect(new Date(load.earliest_safety_expires_at).toISOString()).toBe(expiresAt);

    // Valuation snapshot matches the current valuation_table rows
    const { data: valuations } = await service
      .from('valuation_table')
      .select('category_key, fmv_per_lb_cents, basis_per_lb_cents')
      .in('category_key', ['SEAFOOD', 'BAKERY'])
      .order('effective_from', { ascending: false });
    const currentSeafood = valuations!.find(v => v.category_key === 'SEAFOOD')!;

    const { data: loadItems } = await service
      .from('load_items')
      .select('scan_item_id, est_lbs, fmv_per_lb_cents, basis_per_lb_cents')
      .eq('load_id', load.id);
    expect(loadItems).toHaveLength(2);
    const seafoodLine = loadItems!.find(li => Number(li.est_lbs) === 8)!;
    expect(seafoodLine.fmv_per_lb_cents).toBe(currentSeafood.fmv_per_lb_cents);

    // Items are linked
    const { data: linked } = await service
      .from('scan_items')
      .select('id')
      .eq('load_id', load.id);
    expect(linked).toHaveLength(2);

    // Audit row exists
    const { data: audits } = await service
      .from('audit_log')
      .select('event_type')
      .eq('entity_type', 'load')
      .eq('entity_id', load.id);
    expect(audits).toHaveLength(1);
    expect(audits![0].event_type).toBe('load_declared');
  });

  test('rejects unconfirmed items', async () => {
    const service = getServiceClient();
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'unconfirmed' });
    const { merchantId } = await createMerchant(ctx, user.id);
    const { scanItemIds } = await createScanRecord(ctx, {
      merchantId,
      scannedBy: user.id,
      items: [{ categoryKey: 'BAKERY', foodName: 'Rolls', estLbs: 2, confirmed: false }],
    });

    const { error } = await service.rpc('declare_load', {
      p_merchant_id: merchantId,
      p_declared_by: user.id,
      p_window_date: new Date().toISOString().slice(0, 10),
      p_scan_item_ids: scanItemIds,
    });
    expect(error?.message).toContain('ITEMS_NOT_DECLARABLE');
  });

  test('rejects double-declare and foreign-merchant items', async () => {
    const service = getServiceClient();
    const userA = await createTestUser(ctx, 'donor', { emailLabel: 'merchA' });
    const userB = await createTestUser(ctx, 'donor', { emailLabel: 'merchB' });
    const { merchantId: merchantA } = await createMerchant(ctx, userA.id);
    const { merchantId: merchantB } = await createMerchant(ctx, userB.id);
    const { scanItemIds } = await createScanRecord(ctx, {
      merchantId: merchantA,
      scannedBy: userA.id,
      items: [{ categoryKey: 'DELI', foodName: 'Sliced ham', estLbs: 3, confirmed: true }],
    });

    // Foreign merchant cannot declare A's items
    const { error: foreignError } = await service.rpc('declare_load', {
      p_merchant_id: merchantB,
      p_declared_by: userB.id,
      p_window_date: new Date().toISOString().slice(0, 10),
      p_scan_item_ids: scanItemIds,
    });
    expect(foreignError?.message).toContain('ITEMS_NOT_DECLARABLE');

    // First declare succeeds…
    const { error: firstError } = await service.rpc('declare_load', {
      p_merchant_id: merchantA,
      p_declared_by: userA.id,
      p_window_date: new Date().toISOString().slice(0, 10),
      p_scan_item_ids: scanItemIds,
    });
    expect(firstError).toBeNull();

    // …the second is rejected (items already on a load)
    const { error: secondError } = await service.rpc('declare_load', {
      p_merchant_id: merchantA,
      p_declared_by: userA.id,
      p_window_date: new Date().toISOString().slice(0, 10),
      p_scan_item_ids: scanItemIds,
    });
    expect(secondError?.message).toContain('ITEMS_NOT_DECLARABLE');
  });
});
