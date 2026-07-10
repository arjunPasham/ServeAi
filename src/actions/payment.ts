'use server';

import { randomBytes } from 'crypto';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import {
  createPaymentIntent,
  attachOrderToPaymentIntent,
  cancelPaymentIntent,
  isStripeDevMode,
} from '@/lib/stripe';
import { inngest } from '@/inngest/client';
import { getDeliveryMode, getDeliveryProvider } from '@/lib/delivery';
import { initiateFulfillment, quoteForOrder } from '@/lib/delivery/initiate';
import { redirect } from 'next/navigation';

export type FulfillmentMethod = 'delivery' | 'pickup';

// Unambiguous 6-char handoff code (no 0/O/1/I).
function generatePickupCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), b => alphabet[b % alphabet.length]).join('');
}

export type DeliveryQuoteResult =
  | { success: true; feeCents: number; etaMinutes: number; expiresAt: string }
  | { success: false; error: string };

// Checkout-time delivery quote for the fulfillment chooser. Quotes expire in
// ~15 minutes, so this is called when the consumer opens the chooser — never
// at listing time.
export async function getDeliveryQuote(listingId: string): Promise<DeliveryQuoteResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const quote = await quoteForOrder(listingId, user.id);
  if ('error' in quote) return { success: false, error: quote.error };
  return {
    success: true,
    feeCents: quote.feeCents,
    etaMinutes: quote.etaMinutes,
    expiresAt: quote.expiresAt,
  };
}

export type ClaimResult =
  | {
      success: true;
      orderId: string;
      // When true, the client must complete card payment (Stripe Elements)
      // before dispatch happens. When false (dev mode), payment was simulated
      // and dispatch is already underway.
      checkout: boolean;
      clientSecret: string | null;
    }
  // error === 'FEE_CHANGED' carries the fresh quote so the chooser can show
  // the delta and ask the consumer to confirm before anything is charged.
  | { success: false; error: string; newFeeCents?: number; etaMinutes?: number };

export async function claimListing(
  listingId: string,
  fulfillment: FulfillmentMethod = 'delivery',
  // The delivery fee the consumer saw in the chooser. Quotes expire (~15 min)
  // and are re-fetched here at claim time — if the fresh quote differs from
  // what was displayed, we refuse to charge and return FEE_CHANGED instead.
  expectedFeeCents?: number
): Promise<ClaimResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const service = await createServiceClient();

  // Fetch listing to get pricing (donor coords are resolved later by fireDispatch)
  const { data: listing, error: listingError } = await service
    .from('listings')
    .select(`
      id, status, consumer_price_cents, donor_payout_cents,
      courier_fee_cents, platform_fee_cents, temperature_sensitive,
      donor_id, detected_item, handling_notes
    `)
    .eq('id', listingId)
    .eq('status', 'live')
    .single();

  if (listingError || !listing) {
    return { success: false, error: 'LISTING_UNAVAILABLE' };
  }

  // Amount depends on fulfillment. Listing prices historically bake in the
  // legacy flat courier fee — strip it out and add the real cost instead:
  //   pickup   → food + platform fee (free handoff at the donor)
  //   delivery → food + platform fee + provider quote, passed through at cost
  // DELIVERY_MODE=internal keeps the legacy all-inclusive price + fleet.
  const internalMode = getDeliveryMode() === 'internal';
  const baseCents = listing.consumer_price_cents - listing.courier_fee_cents;
  let amountCents = listing.consumer_price_cents;
  let deliveryFeeCents: number | null = null;

  if (!internalMode) {
    if (fulfillment === 'pickup') {
      amountCents = baseCents;
    } else {
      const quote = await quoteForOrder(listingId, user.id);
      if ('error' in quote) {
        // No deliverable quote (e.g. unvalidated address in real mode) —
        // the consumer can still pick up.
        return { success: false, error: 'DELIVERY_UNAVAILABLE' };
      }
      if (typeof expectedFeeCents === 'number' && quote.feeCents !== expectedFeeCents) {
        return {
          success: false,
          error: 'FEE_CHANGED',
          newFeeCents: quote.feeCents,
          etaMinutes: quote.etaMinutes,
        };
      }
      deliveryFeeCents = quote.feeCents;
      amountCents = baseCents + quote.feeCents;
    }
  }

  // Create the PaymentIntent first so claim_listing can store its id.
  // Metadata gets the real order_id attached right after the claim succeeds.
  let paymentIntent;
  try {
    paymentIntent = await createPaymentIntent({
      amountCents,
      listingId,
      orderId: 'pending_claim',
      donorPayoutCents: listing.donor_payout_cents,
      courierFeeCents: deliveryFeeCents ?? (internalMode ? listing.courier_fee_cents : 0),
      platformFeeCents: listing.platform_fee_cents,
    });
  } catch {
    return { success: false, error: 'PAYMENT_ERROR' };
  }

  // Atomically claim the listing and create the order
  const { data: order, error: claimError } = await service.rpc('claim_listing', {
    p_listing_id: listingId,
    p_consumer_id: user.id,
    p_stripe_payment_intent_id: paymentIntent.id,
  });

  if (claimError || !order) {
    // Cancel the PaymentIntent since listing claim failed
    try {
      await cancelPaymentIntent(paymentIntent.id);
    } catch {}

    if (claimError?.message?.includes('LISTING_UNAVAILABLE')) {
      return { success: false, error: 'LISTING_UNAVAILABLE' };
    }
    return { success: false, error: 'SERVER_ERROR' };
  }

  // Attach the real order id to the PI so webhook audit records line up
  try {
    await attachOrderToPaymentIntent(paymentIntent.id, order.id);
  } catch {}

  // Record fulfillment details the claim RPC doesn't know about. pickup_code
  // is minted for pickup orders; the donor verifies it at handoff.
  const { error: fulfillmentError } = await service
    .from('orders')
    .update({
      fulfillment_method: internalMode ? 'delivery' : fulfillment,
      delivery_fee_cents: deliveryFeeCents,
      ...(fulfillment === 'pickup' && !internalMode ? { pickup_code: generatePickupCode() } : {}),
      ...(fulfillment === 'delivery' && !internalMode
        ? { delivery_provider: getDeliveryProvider().name }
        : {}),
    })
    .eq('id', order.id);
  if (fulfillmentError) {
    console.error(`claimListing: fulfillment update failed for ${order.id}: ${fulfillmentError.message}`);
  }

  if (isStripeDevMode()) {
    // Simulated capture: record the synthetic charge and start fulfillment
    await service
      .from('orders')
      .update({ stripe_charge_id: (paymentIntent.latest_charge as string) ?? null })
      .eq('id', order.id);

    await initiateFulfillment(order.id, listingId, user.id);

    return { success: true, orderId: order.id, checkout: false, clientSecret: null };
  }

  // Real mode: courier dispatch fires from the payment_intent.succeeded webhook —
  // never before the consumer is actually charged (PRD §7.3). A watchdog reverts
  // the claim if payment isn't completed in time.
  await inngest.send({
    name: 'order/claimed',
    data: {
      order_id: order.id,
      listing_id: listingId,
      payment_intent_id: paymentIntent.id,
    },
  });

  return {
    success: true,
    orderId: order.id,
    checkout: true,
    clientSecret: paymentIntent.client_secret,
  };
}

