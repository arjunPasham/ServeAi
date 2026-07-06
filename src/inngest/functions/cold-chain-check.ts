import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { notifyListingExpired } from '@/services/n8n';
import { refundOrderPayment } from '@/lib/stripe';
import { sendConsumerRefundNotification } from '@/lib/onesignal';

// Safety-expiry sweep (PRD §8.4 / §9.3), every 5 minutes:
//  - 'live' listings past expiry → hidden from the marketplace.
//  - 'purchased' listings past expiry (claimed, courier not yet accepted) →
//    hidden AND the consumer is auto-refunded.
//  - 'dispatched' listings are deliberately NOT touched: the courier is already
//    carrying the food, and hiding the listing bricked confirm_delivery.
//    Rejection-at-door + the dispute flow cover in-transit degradation.
export const coldChainCheck = inngest.createFunction(
  { id: 'cold-chain-check', retries: 3 },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const expiring = await step.run('fetch-expiring', async () => {
      const supabase = await createServiceClient();
      const { data } = await supabase
        .from('listings')
        .select('id, consumer_price_cents, detected_item, donor_id, status')
        .eq('temperature_sensitive', true)
        .in('status', ['live', 'purchased'])
        .not('safety_expires_at', 'is', null)
        .lte('safety_expires_at', new Date().toISOString());

      return data ?? [];
    });

    for (const listing of expiring) {
      await step.run(`hide-listing-${listing.id}`, async () => {
        const supabase = await createServiceClient();
        await supabase.rpc('hide_expired_listing', { p_listing_id: listing.id });

        // Claimed but not yet picked up: refund the consumer automatically (PRD §8.2)
        if (listing.status === 'purchased') {
          const { data: order } = await supabase
            .from('orders')
            .select('id, status, consumer_id, stripe_payment_intent_id')
            .eq('listing_id', listing.id)
            .eq('status', 'pending_dispatch')
            .maybeSingle();

          if (order) {
            await refundOrderPayment({
              paymentIntentId: order.stripe_payment_intent_id,
              orderId: order.id,
              reason: 'safety_window_expired',
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
              payload: { reason: 'safety_window_expired', listing_id: listing.id },
            });

            await sendConsumerRefundNotification(order.consumer_id, listing.detected_item);
          }
        }

        // Notify the donor via n8n in all cases
        await notifyListingExpired({
          listing_id: listing.id,
          donor_id: listing.donor_id,
          detected_item: listing.detected_item,
        });
      });
    }

    return { processed: expiring.length };
  }
);
