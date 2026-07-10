// Server-only: post-payment fulfillment kickoff + checkout-time quoting.
// Called from the dev-mode claim path and the payment_intent.succeeded webhook
// (exactly where fireDispatch used to be called).

import { createServiceClient } from '@/lib/supabase/server';
import { fireDispatch } from '@/lib/dispatch-events';
import { refundOrderPayment } from '@/lib/stripe';
import { sendPushToUser } from '@/lib/onesignal';
import {
  getDeliveryMode,
  getDeliveryProvider,
  DeliveryAddress,
  DeliveryItem,
  DeliveryQuote,
} from '@/lib/delivery';

interface QuoteContext {
  pickup: DeliveryAddress;
  dropoff: DeliveryAddress;
  items: DeliveryItem[];
  handlingNotes: string | null;
  temperatureSensitive: boolean;
}

/** Assemble provider addresses/items for a listing + consumer pair. */
export async function buildQuoteContext(
  listingId: string,
  consumerId: string
): Promise<QuoteContext | { error: string }> {
  const service = await createServiceClient();

  const { data: listing, error: listingError } = await service
    .from('listings')
    .select('id, donor_id, detected_item, estimated_quantity_lbs, temperature_sensitive, handling_notes')
    .eq('id', listingId)
    .single();
  if (listingError || !listing) return { error: 'LISTING_NOT_FOUND' };

  const [{ data: donorProfile }, { data: consumerProfile }, { data: donorUser }, { data: consumerUser }] =
    await Promise.all([
      service
        .from('donor_profiles')
        .select('address, address_lat, address_lng, address_validated, business_name')
        .eq('user_id', listing.donor_id)
        .maybeSingle(),
      service
        .from('consumer_profiles')
        .select('delivery_address, delivery_lat, delivery_lng, address_validated, organization_name')
        .eq('user_id', consumerId)
        .maybeSingle(),
      service.from('users').select('phone').eq('id', listing.donor_id).maybeSingle(),
      service.from('users').select('phone').eq('id', consumerId).maybeSingle(),
    ]);

  if (!donorProfile || !consumerProfile) return { error: 'PROFILE_NOT_FOUND' };

  return {
    pickup: {
      addressLine: donorProfile.address,
      lat: donorProfile.address_lat,
      lng: donorProfile.address_lng,
      validated: donorProfile.address_validated === true,
      name: donorProfile.business_name ?? 'FoodLink donor',
      phone: donorUser?.phone ?? null,
    },
    dropoff: {
      addressLine: consumerProfile.delivery_address,
      lat: consumerProfile.delivery_lat,
      lng: consumerProfile.delivery_lng,
      validated: consumerProfile.address_validated === true,
      name: consumerProfile.organization_name ?? 'FoodLink consumer',
      phone: consumerUser?.phone ?? null,
    },
    items: [
      {
        name: listing.detected_item,
        quantityLbs: Number(listing.estimated_quantity_lbs),
        temperatureSensitive: listing.temperature_sensitive,
      },
    ],
    handlingNotes: listing.handling_notes,
    temperatureSensitive: listing.temperature_sensitive,
  };
}

/** Checkout-time quote (quotes expire in ~15 min — never quote at listing time). */
export async function quoteForOrder(
  listingId: string,
  consumerId: string
): Promise<DeliveryQuote | { error: string }> {
  const ctx = await buildQuoteContext(listingId, consumerId);
  if ('error' in ctx) return ctx;
  try {
    return await getDeliveryProvider().quote(ctx.pickup, ctx.dropoff, ctx.items);
  } catch (err) {
    console.error(`quoteForOrder failed for listing ${listingId}:`, err);
    return { error: 'QUOTE_UNAVAILABLE' };
  }
}

/**
 * Post-payment: start the right fulfillment for the order.
 * - pickup            → notify the donor; the pickup_code is already on the order
 * - delivery/internal → legacy courier dispatch loop (DELIVERY_MODE=internal)
 * - delivery/provider → create the provider delivery; on failure, refund —
 *                       perishable food never sits in limbo
 */
