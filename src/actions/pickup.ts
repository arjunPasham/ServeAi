'use server';

// Self-pickup handoff: the consumer shows their pickup code, the donor
// confirms it in the dashboard. Confirming fires the exact same
// delivery/confirmed pipeline as courier/provider deliveries, so the
// dispute-window and feedback logic are untouched.

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { firePostDeliveryPipeline } from '@/lib/delivery/apply';

export type ConfirmPickupResult = { success: true } | { success: false; error: string };

export interface PendingPickup {
  orderId: string;
  detectedItem: string;
  estimatedQuantityLbs: number;
  claimedAt: string;
}

// Pickup orders awaiting handoff at this donor (for the dashboard).
export async function getDonorPendingPickups(): Promise<PendingPickup[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const service = await createServiceClient();
  const { data } = await service
    .from('orders')
    .select('id, created_at, listings!inner(donor_id, detected_item, estimated_quantity_lbs)')
    .eq('fulfillment_method', 'pickup')
    .eq('status', 'pending_dispatch')
    .eq('listings.donor_id', user.id)
    .order('created_at', { ascending: false });

  return (data ?? []).map(row => {
    const listing = (row as Record<string, unknown>).listings as {
      detected_item: string;
      estimated_quantity_lbs: number;
    };
    return {
      orderId: row.id,
      detectedItem: listing.detected_item,
      estimatedQuantityLbs: Number(listing.estimated_quantity_lbs),
      claimedAt: row.created_at,
    };
  });
}

export async function confirmPickup(orderId: string, pickupCode: string): Promise<ConfirmPickupResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  if (!pickupCode.trim()) return { success: false, error: 'CODE_REQUIRED' };

  const service = await createServiceClient();

  const { error } = await service.rpc('confirm_pickup', {
    p_order_id: orderId,
    p_donor_id: user.id,
    p_pickup_code: pickupCode,
  });

  if (error) {
    if (error.message?.includes('PICKUP_NOT_CONFIRMABLE')) {
      return { success: false, error: 'WRONG_CODE_OR_STATE' };
    }
    if (error.message?.includes('LISTING_NOT_IN_DISPATCHED_STATE')) {
      return { success: false, error: 'LISTING_EXPIRED' };
    }
    return { success: false, error: 'SERVER_ERROR' };
  }

  const { data: order, error: orderError } = await service
    .from('orders')
    .select('id, listing_id, consumer_id, stripe_charge_id, listings!inner(donor_id, detected_item, donor_payout_cents)')
    .eq('id', orderId)
    .single();
  if (orderError || !order) {
    // Handoff is committed; the pipeline just couldn't start — surface it.
    console.error(`confirmPickup: post-confirm fetch failed for ${orderId}: ${orderError?.message}`);
    return { success: true };
  }

  const listing = (order as Record<string, unknown>).listings as {
    donor_id: string;
    detected_item: string;
    donor_payout_cents: number;
  };

  try {
    await firePostDeliveryPipeline({
      orderId: order.id,
      listingId: order.listing_id,
      consumerId: order.consumer_id,
      donorId: listing.donor_id,
      detectedItem: listing.detected_item,
      donorPayoutCents: listing.donor_payout_cents,
      stripeChargeId: order.stripe_charge_id,
    });
  } catch (err) {
    console.error(`confirmPickup: post-delivery pipeline failed for ${orderId}:`, err);
  }

  return { success: true };
}
