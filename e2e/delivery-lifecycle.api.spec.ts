// v3 Task 4 — the full delivery-log lifecycle end to end, proving the states
// COMPOSE (each step feeds the next), distinct from the per-RPC guard specs
// (deliveries/recipient-confirm/receipts). Walks:
//   declared -> matched -> scheduled -> picked_up -> delivered -> (confirm)
//   -> donation receipt -> closed
// plus the window_blown path (recorded, never blocks the chain). Records-only:
// no routing/dispatch/courier/temperature/commission anywhere in the walk.
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createTestUser,
  createMerchant,
  createDeclaredLoad,
  createInstitution,
  cleanup,
  type TestContext,
} from './helpers';

let ctx: TestContext;
const service = getServiceClient();

async function acceptedLoad(
  label: string,
  items: { categoryKey: string; foodName: string; estLbs: number; temperatureSensitive?: boolean; safetyExpiresAt?: string }[]
): Promise<{ loadId: string; allocationId: string; merchantId: string; userId: string }> {
  const user = await createTestUser(ctx, 'donor', { emailLabel: label });
  const { merchantId } = await createMerchant(ctx, user.id);
  const { loadId } = await createDeclaredLoad(ctx, { merchantId, scannedBy: user.id, items });
  const { institutionId } = await createInstitution(ctx, { orgName: `E2E Lifecycle ${ctx.runId} ${label}`, npoVerified: true });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data: alloc, error } = await service.rpc('offer_load', {
    p_load_id: loadId, p_institution_id: institutionId, p_offered_by: user.id, p_expires_at: expiresAt,
  });
  if (error || !alloc) throw new Error(`offer_load: ${error?.message}`);
  await service.rpc('respond_to_offer', { p_allocation_id: alloc.id, p_decision: 'accepted', p_actor: null, p_decline_reason: null });
  return { loadId, allocationId: alloc.id, merchantId, userId: user.id };
}

async function loadStatus(loadId: string): Promise<string> {
  const { data } = await service.from('loads').select('status').eq('id', loadId).single();
  return data!.status as string;
}

test.describe('delivery lifecycle (v3, records-only)', () => {
  test.beforeAll(() => { ctx = newContext('lifecycle'); });
  test.afterAll(async () => { await cleanup(ctx); });

  test('declared → scheduled → picked_up → delivered → confirmed → receipt → closed', async () => {
    const { loadId, allocationId, merchantId, userId } = await acceptedLoad('chain', [
      { categoryKey: 'BAKERY', foodName: 'Rolls', estLbs: 5 },
    ]);
    expect(await loadStatus(loadId)).toBe('matched');

    // schedule
    const { error: sErr } = await service.rpc('set_delivery_method', {
      p_load_id: loadId, p_merchant_id: merchantId, p_allocation_id: allocationId,
      p_method: 'merchant_delivery', p_responsible_party: 'donor', p_notes: null, p_actor: userId,
    });
    expect(sErr).toBeNull();
    expect(await loadStatus(loadId)).toBe('scheduled');

    // picked up
    const { data: picked, error: pErr } = await service.rpc('mark_picked_up', {
      p_load_id: loadId, p_merchant_id: merchantId, p_actor: userId,
    });
    expect(pErr).toBeNull();
    expect(picked.window_blown).toBe(false);
    expect(await loadStatus(loadId)).toBe('picked_up');

    // merchant marks delivered, then the recipient confirms (adds signer + ack)
    const { error: dErr } = await service.rpc('mark_delivered', { p_load_id: loadId, p_actor: null });
    expect(dErr).toBeNull();
    expect(await loadStatus(loadId)).toBe('delivered');

    const { data: confirmed, error: cErr } = await service.rpc('recipient_confirm_delivery', {
      p_allocation_id: allocationId, p_signer_name: 'Dana R.', p_discrepancy_reason: null,
      p_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), p_actor: null,
    });
    expect(cErr).toBeNull();
    expect(confirmed.signer_name).toBe('Dana R.');
    expect(confirmed.acknowledged_at).not.toBeNull();
    expect(await loadStatus(loadId)).toBe('delivered');

    // donation receipt (frozen from the snapshot)
    const { data: receipt, error: rErr } = await service.rpc('issue_receipt', {
      p_load_id: loadId, p_method_version: '170e3-v1', p_template_approved: false, p_actor: null,
    });
    expect(rErr).toBeNull();
    expect(receipt.fmv_total_cents).toBeGreaterThan(0);
    expect(receipt.enhanced_deduction_cents).toBeGreaterThan(0);

    // close the dispute window
    const { data: closed, error: clErr } = await service.rpc('close_delivery_window', { p_load_id: loadId, p_actor: null });
    expect(clErr).toBeNull();
    expect(closed.status).toBe('closed');
  });

  test('window_blown path: a past-safety pickup is flagged but the chain still completes', async () => {
    const pastExpiry = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { loadId, allocationId, merchantId, userId } = await acceptedLoad('blown', [
      { categoryKey: 'PREPARED_HOT', foodName: 'Hot tray', estLbs: 4, temperatureSensitive: true, safetyExpiresAt: pastExpiry },
    ]);

    await service.rpc('set_delivery_method', {
      p_load_id: loadId, p_merchant_id: merchantId, p_allocation_id: allocationId,
      p_method: 'local_courier', p_responsible_party: 'donor', p_notes: null, p_actor: userId,
    });
    const { data: picked } = await service.rpc('mark_picked_up', { p_load_id: loadId, p_merchant_id: merchantId, p_actor: userId });
    expect(picked.window_blown).toBe(true); // RECORDED

    // …and the flag does not block the rest of the chain.
    const { error: cErr } = await service.rpc('recipient_confirm_delivery', {
      p_allocation_id: allocationId, p_signer_name: 'Lee', p_discrepancy_reason: null,
      p_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), p_actor: null,
    });
    expect(cErr).toBeNull();
    expect(await loadStatus(loadId)).toBe('delivered');

    const { data: receipt, error: rErr } = await service.rpc('issue_receipt', {
      p_load_id: loadId, p_method_version: '170e3-v1', p_template_approved: false, p_actor: null,
    });
    expect(rErr).toBeNull();
    expect(receipt.id).toBeTruthy();
  });
});
