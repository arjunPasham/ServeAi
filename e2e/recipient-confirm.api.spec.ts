// v3 recipient confirm + dispute window (Task 2) — recipient_confirm_delivery /
// flag_delivery_discrepancy / close_delivery_window RPC invariants
// (032_recipient_confirm.sql). Exercises the RPCs directly against the dev DB,
// mirroring deliveries.api.spec.ts. Records-only: a flag does not block the
// close; there is no per-item accept/reject and no payout.
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

// A scheduled (accepted + method-set) delivery ready to be confirmed.
async function scheduledDelivery(label: string): Promise<{ loadId: string; allocationId: string }> {
  const user = await createTestUser(ctx, 'donor', { emailLabel: label });
  const { merchantId } = await createMerchant(ctx, user.id);
  const { loadId } = await createDeclaredLoad(ctx, {
    merchantId, scannedBy: user.id, items: [{ categoryKey: 'BAKERY', foodName: 'Rolls', estLbs: 5 }],
  });
  const { institutionId } = await createInstitution(ctx, { orgName: `E2E Confirm ${ctx.runId} ${label}`, npoVerified: true });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data: alloc, error: offerErr } = await service.rpc('offer_load', {
    p_load_id: loadId, p_institution_id: institutionId, p_offered_by: user.id, p_expires_at: expiresAt,
  });
  if (offerErr || !alloc) throw new Error(`offer_load: ${offerErr?.message}`);
  const { error: respErr } = await service.rpc('respond_to_offer', {
    p_allocation_id: alloc.id, p_decision: 'accepted', p_actor: null, p_decline_reason: null,
  });
  if (respErr) throw new Error(`respond_to_offer: ${respErr.message}`);
  const { error: methodErr } = await service.rpc('set_delivery_method', {
    p_load_id: loadId, p_merchant_id: merchantId, p_allocation_id: alloc.id,
    p_method: 'pickup', p_responsible_party: 'recipient', p_notes: null, p_actor: user.id,
  });
  if (methodErr) throw new Error(`set_delivery_method: ${methodErr.message}`);
  return { loadId, allocationId: alloc.id };
}

test.describe('recipient confirm + dispute window', () => {
  test.beforeAll(() => { ctx = newContext('confirm'); });
  test.afterAll(async () => { await cleanup(ctx); });

  test('confirm → flag in-window → close walks the load to closed', async () => {
    const { loadId, allocationId } = await scheduledDelivery('happy');
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const { data: confirmed, error: cErr } = await service.rpc('recipient_confirm_delivery', {
      p_allocation_id: allocationId, p_signer_name: 'Maria Lopez', p_discrepancy_reason: null,
      p_expires_at: future, p_actor: null,
    });
    expect(cErr).toBeNull();
    expect(confirmed.signer_name).toBe('Maria Lopez');
    expect(confirmed.acknowledged_at).not.toBeNull();
    expect(confirmed.delivered_at).not.toBeNull();
    expect(confirmed.window_blown).toBe(false);

    let { data: load } = await service.from('loads').select('status').eq('id', loadId).single();
    expect(load!.status).toBe('delivered');

    // Flag within the open window — recorded, load stays delivered.
    const { data: flagged, error: fErr } = await service.rpc('flag_delivery_discrepancy', {
      p_allocation_id: allocationId, p_reason: '2 trays short', p_actor: null,
    });
    expect(fErr).toBeNull();
    expect(flagged.discrepancy_reason).toBe('2 trays short');
    ({ data: load } = await service.from('loads').select('status').eq('id', loadId).single());
    expect(load!.status).toBe('delivered');

    // Close — the flag does NOT block closing (records, not referees).
    const { data: closed, error: clErr } = await service.rpc('close_delivery_window', {
      p_load_id: loadId, p_actor: null,
    });
    expect(clErr).toBeNull();
    expect(closed.status).toBe('closed');
  });

  test('confirm requires a signer name', async () => {
    const { allocationId } = await scheduledDelivery('nosigner');
    const { error } = await service.rpc('recipient_confirm_delivery', {
      p_allocation_id: allocationId, p_signer_name: '', p_discrepancy_reason: null,
      p_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), p_actor: null,
    });
    expect(error?.message).toContain('SIGNER_REQUIRED');
  });

  test('flagging after the window has closed is rejected', async () => {
    const { allocationId } = await scheduledDelivery('closedwin');
    // Confirm with a window that is ALREADY past.
    const past = new Date(Date.now() - 1000).toISOString();
    const { error: cErr } = await service.rpc('recipient_confirm_delivery', {
      p_allocation_id: allocationId, p_signer_name: 'Sam', p_discrepancy_reason: null,
      p_expires_at: past, p_actor: null,
    });
    expect(cErr).toBeNull();

    const { error } = await service.rpc('flag_delivery_discrepancy', {
      p_allocation_id: allocationId, p_reason: 'arrived late', p_actor: null,
    });
    expect(error?.message).toContain('WINDOW_CLOSED');
  });
});
