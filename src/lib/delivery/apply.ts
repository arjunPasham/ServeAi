// Server-only: applies a provider-normalized delivery event to an order.
// Both ingestion paths — the Uber webhook route AND the polling reconciler —
// funnel through here, so a lost webhook and a poll result produce identical
// state transitions, all idempotent. Same philosophy as the dispute-window
// fix: no status update may fail invisibly, so DB errors throw.

import { createServiceClient } from '@/lib/supabase/server';
import { inngest } from '@/inngest/client';
import { refundOrderPayment } from '@/lib/stripe';
import { sendPushToUser } from '@/lib/onesignal';
import { sendEmail, getUserEmail } from '@/lib/email';
import { notifyDeliveryConfirmed } from '@/services/n8n';
import { NormalizedDeliveryEvent } from './types';

interface DeliveryOrderRow {
  id: string;
  status: string;
  consumer_id: string;
  listing_id: string;
  stripe_payment_intent_id: string;
  stripe_charge_id: string | null;
  delivery_status: string | null;
  delivery_tracking_url: string | null;
  listings: {
    id: string;
    donor_id: string;
    detected_item: string;
    donor_payout_cents: number;
    courier_fee_cents: number;
  };
}

async function findOrderByDeliveryId(deliveryId: string): Promise<DeliveryOrderRow | null> {
  const service = await createServiceClient();
  const { data, error } = await service
    .from('orders')
    .select(
      `id, status, consumer_id, listing_id, stripe_payment_intent_id, stripe_charge_id,
       delivery_status, delivery_tracking_url,
       listings!inner(id, donor_id, detected_item, donor_payout_cents, courier_fee_cents)`
    )
    .eq('delivery_external_id', deliveryId)
    .maybeSingle();
  if (error) {
    throw new Error(`delivery-apply: order lookup failed for delivery ${deliveryId}: ${error.message}`);
  }
  return data as unknown as DeliveryOrderRow | null;
}

async function audit(orderId: string, eventType: string, payload: Record<string, unknown>) {
  const service = await createServiceClient();
  const { error } = await service.from('audit_log').insert({
    entity_type: 'order',
    entity_id: orderId,
    event_type: eventType,
    actor_id: null,
    actor_role: 'system',
    payload,
  });
  if (error) {
    throw new Error(`delivery-apply: audit insert failed for ${orderId}: ${error.message}`);
  }
}

/**
 * Post-'delivered' pipeline shared by every fulfillment path (provider
 * delivery AND self-pickup): dispute window + feedback prompt via the
 * delivery/confirmed event, n8n forwarding, consumer push. The courier fields
 * are empty — there is no internal courier on these paths.
 */
export async function firePostDeliveryPipeline(params: {
  orderId: string;
  listingId: string;
  consumerId: string;
  donorId: string;
  detectedItem: string;
  donorPayoutCents: number;
  stripeChargeId: string | null;
}): Promise<void> {
  const service = await createServiceClient();
  const { data: donorProfile, error: donorError } = await service
    .from('donor_profiles')
    .select('stripe_account_id')
    .eq('user_id', params.donorId)
    .maybeSingle();
  if (donorError) {
    throw new Error(`delivery-apply: donor profile lookup failed for ${params.orderId}: ${donorError.message}`);
  }

  await inngest.send({
    name: 'delivery/confirmed',
    data: {
      order_id: params.orderId,
      listing_id: params.listingId,
      consumer_id: params.consumerId,
      courier_id: '', // no internal courier on provider/pickup paths
      donor_stripe_account_id: donorProfile?.stripe_account_id ?? '',
      courier_stripe_account_id: '',
      donor_payout_cents: params.donorPayoutCents,
      courier_fee_cents: 0,
      stripe_charge_id: params.stripeChargeId ?? '',
      detected_item: params.detectedItem,
    },
  });

  await notifyDeliveryConfirmed({
    order_id: params.orderId,
    listing_id: params.listingId,
    consumer_id: params.consumerId,
    courier_id: '',
    delivered_at: new Date().toISOString(),
  });

  await sendPushToUser({
    externalUserId: params.consumerId,
    title: 'Your order was delivered',
    body: `"${params.detectedItem}" has arrived. Enjoy!`,
    data: { order_id: params.orderId, type: 'delivery_confirmed' },
  });
}

/**
 * Idempotently advance an order to match the provider's reported status.
 * Returns what changed (for logs/step results).
 */
