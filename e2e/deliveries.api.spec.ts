// v3 Delivery-log (Task 1) — set_delivery_method / mark_picked_up /
// mark_delivered RPC invariants (031_deliveries.sql). Exercises the RPCs
// directly against the real dev DB, mirroring allocations.api.spec.ts. Records
// only: no routing/dispatch/courier/temperature/commission is involved.
//
// The merchant actions' TS-side validation (isDeliveryMethod/isResponsibleParty)
// is unit-tested in src/lib/deliveries.test.ts; deliveries rows are swept by
// cleanup() (helpers.ts) before allocations/loads.
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

// Accept an offer so the load sits 'matched' with an ACCEPTED allocation —
// the precondition set_delivery_method requires.
async function offerAndAccept(loadId: string, institutionId: string, userId: string): Promise<string> {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data: alloc, error: offerErr } = await service.rpc('offer_load', {
    p_load_id: loadId, p_institution_id: institutionId, p_offered_by: userId, p_expires_at: expiresAt,
  });
  if (offerErr || !alloc) throw new Error(`offer_load: ${offerErr?.message}`);
  const { error: respErr } = await service.rpc('respond_to_offer', {
    p_allocation_id: alloc.id, p_decision: 'accepted', p_actor: null, p_decline_reason: null,
  });
  if (respErr) throw new Error(`respond_to_offer: ${respErr.message}`);
  return alloc.id as string;
}

