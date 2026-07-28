// v3 Task 4 — the no-login recipient browser flow, closing the still-open Phase 2
// Task 5 gap (offer -> /inbound -> accept in a real browser) AND covering the v3
// Task 2 recipient-confirm UI. Both seed via the service client, then drive the
// public /inbound/[token] page with no auth (the token in the URL is the whole
// capability). Runs against `npm run dev` (playwright ui project).
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

async function offeredToken(label: string): Promise<{ token: string; loadId: string; allocationId: string; merchantId: string; userId: string }> {
  const user = await createTestUser(ctx, 'donor', { emailLabel: label });
  const { merchantId } = await createMerchant(ctx, user.id);
  const { loadId } = await createDeclaredLoad(ctx, {
    merchantId, scannedBy: user.id, items: [{ categoryKey: 'BAKERY', foodName: 'Croissants', estLbs: 6 }],
  });
  const { institutionId } = await createInstitution(ctx, { orgName: `E2E Inbound UI ${ctx.runId} ${label}`, npoVerified: true });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data: alloc, error } = await service.rpc('offer_load', {
    p_load_id: loadId, p_institution_id: institutionId, p_offered_by: user.id, p_expires_at: expiresAt,
  });
  if (error || !alloc) throw new Error(`offer_load: ${error?.message}`);
  const { data: row } = await service.from('allocations').select('public_view_token').eq('id', alloc.id).single();
  return { token: row!.public_view_token as string, loadId, allocationId: alloc.id, merchantId, userId: user.id };
}

test.describe('inbound recipient flow (no-login, browser)', () => {
  test.beforeAll(() => { ctx = newContext('inboundui'); });
  test.afterAll(async () => { await cleanup(ctx); });

  test('offer → open link → accept flips the allocation + load', async ({ page }) => {
    const { token, loadId, allocationId } = await offeredToken('accept');

    await page.goto(`/inbound/${token}`);
    await expect(page.getByText('Croissants', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Accept' }).click();

    // Lands on the accepted view.
    await expect(page.getByText(/accepted this load/i)).toBeVisible();

    const { data: alloc } = await service.from('allocations').select('status').eq('id', allocationId).single();
    expect(alloc!.status).toBe('accepted');
    const { data: load } = await service.from('loads').select('status').eq('id', loadId).single();
    expect(load!.status).toBe('matched');
  });

  test('accepted + scheduled → open link → confirm receipt marks the load delivered', async ({ page }) => {
    const { token, loadId, allocationId, merchantId, userId } = await offeredToken('confirm');
    // Accept + schedule server-side so the page shows the confirm form.
    await service.rpc('respond_to_offer', { p_allocation_id: allocationId, p_decision: 'accepted', p_actor: null, p_decline_reason: null });
    await service.rpc('set_delivery_method', {
      p_load_id: loadId, p_merchant_id: merchantId, p_allocation_id: allocationId,
      p_method: 'pickup', p_responsible_party: 'recipient', p_notes: null, p_actor: userId,
    });

    await page.goto(`/inbound/${token}`);
    await page.getByLabel('Received by (your name)').fill('Priya K.');
    await page.getByRole('button', { name: 'Confirm receipt' }).click();

    await expect(page.getByText(/Receipt confirmed/i)).toBeVisible();

    const { data: load } = await service.from('loads').select('status').eq('id', loadId).single();
    expect(load!.status).toBe('delivered');
    const { data: delivery } = await service.from('deliveries').select('signer_name, acknowledged_at').eq('load_id', loadId).single();
    expect(delivery!.signer_name).toBe('Priya K.');
    expect(delivery!.acknowledged_at).not.toBeNull();
  });
});
