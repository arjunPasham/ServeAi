// Task 1 — surplus-intelligence reporting views + dangling predicate
// (028_data_pipeline.sql). Exercises the views directly against the real dev DB
// as the service role (they're REVOKEd from anon/authenticated), mirroring the
// other api specs. The pure report helpers (weekdayLabel/describeSurplusPattern)
// are unit-tested in src/lib/reports.test.ts; the guarded reads and the Inngest
// sweep are thin glue over what's verified here.
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createTestUser,
  createMerchant,
  createScanRecord,
  createDeclaredLoad,
  cleanup,
  type TestContext,
} from './helpers';

let ctx: TestContext;
const service = getServiceClient();

test.describe('data pipeline (028 reporting views + dangling sweep)', () => {
  test.beforeAll(() => {
    ctx = newContext('datapipe');
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test('surplus patterns count confirmed items; export snapshots valuation; dangling = pending+no-load+stale', async () => {
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'pipe' });
    const { merchantId } = await createMerchant(ctx, user.id);

    // A confirmed, declared BAKERY item — the supply signal + a valuation snapshot.
    const { loadId, scanItemIds } = await createDeclaredLoad(ctx, {
      merchantId,
      scannedBy: user.id,
      items: [{ categoryKey: 'BAKERY', foodName: 'Croissants', estLbs: 7 }],
    });
    const bakeryItemId = scanItemIds[0];
    expect(loadId).toBeTruthy();

    // A RECENT unconfirmed DAIRY scan with no load (not a dangler yet — inside window).
    const { scanRecordId, scanItemIds: recentIds } = await createScanRecord(ctx, {
      merchantId,
      scannedBy: user.id,
      items: [{ categoryKey: 'DAIRY', foodName: 'Fresh milk', estLbs: 4 }],
    });
    const recentDairyId = recentIds[0];

    // A STALE unconfirmed DAIRY scan with no load, backdated 10 days — the dangler.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const { data: stale, error: staleErr } = await service
      .from('scan_items')
      .insert({
        scan_record_id: scanRecordId,
        category_key: 'DAIRY',
        food_name: 'Old milk',
        est_lbs: 3,
        ai_food_name: 'Old milk',
        ai_confidence: 0.8,
        created_at: tenDaysAgo,
      })
      .select('id')
      .single();
    expect(staleErr).toBeNull();
    const staleDairyId = stale!.id as string;

    // ── merchant_surplus_patterns: only merchant_confirmed items count ──
    const { data: patterns, error: patErr } = await service
      .from('merchant_surplus_patterns')
      .select('category_key, local_dow, total_est_lbs, distinct_days, item_count')
      .eq('merchant_id', merchantId);
    expect(patErr).toBeNull();
    const bakeryPattern = (patterns ?? []).find(p => p.category_key === 'BAKERY');
    expect(bakeryPattern).toBeTruthy();
    expect(Number(bakeryPattern!.total_est_lbs)).toBe(7);
    expect(Number(bakeryPattern!.local_dow)).toBeGreaterThanOrEqual(1);
    expect(Number(bakeryPattern!.local_dow)).toBeLessThanOrEqual(7);
    // The unconfirmed DAIRY scans must NOT surface as a pattern.
    expect((patterns ?? []).some(p => p.category_key === 'DAIRY')).toBe(false);

    // ── export_scan_items: flat grain + declaration valuation snapshot ──
    const { data: exportRows, error: expErr } = await service
      .from('export_scan_items')
      .select('scan_item_id, est_lbs, load_id, fmv_per_lb_cents, est_fmv_cents, merchant_confirmed')
      .eq('merchant_id', merchantId);
    expect(expErr).toBeNull();
    const rowById = new Map((exportRows ?? []).map(r => [r.scan_item_id as string, r]));

    const bakeryRow = rowById.get(bakeryItemId)!;
    expect(bakeryRow.load_id).toBe(loadId);
    expect(bakeryRow.merchant_confirmed).toBe(true);
    expect(bakeryRow.fmv_per_lb_cents).not.toBeNull();
    // Snapshot value is self-consistent: est_fmv = round(est_lbs * fmv_per_lb).
    expect(Number(bakeryRow.est_fmv_cents)).toBe(
      Math.round(Number(bakeryRow.est_lbs) * Number(bakeryRow.fmv_per_lb_cents))
    );

    // Undeclared items carry no snapshot.
    const recentRow = rowById.get(recentDairyId)!;
    expect(recentRow.load_id).toBeNull();
    expect(recentRow.fmv_per_lb_cents).toBeNull();
    expect(recentRow.est_fmv_cents).toBeNull();

    // ── dangling predicate: pending + no load + older than the window ──
    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { data: danglers, error: dangErr } = await service
      .from('scan_items')
      .select('id')
      .eq('disposition', 'pending')
      .is('load_id', null)
      .lt('created_at', cutoff);
    expect(dangErr).toBeNull();
    const danglerIds = (danglers ?? []).map(d => d.id as string);
    expect(danglerIds).toContain(staleDairyId);      // stale, no load -> dangling
    expect(danglerIds).not.toContain(recentDairyId); // recent -> inside window
    expect(danglerIds).not.toContain(bakeryItemId);  // on a load -> not a dangler
  });
});