export async function applyDeliveryStatus(
  event: NormalizedDeliveryEvent
): Promise<{ applied: boolean; orderId?: string; transition?: string }> {
  const order = await findOrderByDeliveryId(event.deliveryId);
  if (!order) {
    // Unknown delivery id — either forged or an order we already cleaned up.
    return { applied: false };
  }

  const service = await createServiceClient();

  // Always keep the granular provider status + tracking URL current.
  if (order.delivery_status !== event.status || (event.trackingUrl && !order.delivery_tracking_url)) {
    const { error } = await service
      .from('orders')
      .update({
        delivery_status: event.status,
        ...(event.trackingUrl ? { delivery_tracking_url: event.trackingUrl } : {}),
      })
      .eq('id', order.id);
    if (error) {
      throw new Error(`delivery-apply: delivery_status update failed for ${order.id}: ${error.message}`);
    }
  }

  switch (event.status) {
    case 'pending':
      return { applied: true, orderId: order.id, transition: 'noop' };

    case 'courier_assigned':
    case 'picked_up': {
      // pending_dispatch → dispatched (once). Listing purchased → dispatched.
      if (order.status !== 'pending_dispatch') {
        return { applied: true, orderId: order.id, transition: 'already_dispatched' };
      }
      const { data: updated, error } = await service
        .from('orders')
        .update({ status: 'dispatched' })
        .eq('id', order.id)
        .eq('status', 'pending_dispatch')
        .select('id');
      if (error) {
        throw new Error(`delivery-apply: dispatch update failed for ${order.id}: ${error.message}`);
      }
      if (updated?.length) {
        const { error: listingError } = await service
          .from('listings')
          .update({ status: 'dispatched', dispatched_at: new Date().toISOString() })
          .eq('id', order.listing_id)
          .eq('status', 'purchased');
        if (listingError) {
          throw new Error(`delivery-apply: listing dispatch update failed for ${order.listing_id}: ${listingError.message}`);
        }
        await audit(order.id, 'provider_courier_assigned', {
          delivery_id: event.deliveryId,
          raw_status: event.rawStatus,
          tracking_url: event.trackingUrl,
        });
      }
      return { applied: true, orderId: order.id, transition: 'dispatched' };
    }

    case 'delivered': {
      if (order.status === 'delivered') {
        return { applied: true, orderId: order.id, transition: 'already_delivered' };
      }
      // Atomic system-path transition (mirrors confirm_delivery, no courier).
      const { error: rpcError } = await service.rpc('confirm_provider_delivery', {
        p_order_id: order.id,
      });
      if (rpcError) {
        // Cold-chain hid the listing mid-delivery, or state already moved on.
        // Surface it — the reconciler/webhook retry will observe the new state.
        throw new Error(`delivery-apply: confirm_provider_delivery failed for ${order.id}: ${rpcError.message}`);
      }

      // No courier fee — Uber invoices the platform; the fee was collected
      // from the consumer at checkout.
      await firePostDeliveryPipeline({
        orderId: order.id,
        listingId: order.listing_id,
        consumerId: order.consumer_id,
        donorId: order.listings.donor_id,
        detectedItem: order.listings.detected_item,
        donorPayoutCents: order.listings.donor_payout_cents,
        stripeChargeId: order.stripe_charge_id,
      });

      return { applied: true, orderId: order.id, transition: 'delivered' };
    }

    case 'canceled':
    case 'returned': {
      if (order.status === 'refunded' || order.status === 'delivered') {
        return { applied: true, orderId: order.id, transition: 'already_terminal' };
      }
      // Perishable food must never sit in limbo: auto-refund and tell the
      // consumer they can re-order for self-pickup if the food is still good.
      await refundOrderPayment({
        paymentIntentId: order.stripe_payment_intent_id,
        orderId: order.id,
        reason: `delivery_${event.status}`,
      });

      const { error: refundError } = await service
        .from('orders')
        .update({ status: 'refunded' })
        .eq('id', order.id)
        .in('status', ['pending_dispatch', 'dispatched']);
      if (refundError) {
        throw new Error(`delivery-apply: refund status update failed for ${order.id}: ${refundError.message}`);
      }

      // Relist only if the food never left the donor (courier never picked up).
      const foodStillAtDonor =
        order.delivery_status === null ||
        ['pending', 'courier_assigned'].includes(order.delivery_status);
      if (event.status === 'canceled' && foodStillAtDonor) {
        const { error: revertError } = await service.rpc('revert_listing_to_live', {
          p_listing_id: order.listing_id,
          p_reason: 'delivery_canceled',
        });
        if (revertError) {
          // Listing may be past its safety window (hidden) — not fatal.
          console.error(`delivery-apply: revert_listing_to_live failed for ${order.listing_id}: ${revertError.message}`);
        }
      }

      await audit(order.id, 'refunded', {
        reason: `delivery_${event.status}`,
        delivery_id: event.deliveryId,
        raw_status: event.rawStatus,
        relisted: event.status === 'canceled' && foodStillAtDonor,
      });

      await sendPushToUser({
        externalUserId: order.consumer_id,
        title: 'Delivery canceled — full refund issued',
        body: `The courier couldn't complete "${order.listings.detected_item}". You've been refunded; the item may still be available for pickup.`,
        data: { order_id: order.id, type: 'refund_notice' },
      });
      try {
        const email = await getUserEmail(order.consumer_id);
        if (email) {
          await sendEmail({
            to: email,
            subject: 'Delivery canceled — full refund issued',
            text: `The delivery for "${order.listings.detected_item}" was canceled and you have been fully refunded. If the item is relisted, you can re-order it and choose free self-pickup at the donor instead.`,
          });
        }
      } catch (err) {
        console.error('delivery-apply: refund email failed:', err);
      }

      return { applied: true, orderId: order.id, transition: 'refunded' };
    }
  }
}
