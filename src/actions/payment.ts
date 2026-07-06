'use server';

import { createClient, createServiceClient } from '@/lib/supabase/server';
import {
  createPaymentIntent,
  attachOrderToPaymentIntent,
  cancelPaymentIntent,
  isStripeDevMode,
} from '@/lib/stripe';
import { inngest } from '@/inngest/client';
import { fireDispatch } from '@/lib/dispatch-events';
import { redirect } from 'next/navigation';

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
  | { success: false; error: string };

export async function claimListing(listingId: string): Promise<ClaimResult> {
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

  // Create the PaymentIntent first so claim_listing can store its id.
  // Metadata gets the real order_id attached right after the claim succeeds.
  let paymentIntent;
  try {
    paymentIntent = await createPaymentIntent({
      amountCents: listing.consumer_price_cents,
      listingId,
      orderId: 'pending_claim',
      donorPayoutCents: listing.donor_payout_cents,
      courierFeeCents: listing.courier_fee_cents,
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

  if (isStripeDevMode()) {
    // Simulated capture: record the synthetic charge and dispatch immediately
    await service
      .from('orders')
      .update({ stripe_charge_id: (paymentIntent.latest_charge as string) ?? null })
      .eq('id', order.id);

    await fireDispatch(order.id, listingId, user.id);

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
      listings(
        id, detected_item, estimated_quantity_lbs, consumer_price_cents,
        image_url, handling_notes, temperature_sensitive
      )
    `)
    .eq('id', orderId)
    .eq('consumer_id', user.id)
    .single();

  return data;
}