export async function initiateFulfillment(
  orderId: string,
  listingId: string,
  consumerId: string
): Promise<void> {
  const service = await createServiceClient();

  const { data: order, error } = await service
    .from('orders')
    .select('id, fulfillment_method, delivery_external_id, stripe_payment_intent_id, pickup_code')
    .eq('id', orderId)
    .single();
  if (error || !order) {
    throw new Error(`initiateFulfillment: order ${orderId} not found: ${error?.message}`);
  }

  if (order.fulfillment_method === 'pickup') {
    const { data: listing } = await service
      .from('listings')
      .select('donor_id, detected_item')
      .eq('id', listingId)
      .single();
    if (listing) {
      await sendPushToUser({
        externalUserId: listing.donor_id,
        title: 'Pickup order — get it ready',
        body: `"${listing.detected_item}" was just claimed for self-pickup. The consumer will show code ${order.pickup_code}.`,
        data: { order_id: orderId, type: 'pickup_claimed' },
      });
    }
    return;
  }

  if (getDeliveryMode() === 'internal') {
    await fireDispatch(orderId, listingId, consumerId);
    return;
  }

  // Idempotency: webhook retries must not create a second delivery
  if (order.delivery_external_id) return;

  const ctx = await buildQuoteContext(listingId, consumerId);
  if ('error' in ctx) {
    throw new Error(`initiateFulfillment: ${ctx.error} for order ${orderId}`);
  }

  const provider = getDeliveryProvider();
  try {
    // Fresh quote for a valid quote id — the checkout-time quote may have
    // expired while the consumer completed payment. The consumer's price is
    // locked; small fee drift is absorbed by the platform.
    const quote = await provider.quote(ctx.pickup, ctx.dropoff, ctx.items);
    const coldChainNote = ctx.temperatureSensitive
      ? 'Temperature-sensitive food — insulated bag recommended.'
      : null;
    const creation = await provider.createDelivery(quote.quoteId, {
      orderId,
      pickup: ctx.pickup,
      dropoff: ctx.dropoff,
      items: ctx.items,
      pickupInstructions: [ctx.handlingNotes, coldChainNote].filter(Boolean).join(' ') || null,
    });

    // Conditional update (same shape as the connect-onboarding race fix):
    // concurrent webhook retries can both reach createDelivery, so only the
    // writer that finds delivery_external_id still null keeps its delivery —
    // the loser cancels the duplicate it just created.
    const { data: updated, error: updateError } = await service
      .from('orders')
      .update({
        delivery_provider: provider.name,
        delivery_external_id: creation.deliveryId,
        delivery_tracking_url: creation.trackingUrl,
        delivery_status: 'pending',
      })
      .eq('id', orderId)
      .is('delivery_external_id', null)
      .select('id');
    if (updateError) {
      throw new Error(`initiateFulfillment: order update failed for ${orderId}: ${updateError.message}`);
    }
    if (!updated?.length) {
      console.warn(`initiateFulfillment: concurrent delivery creation for ${orderId} — canceling duplicate ${creation.deliveryId}`);
      await provider.cancel(creation.deliveryId);
      return;
    }

    await service.from('audit_log').insert({
      entity_type: 'order',
      entity_id: orderId,
      event_type: 'provider_delivery_created',
      actor_id: null,
      actor_role: 'system',
      payload: {
        provider: provider.name,
        delivery_id: creation.deliveryId,
        fee_cents: quote.feeCents,
        tracking_url: creation.trackingUrl,
      },
    });
  } catch (err) {
    // Payment already captured but no courier is coming — refund immediately
    // and release the listing rather than leaving perishable food in limbo.
    console.error(`initiateFulfillment: provider delivery creation failed for ${orderId}:`, err);
    await refundOrderPayment({
      paymentIntentId: order.stripe_payment_intent_id,
      orderId,
      reason: 'delivery_creation_failed',
    });
    await service.from('orders').update({ status: 'refunded' }).eq('id', orderId).eq('status', 'pending_dispatch');
    const { error: revertError } = await service.rpc('revert_listing_to_live', {
      p_listing_id: listingId,
      p_reason: 'delivery_creation_failed',
    });
    if (revertError) {
      // Listing may be past its safety window (hidden) — not fatal, but never silent.
      console.error(`initiateFulfillment: revert_listing_to_live failed for ${listingId}: ${revertError.message}`);
    }
    await service.from('audit_log').insert({
      entity_type: 'order',
      entity_id: orderId,
      event_type: 'refunded',
      actor_id: null,
      actor_role: 'system',
      payload: { reason: 'delivery_creation_failed', error: err instanceof Error ? err.message : String(err) },
    });
  }
}
