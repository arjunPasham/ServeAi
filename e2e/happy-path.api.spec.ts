// TRD acceptance criterion: listing -> live -> purchase -> dispatch -> delivery
// -> payouts, driven RPC-by-RPC against the real DB.
//
// This is the API-level companion to happy-path.ui.spec.ts. The UI spec
// covers the browser-driven register -> verify -> browse -> claim path; this
// spec drives the rest of the state machine (dispatch acceptance + delivery
// confirmation) that requires a courier "arriving", which isn't meaningfully
// testable through a browser session alone. Payouts themselves fire via the
// async 'delivery/confirmed' Inngest event (real Stripe transfers in prod,
// simulated in DEV mode) — confirming the event is queued (confirm_delivery
// succeeding is what triggers it, see src/inngest/functions in the app) is
// as far as a synchronous RPC-level test can assert without also running the
// Inngest worker and polling for job completion.
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

test.describe('happy path: listing -> live -> purchase -> dispatch -> delivery', () => {
  test.beforeAll(() => {
    ctx = newContext('happyapi');
  });

  test.afterAll(async () => {
    await cleanup(ctx);
  });

  test('claim, accept_dispatch, confirm_delivery walk the listing/order through every status', async () => {
    const service = getServiceClient();
    const donor = await createTestUser(ctx, 'donor');
    const consumer = await createTestUser(ctx, 'consumer');
    const courier = await createTestUser(ctx, 'courier');

    // ── listing -> live ──────────────────────────────────────────────────
    const listing = await createLiveListing(ctx, donor.id);
    expect(listing.status).toBe('live');

    // ── purchase ──────────────────────────────────────────────────────────
    const { data: order, error: claimError } = await service.rpc('claim_listing', {
      p_listing_id: listing.id,
      p_consumer_id: consumer.id,
      p_stripe_payment_intent_id: `pi_test_${ctx.runId}`,
    });
    expect(claimError).toBeNull();
    expect(order).toBeTruthy();
    ctx.orderIds.push(order.id);
    expect(order.status).toBe('pending_dispatch');

    const { data: listingAfterClaim } = await service
      .from('listings')
      .select('status')
      .eq('id', listing.id)
      .single();
    expect(listingAfterClaim?.status).toBe('purchased');

    // ── dispatch: offer + accept ────────────────────────────────────────
    const { data: dispatchEvent, error: dispatchInsertError } = await service
      .from('dispatch_events')
      .insert({ order_id: order.id, courier_id: courier.id })
      .select('id')
      .single();
    expect(dispatchInsertError).toBeNull();

    const { error: acceptError } = await service.rpc('accept_dispatch', {
      p_order_id: order.id,
      p_courier_id: courier.id,
      p_dispatch_event_id: dispatchEvent!.id,
    });
    expect(acceptError).toBeNull();

    const { data: orderAfterDispatch } = await service
      .from('orders')
      .select('status, courier_id')
      .eq('id', order.id)
      .single();
    expect(orderAfterDispatch?.status).toBe('dispatched');
    expect(orderAfterDispatch?.courier_id).toBe(courier.id);

    const { data: listingAfterDispatch } = await service
      .from('listings')
      .select('status')
      .eq('id', listing.id)
      .single();
    expect(listingAfterDispatch?.status).toBe('dispatched');

    // ── delivery ─────────────────────────────────────────────────────────
    const { error: deliverError } = await service.rpc('confirm_delivery', {
      p_order_id: order.id,
      p_courier_id: courier.id,
    });
    expect(deliverError).toBeNull();

    const { data: orderAfterDelivery } = await service
      .from('orders')
      .select('status, dispute_window_expires_at')
      .eq('id', order.id)
      .single();
    expect(orderAfterDelivery?.status).toBe('delivered');
    expect(orderAfterDelivery?.dispute_window_expires_at).toBeTruthy();

    const { data: listingAfterDelivery } = await service
      .from('listings')
      .select('status')
      .eq('id', listing.id)
      .single();
    expect(listingAfterDelivery?.status).toBe('delivered');
  });
});
