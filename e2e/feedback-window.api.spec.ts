// Bonus criterion (guards Step 11/16 work): submit_feedback's 2-hour dispute
// window. Seeds 'delivered' orders directly (bypassing claim/dispatch/deliver)
// since submit_feedback only cares about order status + dispute_window_expires_at.
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createTestUser,
  createLiveListing,
  createOrder,
  cleanup,
  type TestContext,
} from './helpers';

let ctx: TestContext;

test.describe('submit_feedback dispute window', () => {
  test.beforeAll(() => {
    ctx = newContext('fbwin');
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test('issue_reported after the window closes raises DISPUTE_WINDOW_EXPIRED and leaves the order untouched', async () => {
    const service = getServiceClient();
    const donor = await createTestUser(ctx, 'donor');
    const consumer = await createTestUser(ctx, 'consumer');
    const listing = await createLiveListing(ctx, donor.id);
    const order = await createOrder(ctx, {
      listingId: listing.id,
      consumerId: consumer.id,
      status: 'delivered',
      disputeWindowExpiresAt: new Date(Date.now() - 60 * 1000).toISOString(), // closed 1 min ago
    });

    const { error } = await service.rpc('submit_feedback', {
      p_order_id: order.id,
      p_consumer_id: consumer.id,
      p_outcome: 'issue_reported',
      p_photo_url: 'dispute-photos/e2e-test.jpg',
    });

    expect(error).not.toBeNull();
    expect(error?.message ?? '').toContain('DISPUTE_WINDOW_EXPIRED');

    const { data: after } = await service.from('orders').select('status').eq('id', order.id).single();
    expect(after?.status).toBe('delivered');
  });

  test('issue_reported inside the window succeeds and marks the order disputed', async () => {
    const service = getServiceClient();
    const donor = await createTestUser(ctx, 'donor', { emailLabel: 'donor2' });
    const consumer = await createTestUser(ctx, 'consumer', { emailLabel: 'consumer2' });
    const listing = await createLiveListing(ctx, donor.id, {
      detectedItem: `E2E Test Meal ${ctx.runId}-2`,
    });
    const order = await createOrder(ctx, {
      listingId: listing.id,
      consumerId: consumer.id,
      status: 'delivered',
      disputeWindowExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // open for 1h
    });

    const { error } = await service.rpc('submit_feedback', {
      p_order_id: order.id,
      p_consumer_id: consumer.id,
      p_outcome: 'issue_reported',
      p_photo_url: 'dispute-photos/e2e-test.jpg',
    });

    expect(error).toBeNull();

    const { data: after } = await service.from('orders').select('status').eq('id', order.id).single();
    expect(after?.status).toBe('disputed');
  });
});
