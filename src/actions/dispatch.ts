'use server';

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { inngest } from '@/inngest/client';
import { notifyDeliveryConfirmed } from '@/services/n8n';
import { transferToCourier } from '@/lib/stripe';
import { redirect } from 'next/navigation';

export type DispatchActionResult =
  | { success: true }
  | { success: false; error: string };

export async function acceptDispatch(
  orderId: string,
  dispatchEventId: string
): Promise<DispatchActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const service = await createServiceClient();

  const { error } = await service.rpc('accept_dispatch', {
    p_order_id: orderId,
    p_courier_id: user.id,
    p_dispatch_event_id: dispatchEventId,
  });

  if (error) {
    if (error.message?.includes('ORDER_NOT_AVAILABLE_FOR_DISPATCH')) {
      return { success: false, error: 'ORDER_NOT_AVAILABLE' };
    }
    return { success: false, error: 'SERVER_ERROR' };
  }

  // Update courier availability to false while on delivery
  await service
    .from('courier_profiles')
    .update({ is_available: false })
    .eq('user_id', user.id);

  return { success: true };
}

export async function declineDispatch(
  dispatchEventId: string
): Promise<DispatchActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const service = await createServiceClient();
  await service
    .from('dispatch_events')
    .update({ responded_at: new Date().toISOString(), response: 'declined' })
    .eq('id', dispatchEventId)
    .eq('courier_id', user.id);

  return { success: true };
}

export async function confirmDelivery(orderId: string): Promise<DispatchActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const service = await createServiceClient();

  // Fetch order details for payout
  const { data: order } = await service
    .from('orders')
    .select(`
      id, consumer_id, stripe_payment_intent_id, stripe_charge_id,
      listings!inner(
        id, detected_item, donor_payout_cents, courier_fee_cents,
        donor_id, handling_notes,
        donor_profiles!inner(stripe_account_id)
      )
    `)
    .eq('id', orderId)
    .eq('courier_id', user.id)
    .eq('status', 'dispatched')
    .single();

  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  // Atomically mark delivered
  const { error } = await service.rpc('confirm_delivery', {
    p_order_id: orderId,
    p_courier_id: user.id,
  });

  if (error) {
    return { success: false, error: 'SERVER_ERROR' };
  }

  const listing = (order as Record<string, unknown>).listings as {
    id: string;
    detected_item: string;
    donor_payout_cents: number;
    courier_fee_cents: number;
    donor_id: string;
    handling_notes: string | null;
    donor_profiles: { stripe_account_id: string | null };
  };

  // Fetch courier stripe account
  const { data: courierProfile } = await service
    .from('courier_profiles')
    .select('stripe_account_id')
    .eq('user_id', user.id)
    .single();

  // Unconditional courier payout (does not wait for dispute window)
  if (courierProfile?.stripe_account_id && order.stripe_charge_id) {
    try {
      const courierTransfer = await transferToCourier({
        amountCents: listing.courier_fee_cents,
        courierStripeAccountId: courierProfile.stripe_account_id,
        chargeId: order.stripe_charge_id,
        orderId,
      });

      await service
        .from('orders')
        .update({ courier_transfer_id: courierTransfer.id })
        .eq('id', orderId);

      await service.from('audit_log').insert({
        entity_type: 'order',
        entity_id: orderId,
        event_type: 'courier_payout_released',
        actor_id: user.id,
        actor_role: 'courier',
        payload: {
          transfer_id: courierTransfer.id,
          amount_cents: listing.courier_fee_cents,
        },
      });
    } catch {
      // Log failure but don't block delivery confirmation — payout can be retried manually
      console.error(`Courier transfer failed for order ${orderId}`);
    }
  }

  // Fire Inngest event for dispute window (holds donor payout for 2hr)
  await inngest.send({
    name: 'delivery/confirmed',
    data: {
      order_id: orderId,
      listing_id: listing.id,
      consumer_id: order.consumer_id,
      courier_id: user.id,
      donor_stripe_account_id: listing.donor_profiles?.stripe_account_id ?? '',
      courier_stripe_account_id: courierProfile?.stripe_account_id ?? '',
      donor_payout_cents: listing.donor_payout_cents,
      courier_fee_cents: listing.courier_fee_cents,
      stripe_charge_id: order.stripe_charge_id ?? '',
      detected_item: listing.detected_item,
    },
  });

  // Notify n8n for external integrations
  await notifyDeliveryConfirmed({
    order_id: orderId,
    listing_id: listing.id,
    consumer_id: order.consumer_id,
    courier_id: user.id,
    delivered_at: new Date().toISOString(),
  });

  // Re-enable courier availability
  await service
    .from('courier_profiles')
    .update({ is_available: true })
    .eq('user_id', user.id);

  return { success: true };
}

export async function getCourierActiveOrder() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data } = await supabase
    .from('orders')
    .select(`
      id, status, created_at,
      listings(
        id, detected_item, estimated_quantity_lbs, image_url,
        handling_notes, temperature_sensitive,
        donor_profiles(address, address_lat, address_lng, type)
      ),
      consumer_profiles:consumer_id(delivery_address, delivery_lat, delivery_lng)
    `)
    .eq('courier_id', user.id)
    .eq('status', 'dispatched')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return data;
}

export async function updateCourierLocation(lat: number, lng: number): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const service = await createServiceClient();
  await service.rpc('update_courier_location', {
    p_courier_id: user.id,
    p_lat: lat,
    p_lng: lng,
  });
}

export async function setCourierAvailability(available: boolean): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const service = await createServiceClient();
  await service
    .from('courier_profiles')
    .update({ is_available: available })
    .eq('user_id', user.id);
}

export async function getDispatchOffer(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const service = await createServiceClient();

  // Get the dispatch event for this courier + order
  const { data: dispatchEvent } = await service
    .from('dispatch_events')
    .select('id, response, offered_at')
    .eq('order_id', orderId)
    .eq('courier_id', user.id)
    .is('response', null)
    .single();

  if (!dispatchEvent) return null;

  // Get order + listing details (courier sees pickup address only after acceptance)
  const { data: order } = await service
    .from('orders')
    .select(`
      id, status,
      listings(
        id, detected_item, estimated_quantity_lbs, consumer_price_cents,
        courier_fee_cents, temperature_sensitive, handling_notes, image_url,
        donor_profiles(type, address_lat, address_lng)
      )
    `)
    .eq('id', orderId)
    .single();

  return { dispatchEvent, order };
}
