'use server';

import { createClient, createServiceClient } from '@/lib/supabase/server';
import { inngest } from '@/inngest/client';
import { notifyDeliveryConfirmed } from '@/services/n8n';
import { transferToCourier, canReceiveTransfers } from '@/lib/stripe';
import { redirect } from 'next/navigation';
import {
  consumerSurfaceEnabled,
  consumerDisabledResult,
  assertConsumerSurfaceEnabled,
} from '@/lib/mothballed';

export type DispatchActionResult =
  | { success: true }
  | { success: false; error: string };

export async function acceptDispatch(
  orderId: string,
  dispatchEventId: string
): Promise<DispatchActionResult> {
  // Mothballed pre-pivot courier-dispatch surface (Task 0.4) — gated, not
  // deleted. See src/lib/mothballed.ts. Do not remove this to "fix" a caller.
  if (!consumerSurfaceEnabled()) return consumerDisabledResult();

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
    if (error.message?.includes('DISPATCH_EVENT_INVALID')) {
      return { success: false, error: 'OFFER_EXPIRED' };
    }
    if (error.message?.includes('LISTING_SAFETY_EXPIRED')) {
      return { success: false, error: 'LISTING_SAFETY_EXPIRED' };
    }
    return { success: false, error: 'SERVER_ERROR' };
  }

  // Wake the dispatch workflow so it stops waiting on this offer
  await inngest.send({
    name: 'dispatch/responded',
    data: {
      dispatch_event_id: dispatchEventId,
      order_id: orderId,
      courier_id: user.id,
      response: 'accepted',
    },
  });

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
  // Mothballed pre-pivot courier-dispatch surface (Task 0.4) — gated, not
  // deleted. See src/lib/mothballed.ts. Do not remove this to "fix" a caller.
  if (!consumerSurfaceEnabled()) return consumerDisabledResult();

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const service = await createServiceClient();
  const { data: updated } = await service
    .from('dispatch_events')
    .update({ responded_at: new Date().toISOString(), response: 'declined' })
    .eq('id', dispatchEventId)
    .eq('courier_id', user.id)
    .is('response', null)
    .select('order_id')
    .single();

  // Wake the dispatch workflow so it moves to the next courier immediately
  // instead of sleeping out the rest of the 5-minute window
  if (updated) {
    await inngest.send({
      name: 'dispatch/responded',
      data: {
        dispatch_event_id: dispatchEventId,
        order_id: updated.order_id,
        courier_id: user.id,
        response: 'declined',
      },
    });
  }

  return { success: true };
}

