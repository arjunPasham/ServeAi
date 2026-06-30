'use server';

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { createPaymentIntent } from '@/lib/stripe';
import { inngest } from '@/inngest/client';
import { redirect } from 'next/navigation';

export type ClaimResult =
  | { success: true; clientSecret: string; orderId: string }
  | { success: false; error: string };

export async function claimListing(listingId: string): Promise<ClaimResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const service = await createServiceClient();

  // Fetch listing to get pricing
  const { data: listing, error: listingError } = await service
    .from('listings')
    .select(`
      id, status, consumer_price_cents, donor_payout_cents,
      courier_fee_cents, platform_fee_cents, temperature_sensitive,
      requires_cold_chain:temperature_sensitive,
      donor_id, detected_item, handling_notes,
      donor_profiles!inner(address, address_lat, address_lng)
    `)
    .eq('id', listingId)
    .eq('status', 'live')
    .single();

  if (listingError || !listing) {
    return { success: false, error: 'LISTING_UNAVAILABLE' };
  }

  // We need a placeholder order_id for the payment intent metadata.
  // The actual order is created atomically in claim_listing RPC.
  // We'll update the metadata after the fact (Stripe allows this).
  const placeholderOrderId = crypto.randomUUID();

  // Create Stripe PaymentIntent before claiming (so we have a payment_intent_id for the RPC)
  let paymentIntent;
  try {
    paymentIntent = await createPaymentIntent({
      amountCents: listing.consumer_price_cents,
      listingId,
      orderId: placeholderOrderId,
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

  if (claimError) {
    // Cancel the PaymentIntent since listing claim failed
    try {
      const { stripe } = await import('@/lib/stripe');
      await stripe.paymentIntents.cancel(paymentIntent.id);
    } catch {}

    if (claimError.message?.includes('LISTING_UNAVAILABLE')) {
      return { success: false, error: 'LISTING_UNAVAILABLE' };
    }
    return { success: false, error: 'SERVER_ERROR' };
  }

  const donorProfile = (listing as Record<string, unknown>).donor_profiles as {
    address: string;
    address_lat: number;
    address_lng: number;
  } | null;

  // Fire dispatch event via Inngest immediately after claim
  await inngest.send({
    name: 'dispatch/initiated',
    data: {
      order_id: order.id,
      listing_id: listingId,
      consumer_id: user.id,
      donor_lat: donorProfile?.address_lat ?? 0,
      donor_lng: donorProfile?.address_lng ?? 0,
      requires_cold_chain: listing.temperature_sensitive,
      detected_item: listing.detected_item,
      consumer_price_cents: listing.consumer_price_cents,
    },
  });

  return {
    success: true,
    clientSecret: paymentIntent.client_secret!,
    orderId: order.id,
  };
}

export async function getConsumerOrders() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data } = await supabase
    .from('orders')
    .select(`
      id, status, created_at, delivered_at, dispute_window_expires_at,
      listings(id, detected_item, consumer_price_cents, image_url, donor_id,
        donor_profiles(type))
    `)
    .eq('consumer_id', user.id)
    .order('created_at', { ascending: false });

  return data ?? [];
}

export async function getOrderDetails(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data } = await supabase
    .from('orders')
    .select(`
      id, status, created_at, delivered_at, dispute_window_expires_at,
      stripe_payment_intent_id,
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