export async function getConsumerOrders() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Service client: RLS only exposes 'live' listings to consumers, which would
  // blank out item details on purchased/delivered orders. Ownership is enforced
  // by the explicit consumer_id filter.
  const service = await createServiceClient();
  const { data } = await service
    .from('orders')
    .select(`
      id, status, created_at, delivered_at, dispute_window_expires_at,
      listings(id, detected_item, consumer_price_cents, image_url, donor_id)
    `)
    .eq('consumer_id', user.id)
    .order('created_at', { ascending: false });

  return data ?? [];
}

export async function getOrderDetails(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const service = await createServiceClient();
  const { data } = await service
    .from('orders')
    .select(`
      id, status, created_at, delivered_at, dispute_window_expires_at,
      stripe_payment_intent_id, stripe_charge_id,
      fulfillment_method, delivery_provider, delivery_external_id,
      delivery_fee_cents, delivery_tracking_url, delivery_status, pickup_code,
      listings(
        id, detected_item, estimated_quantity_lbs, consumer_price_cents,
        courier_fee_cents, image_url, handling_notes, temperature_sensitive
      )
    `)
    .eq('id', orderId)
    .eq('consumer_id', user.id)
    .single();

  return data;
}

// Reconcile-on-read: pull the provider's current state for an active delivery
// so the order page never shows stale status even if a webhook was lost and
// the cron reconciler hasn't run yet.
export async function syncDeliveryStatus(orderId: string): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const service = await createServiceClient();
  const { data: order } = await service
    .from('orders')
    .select('id, delivery_external_id, status')
    .eq('id', orderId)
    .eq('consumer_id', user.id)
    .maybeSingle();

  if (!order?.delivery_external_id) return;
  if (order.status !== 'pending_dispatch' && order.status !== 'dispatched') return;

  try {
    const { getDeliveryProvider: getProvider } = await import('@/lib/delivery');
    const { applyDeliveryStatus } = await import('@/lib/delivery/apply');
    const state = await getProvider().getDelivery(order.delivery_external_id);
    await applyDeliveryStatus(state);
  } catch (err) {
    // Non-fatal: the cron reconciler is the reliability backstop
    console.error(`syncDeliveryStatus failed for ${orderId}:`, err);
  }
}