export async function confirmDelivery(orderId: string): Promise<DispatchActionResult> {
  // Mothballed pre-pivot courier-dispatch surface (Task 0.4) — gated, not
  // deleted. See src/lib/mothballed.ts. Do not remove this to "fix" a caller.
  if (!consumerSurfaceEnabled()) return consumerDisabledResult();

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_AUTHENTICATED' };

  const service = await createServiceClient();

  // Fetch order details for payout (donor profile fetched separately — no
  // direct FK between listings and donor_profiles, so PostgREST can't embed it)
  const { data: order } = await service
    .from('orders')
    .select(`
      id, consumer_id, stripe_payment_intent_id, stripe_charge_id,
      listings!inner(
        id, detected_item, donor_payout_cents, courier_fee_cents,
        donor_id, handling_notes
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
    // Cold-chain job hid the listing mid-delivery — food is past its safety
    // window and must not be handed over. Surface a specific code so the UI
    // can tell the courier what happened instead of a generic failure.
    if (error.message?.includes('LISTING_NOT_IN_DISPATCHED_STATE')) {
      return { success: false, error: 'LISTING_EXPIRED_DURING_DELIVERY' };
    }
    if (error.message?.includes('ORDER_NOT_FOUND_OR_INVALID_STATE')) {
      return { success: false, error: 'ORDER_NOT_FOUND' };
    }
    return { success: false, error: 'SERVER_ERROR' };
  }

  const listing = (order as Record<string, unknown>).listings as {
    id: string;
    detected_item: string;
    donor_payout_cents: number;
    courier_fee_cents: number;
    donor_id: string;
    handling_notes: string | null;
  };

  // Fetch donor + courier Stripe accounts
  const [{ data: donorProfile }, { data: courierProfile }] = await Promise.all([
    service
      .from('donor_profiles')
      .select('stripe_account_id')
      .eq('user_id', listing.donor_id)
      .maybeSingle(),
    service
      .from('courier_profiles')
      .select('stripe_account_id, payouts_enabled')
      .eq('user_id', user.id)
      .single(),
  ]);

  // Same eligibility rules as the donor payout path: onboarding must be
  // complete and acct_dev_* ids are never payable outside dev mode.
  const courierEligibility = canReceiveTransfers({
    stripeAccountId: courierProfile?.stripe_account_id,
    payoutsEnabled: courierProfile?.payouts_enabled === true,
  });

  // Courier payout does not wait for the dispute window — PRD §3.2
  if (courierEligibility.ok && courierProfile?.stripe_account_id && order.stripe_charge_id) {
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
      await service.from('audit_log').insert({
        entity_type: 'order',
        entity_id: orderId,
        event_type: 'courier_payout_failed',
        actor_id: null,
        actor_role: 'system',
        payload: { amount_cents: listing.courier_fee_cents },
      });
    }
  } else {
    // Not payable (missing/dev/un-onboarded account, or missing charge) —
    // record it so ops can pay out manually
    await service.from('audit_log').insert({
      entity_type: 'order',
      entity_id: orderId,
      event_type: 'courier_payout_skipped',
      actor_id: null,
      actor_role: 'system',
      payload: {
        amount_cents: listing.courier_fee_cents,
        reason: !courierEligibility.ok ? courierEligibility.reason : 'missing_charge',
        has_stripe_account: Boolean(courierProfile?.stripe_account_id),
        has_charge: Boolean(order.stripe_charge_id),
      },
    });
  }

  // Fire Inngest event for dispute window (holds donor payout for 2hr)
  // and the 30-minute feedback prompt
  await inngest.send({
    name: 'delivery/confirmed',
    data: {
      order_id: orderId,
      listing_id: listing.id,
      consumer_id: order.consumer_id,
      courier_id: user.id,
      donor_stripe_account_id: donorProfile?.stripe_account_id ?? '',
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

  // Service client: the assigned courier needs the donor pickup address and the
  // consumer delivery address, which profile RLS (own-row only) would block.
  // Ownership is enforced by the courier_id filter. Profiles are fetched
  // separately: orders/listings have no direct FK to the profile tables, so
  // PostgREST cannot embed them.
  const service = await createServiceClient();
  const { data: order } = await service
    .from('orders')
    .select(`
      id, status, created_at, consumer_id,
      listings(
        id, donor_id, detected_item, estimated_quantity_lbs, image_url,
        handling_notes, temperature_sensitive
      )
    `)
    .eq('courier_id', user.id)
    .eq('status', 'dispatched')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!order) return null;

  const listing = (order as Record<string, unknown>).listings as { donor_id: string } | null;

  const [{ data: donorProfile }, { data: consumerProfile }] = await Promise.all([
    listing
      ? service
          .from('donor_profiles')
          .select('address, address_lat, address_lng, type')
          .eq('user_id', listing.donor_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    service
      .from('consumer_profiles')
      .select('delivery_address, delivery_lat, delivery_lng')
      .eq('user_id', order.consumer_id)
      .maybeSingle(),
  ]);

  return {
    ...order,
    listings: listing ? { ...listing, donor_profiles: donorProfile } : null,
    consumer_profiles: consumerProfile,
  };
}

export async function getCourierStatus(): Promise<{
  isAvailable: boolean;
  insulated: boolean;
  // True when address validation runs in dev mode (synthetic coords): the
  // dashboard may substitute a default location if the browser denies GPS,
  // so the demo dispatch loop still completes. Never true in production.
  devLocationFallback: boolean;
} | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const service = await createServiceClient();
  const { data } = await service
    .from('courier_profiles')
    .select('is_available, insulated_transport_capable')
    .eq('user_id', user.id)
    .single();

  if (!data) return null;
  return {
    isAvailable: data.is_available ?? false,
    insulated: data.insulated_transport_capable ?? false,
    devLocationFallback: !process.env.SMARTY_AUTH_ID,
  };
}

export async function updateCourierLocation(lat: number, lng: number): Promise<void> {
  // Mothballed pre-pivot courier-dispatch surface (Task 0.4) — gated, not
  // deleted. See src/lib/mothballed.ts. Do not remove this to "fix" a caller.
  assertConsumerSurfaceEnabled('updateCourierLocation');

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return;
  }

  const service = await createServiceClient();
  await service.rpc('update_courier_location', {
    p_courier_id: user.id,
    p_lat: lat,
    p_lng: lng,
  });
}

export async function setCourierAvailability(available: boolean): Promise<void> {
  // Mothballed pre-pivot courier-dispatch surface (Task 0.4) — gated, not
  // deleted. See src/lib/mothballed.ts. Do not remove this to "fix" a caller.
  assertConsumerSurfaceEnabled('setCourierAvailability');

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
    .maybeSingle();

  if (!dispatchEvent) return null;

  // Get order + listing details (courier sees pickup address only after acceptance)
  const { data: order } = await service
    .from('orders')
    .select(`
      id, status,
      listings(
        id, donor_id, detected_item, estimated_quantity_lbs, consumer_price_cents,
        courier_fee_cents, temperature_sensitive, handling_notes, image_url
      )
    `)
    .eq('id', orderId)
    .single();

  // Origin type only pre-acceptance — never the pickup address (PRD §9.2)
  const listing = (order as Record<string, unknown> | null)?.listings as { donor_id: string } | null;
  const { data: donorProfile } = listing
    ? await service
        .from('donor_profiles')
        .select('type, address_lat, address_lng')
        .eq('user_id', listing.donor_id)
        .maybeSingle()
    : { data: null };

  return {
    dispatchEvent,
    order: order
      ? { ...order, listings: listing ? { ...listing, donor_profiles: donorProfile } : null }
      : null,
  };
}

// Unanswered offers still inside the acceptance window — surfaced on the
// courier dashboard so the flow works without real push notifications.
export async function getPendingOffers() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const service = await createServiceClient();
  const windowStart = new Date(Date.now() - 6 * 60 * 1000).toISOString();

  const { data } = await service
    .from('dispatch_events')
    .select('id, order_id, offered_at')
    .eq('courier_id', user.id)
    .is('response', null)
    .gte('offered_at', windowStart)
    .order('offered_at', { ascending: false });

  return data ?? [];
}
