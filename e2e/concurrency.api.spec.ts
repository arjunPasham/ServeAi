// TRD acceptance criterion: two simultaneous purchases of one listing -> exactly
// one succeeds. Exercises claim_listing's SELECT ... FOR UPDATE SKIP LOCKED
// directly against the real DB — no HTTP layer, no browser.
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createTestUser,
  createLiveListing,
  cleanup,
  type TestContext,
} from './helpers';

let ctx: TestContext;

test.describe('claim_listing concurrency', () => {
  test.beforeAll(() => {
    ctx = newContext('conc');
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test('exactly one of two simultaneous claims succeeds; the other raises LISTING_UNAVAILABLE', async () => {
    const service = getServiceClient();
    const donor = await createTestUser(ctx, 'donor');
    const consumerA = await createTestUser(ctx, 'consumer', { emailLabel: 'consumerA' });
    const consumerB = await createTestUser(ctx, 'consumer', { emailLabel: 'consumerB' });
    const listing = await createLiveListing(ctx, donor.id);

    const [resA, resB] = await Promise.allSettled([
      service.rpc('claim_listing', {
        p_listing_id: listing.id,
        p_consumer_id: consumerA.id,
        p_stripe_payment_intent_id: `pi_test_${ctx.runId}_a`,
      }),
      service.rpc('claim_listing', {
        p_listing_id: listing.id,
        p_consumer_id: consumerB.id,
        p_stripe_payment_intent_id: `pi_test_${ctx.runId}_b`,
      }),
    ]);

    // supabase-js resolves RPC application errors into { data: null, error }
    // rather than rejecting the promise — normalize both settlement shapes so
    // the assertions below are correct regardless of which path was taken.
    const outcomes = [resA, resB].map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : { data: null, error: r.reason instanceof Error ? { message: r.reason.message } : r.reason }
    );

    const successes = outcomes.filter((o) => !o.error && o.data);
    const failures = outcomes.filter((o) => o.error);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(String(failures[0].error?.message ?? '')).toContain('LISTING_UNAVAILABLE');

    // Track the order that WAS created so cleanup can remove it.
    const orderId = (successes[0].data as { id: string } | null)?.id;
    expect(orderId).toBeTruthy();
    if (orderId) ctx.orderIds.push(orderId);

    const { data: listingRow } = await service
      .from('listings')
      .select('status')
      .eq('id', listing.id)
      .single();
    expect(listingRow?.status).toBe('purchased');

    const { data: orders } = await service.from('orders').select('id').eq('listing_id', listing.id);
    expect(orders ?? []).toHaveLength(1);
  });
});