test.describe('delivery-log RPCs', () => {
  test.beforeAll(() => { ctx = newContext('deliv'); });
  test.afterAll(async () => { await cleanup(ctx); });

  test('set_delivery_method → mark_picked_up → mark_delivered walks the load through the states', async () => {
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'happy' });
    const { merchantId } = await createMerchant(ctx, user.id);
    const { loadId } = await createDeclaredLoad(ctx, {
      merchantId, scannedBy: user.id,
      items: [{ categoryKey: 'BAKERY', foodName: 'Rolls', estLbs: 5 }],
    });
    const { institutionId } = await createInstitution(ctx, { orgName: `E2E Deliv ${ctx.runId}`, npoVerified: true });
    const allocationId = await offerAndAccept(loadId, institutionId, user.id);

    // matched (accepted) → scheduled
    const { data: sched, error: schedErr } = await service.rpc('set_delivery_method', {
      p_load_id: loadId, p_merchant_id: merchantId, p_allocation_id: allocationId,
      p_method: 'pickup', p_responsible_party: 'recipient', p_notes: 'back dock', p_actor: user.id,
    });
    expect(schedErr).toBeNull();
    expect(sched.method).toBe('pickup');
    expect(sched.scheduled_at).not.toBeNull();
    let { data: load } = await service.from('loads').select('status').eq('id', loadId).single();
    expect(load!.status).toBe('scheduled');

    // scheduled → picked_up (safety window in the future here → not blown)
    const { data: picked, error: pickErr } = await service.rpc('mark_picked_up', {
      p_load_id: loadId, p_merchant_id: merchantId, p_actor: user.id,
    });
    expect(pickErr).toBeNull();
    expect(picked.picked_up_at).not.toBeNull();
    expect(picked.window_blown).toBe(false);
    ({ data: load } = await service.from('loads').select('status').eq('id', loadId).single());
    expect(load!.status).toBe('picked_up');

    // picked_up → delivered
    const { data: delivered, error: delErr } = await service.rpc('mark_delivered', {
      p_load_id: loadId, p_merchant_id: merchantId, p_actor: user.id,
    });
    expect(delErr).toBeNull();
    expect(delivered.delivered_at).not.toBeNull();
    ({ data: load } = await service.from('loads').select('status').eq('id', loadId).single());
    expect(load!.status).toBe('delivered');
  });

  test('set_delivery_method rejects a load whose offer is not accepted', async () => {
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'notaccepted' });
    const { merchantId } = await createMerchant(ctx, user.id);
    const { loadId } = await createDeclaredLoad(ctx, {
      merchantId, scannedBy: user.id,
      items: [{ categoryKey: 'BAKERY', foodName: 'Bagels', estLbs: 3 }],
    });
    const { institutionId } = await createInstitution(ctx, { orgName: `E2E NotAcc ${ctx.runId}`, npoVerified: true });

    // Offer only — do NOT accept. Load is 'matched' but the allocation is 'offered'.
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { data: alloc } = await service.rpc('offer_load', {
      p_load_id: loadId, p_institution_id: institutionId, p_offered_by: user.id, p_expires_at: expiresAt,
    });

    const { error } = await service.rpc('set_delivery_method', {
      p_load_id: loadId, p_merchant_id: merchantId, p_allocation_id: alloc.id,
      p_method: 'merchant_delivery', p_responsible_party: 'donor', p_notes: null, p_actor: user.id,
    });
    expect(error?.message).toContain('OFFER_NOT_ACCEPTED');
  });

  test('window_blown is RECORDED (not blocked) when the load is picked up past its safety window', async () => {
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'blown' });
    const { merchantId } = await createMerchant(ctx, user.id);
    // A TCS item already past its safety window → declare_load sets
    // earliest_safety_expires_at to that past time.
    const pastExpiry = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { loadId } = await createDeclaredLoad(ctx, {
      merchantId, scannedBy: user.id,
      items: [{ categoryKey: 'PREPARED_HOT', foodName: 'Hot tray', estLbs: 4, temperatureSensitive: true, safetyExpiresAt: pastExpiry }],
    });
    const { institutionId } = await createInstitution(ctx, { orgName: `E2E Blown ${ctx.runId}`, npoVerified: true });
    const allocationId = await offerAndAccept(loadId, institutionId, user.id);

    await service.rpc('set_delivery_method', {
      p_load_id: loadId, p_merchant_id: merchantId, p_allocation_id: allocationId,
      p_method: 'local_courier', p_responsible_party: 'donor', p_notes: null, p_actor: user.id,
    });

    const { data: picked, error } = await service.rpc('mark_picked_up', {
      p_load_id: loadId, p_merchant_id: merchantId, p_actor: user.id,
    });
    expect(error).toBeNull();          // NOT blocked
    expect(picked.window_blown).toBe(true); // but RECORDED

    const { data: load } = await service.from('loads').select('status').eq('id', loadId).single();
    expect(load!.status).toBe('picked_up'); // the handoff still advanced
  });

  test('mark_delivered rejects a load owned by a different merchant (034 M1 ownership guard)', async () => {
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'ownership' });
    const { merchantId } = await createMerchant(ctx, user.id);
    const { loadId } = await createDeclaredLoad(ctx, {
      merchantId, scannedBy: user.id, items: [{ categoryKey: 'BAKERY', foodName: 'Buns', estLbs: 2 }],
    });
    const { institutionId } = await createInstitution(ctx, { orgName: `E2E Own ${ctx.runId}`, npoVerified: true });
    const allocationId = await offerAndAccept(loadId, institutionId, user.id);
    await service.rpc('set_delivery_method', {
      p_load_id: loadId, p_merchant_id: merchantId, p_allocation_id: allocationId,
      p_method: 'pickup', p_responsible_party: 'recipient', p_notes: null, p_actor: user.id,
    });

    // A different merchant id must NOT be able to advance this load.
    const { error } = await service.rpc('mark_delivered', {
      p_load_id: loadId, p_merchant_id: '00000000-0000-0000-0000-000000000000', p_actor: user.id,
    });
    expect(error?.message).toContain('LOAD_NOT_FOUND');

    // …and the load is untouched (still scheduled).
    const { data: load } = await service.from('loads').select('status').eq('id', loadId).single();
    expect(load!.status).toBe('scheduled');
  });
});
