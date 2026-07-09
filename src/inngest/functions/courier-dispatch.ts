import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { sendDispatchNotification, sendConsumerRefundNotification } from '@/lib/onesignal';
import { sendEmail, getUserEmail } from '@/lib/email';
import { refundOrderPayment } from '@/lib/stripe';

// 4 sequential offers × 5-minute acceptance windows ≈ the PRD's 20-minute cap
// (PRD §7.4). Declines short-circuit the window via the dispatch/responded event.
const MAX_OFFERS = 4;

// Without Smarty configured, donor addresses get synthetic Detroit-area coords
// while couriers report real GPS — a 10km radius would never match. Dev mode
// uses a planet-scale radius so the demo loop completes anywhere.
const DISPATCH_RADIUS_METERS = process.env.SMARTY_AUTH_ID ? 10000 : 20000000;

interface NearestCourier {
  user_id: string;
  distance_meters: number;
  current_lat: number;
  current_lng: number;
}

export const courierDispatch = inngest.createFunction(
  { id: 'courier-dispatch', retries: 3 },
  { event: 'dispatch/initiated' },
  async ({ event, step }) => {
    for (let offer = 1; offer <= MAX_OFFERS; offer++) {
      // Nearest eligible courier who hasn't already been offered this order
      const courier = await step.run(`find-courier-${offer}`, async () => {
        const supabase = await createServiceClient();

        const { data: prior } = await supabase
          .from('dispatch_events')
          .select('courier_id')
          .eq('order_id', event.data.order_id);
        const alreadyOffered = new Set((prior ?? []).map(d => d.courier_id as string));

        const { data } = await supabase.rpc('get_nearest_couriers', {
          p_donor_lat: event.data.donor_lat,
          p_donor_lng: event.data.donor_lng,
          p_requires_cold_chain: event.data.requires_cold_chain,
          p_radius_meters: DISPATCH_RADIUS_METERS,
          p_limit: 10,
        });

        const candidates = (data ?? []) as NearestCourier[];
        return candidates.find(c => !alreadyOffered.has(c.user_id)) ?? null;
      });

      if (!courier) {
        // Nobody in range right now — wait out this window and retry
        await step.sleep(`no-couriers-backoff-${offer}`, '5m');
        continue;
      }

      const dispatchEvent = await step.run(`create-dispatch-event-${offer}`, async () => {
        const supabase = await createServiceClient();
        const { data } = await supabase
          .from('dispatch_events')
          .insert({
            order_id: event.data.order_id,
            courier_id: courier.user_id,
          })
          .select()
          .single();
        return data;
      });

      if (!dispatchEvent) continue;

      await step.run(`notify-courier-${offer}`, async () => {
        await sendDispatchNotification(courier.user_id, event.data.order_id);
        try {
          const email = await getUserEmail(courier.user_id);
          if (email) {
            await sendEmail({
              to: email,
              subject: 'New delivery offer — FoodLink',
              text: 'New delivery offer — open your dashboard to accept (expires in 5 minutes).',
            });
          }
        } catch (err) {
          console.error('[courier-dispatch] email notify failed:', err);
        }
      });

      // Wait up to 5 minutes; accept/decline actions emit dispatch/responded,
      // so a decline moves to the next courier immediately.
      const response = await step.waitForEvent(`wait-response-${offer}`, {
        event: 'dispatch/responded',
        timeout: '5m',
        if: `async.data.dispatch_event_id == "${dispatchEvent.id}"`,
      });

      if (response?.data?.response === 'accepted') {
        return { accepted: true, offers: offer };
      }

      if (!response) {
        // No reply within the window — mark timeout so the courier's stale
        // offer page shows "no longer available"
        await step.run(`timeout-dispatch-${offer}`, async () => {
          const supabase = await createServiceClient();
          await supabase
            .from('dispatch_events')
            .update({ responded_at: new Date().toISOString(), response: 'timeout' })
            .eq('id', dispatchEvent.id)
            .is('response', null);
        });
      }
      // declined → loop to next-nearest courier immediately
    }

    // No courier accepted within ~20 minutes — refund the consumer (PRD §8.2)
    await step.run('refund-consumer', async () => {
      const supabase = await createServiceClient();

      const { data: order } = await supabase
        .from('orders')
        .select('id, status, stripe_payment_intent_id, consumer_id, listing_id')
        .eq('id', event.data.order_id)
        .single();

      // Already progressed (accepted late) or already refunded — do nothing
      if (!order || order.status !== 'pending_dispatch') return;

      await refundOrderPayment({
        paymentIntentId: order.stripe_payment_intent_id,
        orderId: order.id,
        reason: 'no_courier_available',
      });

      await supabase.rpc('revert_listing_to_live', {
        p_listing_id: order.listing_id,
        p_reason: 'no_courier_available',
      });

      await supabase
        .from('orders')
        .update({ status: 'refunded' })
        .eq('id', order.id)
        .eq('status', 'pending_dispatch');

      await supabase.from('audit_log').insert({
        entity_type: 'order',
        entity_id: order.id,
        event_type: 'refunded',
        actor_id: null,
        actor_role: 'system',
        payload: { reason: 'no_courier_available', offers: MAX_OFFERS },
      });

      await sendConsumerRefundNotification(order.consumer_id, event.data.detected_item);
      try {
        const email = await getUserEmail(order.consumer_id);
        if (email) {
          await sendEmail({
            to: email,
            subject: 'Order refunded — FoodLink',
            text: `We couldn't find a courier for "${event.data.detected_item}". You will receive a full refund.`,
          });
        }
      } catch (err) {
        console.error('[courier-dispatch] refund email notify failed:', err);
      }
    });

    return { accepted: false, refunded: true };
  }
);
