import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { sendDispatchNotification, sendConsumerRefundNotification } from '@/lib/onesignal';
import { stripe } from '@/lib/stripe';

// Maximum dispatch attempts before we give up and refund the consumer
const MAX_DISPATCH_ATTEMPTS = 4; // 4 × 5-min windows = 20 minutes
const DISPATCH_WINDOW_MS = 5 * 60 * 1000;

export const courierDispatch = inngest.createFunction(
  { id: 'courier-dispatch', retries: 3 },
  { event: 'dispatch/initiated' },
  async ({ event, step }) => {
    let attempts = 0;

    while (attempts < MAX_DISPATCH_ATTEMPTS) {
      attempts++;

      // Fetch nearest available couriers
      const couriers = await step.run(`fetch-couriers-${attempts}`, async () => {
        const supabase = await createServiceClient();
        const { data } = await supabase.rpc('get_nearest_couriers', {
          p_donor_lat: event.data.donor_lat,
          p_donor_lng: event.data.donor_lng,
          p_requires_cold_chain: event.data.requires_cold_chain,
          p_radius_meters: 10000,
          p_limit: 5,
        });
        return data ?? [];
      });

      if (!couriers.length) {
        await step.sleep(`no-couriers-backoff-${attempts}`, '5m');
        continue;
      }

      // Offer to each courier sequentially until one accepts
      let accepted = false;
      for (const courier of couriers) {
        const dispatchEvent = await step.run(`create-dispatch-event-${attempts}-${courier.user_id}`, async () => {
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

        // Notify courier
        await step.run(`notify-courier-${courier.user_id}`, async () => {
          await sendDispatchNotification(courier.user_id, event.data.order_id);
        });

        // Wait 5 minutes for courier response
        await step.sleep(`wait-courier-response-${dispatchEvent.id}`, '5m');

        // Check if courier accepted
        const response = await step.run(`check-response-${dispatchEvent.id}`, async () => {
          const supabase = await createServiceClient();
          const { data } = await supabase
            .from('dispatch_events')
            .select('response')
            .eq('id', dispatchEvent.id)
            .single();
          return data?.response;
        });

        if (response === 'accepted') {
          accepted = true;
          break;
        }

        // Mark as timeout if no response
        if (!response) {
          await step.run(`timeout-dispatch-${dispatchEvent.id}`, async () => {
            const supabase = await createServiceClient();
            await supabase
              .from('dispatch_events')
              .update({ responded_at: new Date().toISOString(), response: 'timeout' })
              .eq('id', dispatchEvent.id);
          });
        }
      }

      if (accepted) {
        return { accepted: true, attempts };
      }
    }

    // No courier accepted after all attempts — refund consumer
    await step.run('refund-consumer', async () => {
      const supabase = await createServiceClient();

      // Get order and listing info for refund
      const { data: order } = await supabase
        .from('orders')
        .select('stripe_payment_intent_id, consumer_id, listing_id')
        .eq('id', event.data.order_id)
        .single();

      if (!order) return;

      // Refund via Stripe
      const paymentIntent = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
      if (paymentIntent.status === 'succeeded' && paymentIntent.latest_charge) {
        await stripe.refunds.create({
          charge: paymentIntent.latest_charge as string,
          reason: 'requested_by_customer', // no courier available — not a fraud signal
          metadata: { order_id: event.data.order_id, reason: 'no_courier_available' },
        });
      }

      // Revert listing to live
      await supabase.rpc('revert_listing_to_live', { p_listing_id: order.listing_id });

      // Update order status
      await supabase
        .from('orders')
        .update({ status: 'refunded' })
        .eq('id', event.data.order_id);

      await supabase.from('audit_log').insert({
        entity_type: 'order',
        entity_id: event.data.order_id,
        event_type: 'refunded',
        actor_id: null,
        actor_role: 'system',
        payload: { reason: 'no_courier_available', attempts: MAX_DISPATCH_ATTEMPTS },
      });

      // Notify consumer
      await sendConsumerRefundNotification(order.consumer_id, event.data.detected_item);
    });

    return { accepted: false, refunded: true };
  }
);
