// Task A — insert_valuation RPC invariants (026_valuation_admin.sql). Exercises
// the RPC directly against the real dev DB, mirroring allocations.api.spec.ts's
// style (no HTTP layer, no browser). The append action's TS-side dollar->cents
// parse (parseValuationInput) is a 'use server' function that can't run from
// this project — same reason no *.api.spec.ts imports a server action — so its
// pure logic is unit-tested in src/lib/valuation.test.ts instead.
//
// Isolation: every insert here targets a THROWAWAY category created in
// beforeAll, so a test valuation is never the "current" row for a real category
// (which declare_load would then snapshot). afterAll deletes the test category's
// valuation rows then the category itself — the service client CAN delete
// valuation_table (018's append-only REVOKE is only against authenticated/anon).
import { test, expect } from '@playwright/test';
import { getServiceClient, newContext, cleanup, type TestContext } from './helpers';

let ctx: TestContext;
let testCategoryKey: string;
const service = getServiceClient();

test.describe('insert_valuation', () => {
  test.beforeAll(async () => {
    ctx = newContext('valn');
    testCategoryKey = `E2E_VAL_${ctx.runId}`.toUpperCase();
    const { error } = await service
      .from('categories')
      .insert({ category_key: testCategoryKey, label: 'E2E valuation test category', sort: 999 });
    if (error) throw new Error(`beforeAll insert category: ${error.message}`);
  });

  test.afterAll(async () => {
    // Delete by category_key (not tracked ids) so a mid-test failure can't leak
    // a row that would FK-block the category delete below.
    await service.from('valuation_table').delete().eq('category_key', testCategoryKey);
    await service.from('categories').delete().eq('category_key', testCategoryKey);
    await cleanup(ctx);
  });

  test('appends a new valuation row, returns it, and writes a valuation_added audit row', async () => {
    const { data, error } = await service.rpc('insert_valuation', {
      p_category_key: testCategoryKey,
      p_fmv_per_lb_cents: 499,
      p_basis_per_lb_cents: 150,
      p_created_by: null,
    });
    expect(error).toBeNull();
    expect(data.category_key).toBe(testCategoryKey);
    expect(data.fmv_per_lb_cents).toBe(499);
    expect(data.basis_per_lb_cents).toBe(150);
    expect(data.effective_from).toBeTruthy();

    const { data: audit, error: auditError } = await service
      .from('audit_log')
      .select('event_type, entity_type, payload')
      .eq('entity_type', 'valuation')
      .eq('entity_id', data.id)
      .single();
    expect(auditError).toBeNull();
    expect(audit!.event_type).toBe('valuation_added');
    expect(audit!.payload.fmv_per_lb_cents).toBe(499);
    expect(audit!.payload.basis_per_lb_cents).toBe(150);
    expect(audit!.payload.category_key).toBe(testCategoryKey);
  });

  test('a second insert APPENDS — the prior row is preserved (never edited)', async () => {
    const { data: first, error: e1 } = await service.rpc('insert_valuation', {
      p_category_key: testCategoryKey, p_fmv_per_lb_cents: 300, p_basis_per_lb_cents: 100, p_created_by: null,
    });
    expect(e1).toBeNull();
    const { data: second, error: e2 } = await service.rpc('insert_valuation', {
      p_category_key: testCategoryKey, p_fmv_per_lb_cents: 350, p_basis_per_lb_cents: 120, p_created_by: null,
    });
    expect(e2).toBeNull();
    expect(second.id).not.toBe(first.id);

    // Both historical rows still exist — an append never overwrites.
    const { data: rows } = await service
      .from('valuation_table')
      .select('id, fmv_per_lb_cents')
      .eq('category_key', testCategoryKey);
    const ids = (rows ?? []).map(r => r.id as string);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
  });

  test('rejects an unknown category with UNKNOWN_CATEGORY', async () => {
    const { error } = await service.rpc('insert_valuation', {
      p_category_key: `NOPE_${ctx.runId}`.toUpperCase(),
      p_fmv_per_lb_cents: 100,
      p_basis_per_lb_cents: 50,
      p_created_by: null,
    });
    expect(error?.message).toContain('UNKNOWN_CATEGORY');
  });

  test('rejects negative cents with INVALID_VALUATION', async () => {
    const { error } = await service.rpc('insert_valuation', {
      p_category_key: testCategoryKey,
      p_fmv_per_lb_cents: -1,
      p_basis_per_lb_cents: 50,
      p_created_by: null,
    });
    expect(error?.message).toContain('INVALID_VALUATION');
  });
});
