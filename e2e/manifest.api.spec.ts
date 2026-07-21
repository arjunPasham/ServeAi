// Phase 1 pivot: declare_load RPC invariants — merchant ownership, confirmed
// items only, no double-declare, valuation snapshot, atomic audit row.
//
// Phase 2 Task 2: confirm_and_declare RPC invariants — it folds confirmManifest's
// former write-then-declare_load sequence (confirm updates + manual inserts +
// not_shipped closeout + declare_load, across separate PostgREST calls) into
// one transaction (024_allocations.sql).
import { randomUUID } from 'crypto';
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
let confirmCtx: TestContext;

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

test.describe('confirm_and_declare', () => {
  test.beforeAll(() => {
    confirmCtx = newContext('confirmdeclare');
  });

  test.afterAll(async () => {
    await cleanup(confirmCtx);
  });

  test('confirms kept item + manual item, closes out the omitted item, snapshots, audits', async () => {
    const service = getServiceClient();
    const user = await createTestUser(confirmCtx, 'donor', { emailLabel: 'happy' });
    const { merchantId } = await createMerchant(confirmCtx, user.id);

    const preparedAt = new Date().toISOString();
    const safetyExpiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

    // Two PENDING (unconfirmed) items — confirm_and_declare is what confirms
    // them, not createScanRecord.
    const { scanRecordId, scanItemIds } = await createScanRecord(confirmCtx, {
      merchantId,
      scannedBy: user.id,
      items: [
        { categoryKey: 'SEAFOOD', foodName: 'Salmon fillets', estLbs: 8, confirmed: false },
        { categoryKey: 'BAKERY', foodName: 'Sourdough', estLbs: 4, confirmed: false },
      ],
    });
    const [keptItemId, omittedItemId] = scanItemIds;

    const windowDate = new Date().toISOString().slice(0, 10);
    const { data: load, error } = await service.rpc('confirm_and_declare', {
      p_merchant_id: merchantId,
      p_declared_by: user.id,
      p_scan_record_id: scanRecordId,
      p_window_date: windowDate,
      p_items: [
        // Keep item 1, with merchant-edited fields (mirrors what confirmManifest sends).
        {
          scan_item_id: keptItemId,
          food_name: 'Salmon fillets',
          category_key: 'SEAFOOD',
          est_lbs: 8,
          temperature_sensitive: true,
          prepared_at: preparedAt,
          safety_expires_at: safetyExpiresAt,
        },
        // A manual item the merchant added — no scan_item_id.
        {
          scan_item_id: null,
          food_name: 'Manual add — dinner rolls',
          category_key: 'BAKERY',
          est_lbs: 3,
          temperature_sensitive: false,
          prepared_at: null,
          safety_expires_at: null,
        },
        // item 2 (omittedItemId) is left out entirely — it should close out.
      ],
    });
    expect(error).toBeNull();
    expect(load.status).toBe('declared');

    // Valuation snapshot on both load_items lines
    const { data: loadItems } = await service
      .from('load_items')
      .select('scan_item_id, est_lbs, fmv_per_lb_cents, basis_per_lb_cents')
      .eq('load_id', load.id);
    expect(loadItems).toHaveLength(2);

    const { data: seafoodVal } = await service
      .from('valuation_table')
      .select('fmv_per_lb_cents')
      .eq('category_key', 'SEAFOOD')
      .order('effective_from', { ascending: false })
      .limit(1)
      .single();
    const seafoodLine = loadItems!.find(li => li.scan_item_id === keptItemId)!;
    expect(seafoodLine.fmv_per_lb_cents).toBe(seafoodVal!.fmv_per_lb_cents);

    // Item 1 (kept): confirmed + linked to the load
    const { data: kept } = await service
      .from('scan_items')
      .select('merchant_confirmed, load_id, disposition')
      .eq('id', keptItemId)
      .single();
    expect(kept!.merchant_confirmed).toBe(true);
    expect(kept!.load_id).toBe(load.id);

    // Item 2 (omitted): closed out not_shipped, never linked
    const { data: omitted } = await service
      .from('scan_items')
      .select('merchant_confirmed, load_id, disposition')
      .eq('id', omittedItemId)
      .single();
    expect(omitted!.disposition).toBe('not_shipped');
    expect(omitted!.load_id).toBeNull();

    // Manual item: inserted, confirmed, and linked
    const { data: manualItem } = await service
      .from('scan_items')
      .select('id, merchant_confirmed, load_id')
      .eq('scan_record_id', scanRecordId)
      .eq('food_name', 'Manual add — dinner rolls')
      .single();
    expect(manualItem).toBeTruthy();
    expect(manualItem!.merchant_confirmed).toBe(true);
    expect(manualItem!.load_id).toBe(load.id);

    // Audit row (written by declare_load, inside the same transaction)
    const { data: audits } = await service
      .from('audit_log')
      .select('event_type')
      .eq('entity_type', 'load')
      .eq('entity_id', load.id);
    expect(audits).toHaveLength(1);
    expect(audits![0].event_type).toBe('load_declared');
  });

  test('a mid-loop ITEM_NOT_IN_SCAN raise rolls back the whole transaction', async () => {
    const service = getServiceClient();
    const user = await createTestUser(confirmCtx, 'donor', { emailLabel: 'rollback' });
    const { merchantId } = await createMerchant(confirmCtx, user.id);

    const { scanRecordId, scanItemIds } = await createScanRecord(confirmCtx, {
      merchantId,
      scannedBy: user.id,
      items: [{ categoryKey: 'BAKERY', foodName: 'Bagels', estLbs: 2, confirmed: false }],
    });
    const [validItemId] = scanItemIds;
    const windowDate = new Date().toISOString().slice(0, 10);

    const { error } = await service.rpc('confirm_and_declare', {
      p_merchant_id: merchantId,
      p_declared_by: user.id,
      p_scan_record_id: scanRecordId,
      p_window_date: windowDate,
      p_items: [
        {
          scan_item_id: validItemId,
          food_name: 'Bagels',
          category_key: 'BAKERY',
          est_lbs: 2,
          temperature_sensitive: false,
          prepared_at: null,
          safety_expires_at: null,
        },
        // Bogus scan_item_id, not on this (or any) scan record — raises
        // ITEM_NOT_IN_SCAN partway through the loop, AFTER the valid item
        // above has already been UPDATEd in this same transaction.
        {
          scan_item_id: randomUUID(),
          food_name: 'Ghost item',
          category_key: 'BAKERY',
          est_lbs: 1,
          temperature_sensitive: false,
          prepared_at: null,
          safety_expires_at: null,
        },
      ],
    });
    expect(error?.message).toContain('ITEM_NOT_IN_SCAN');

    // Nothing persisted: the valid item's mid-loop UPDATE rolled back too —
    // this is the property that justifies folding the whole sequence into
    // one RPC (a pre-024 confirmManifest would have left this item confirmed
    // with no load, since its UPDATE ran in a separate PostgREST call from
    // the failed declare_load).
    const { data: stillPending } = await service
      .from('scan_items')
      .select('merchant_confirmed, load_id, disposition')
      .eq('id', validItemId)
      .single();
    expect(stillPending!.merchant_confirmed).toBe(false);
    expect(stillPending!.load_id).toBeNull();
    expect(stillPending!.disposition).toBe('pending');

    const { data: loads } = await service
      .from('loads')
      .select('id')
      .eq('merchant_id', merchantId)
      .eq('window_date', windowDate);
    expect(loads).toHaveLength(0);
  });
});
