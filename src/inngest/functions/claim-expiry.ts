import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { cancelPaymentIntentIfCancelable } from '@/lib/stripe';

// Real-payment-mode watchdog: a consumer claimed a listing (locking it) but may
// abandon checkout without ever confirming the card. Without this, the listing
// stays 'purchased' forever and nobody can buy it. 15 minutes is generous for
// a card entry while keeping food off-market briefly.
const PAYMENT_TIMEOUT = '15m';

export const claimExpiry = inngest.createFunction(
  { id: 'claim-expiry', retries: 3 },
  { event: 'order/claimed' },
  async ({ event, step }) => {
    await step.sleep('wait-for-payment', PAYMENT_TIMEOUT);

    const order = await step.run('check-payment-status', async () => {
      const supabase = await createServiceClient();
      const { data } = await supabase
        .from('orders')
        .select('id, status, stripe_charge_id, listing_id')
        .eq('id', event.data.order_id)
        .single();
      return data;
    });

    // Paid (charge recorded) or already moved on — nothing to do
    if (!order || order.stripe_charge_id || order.status !== 'pending_dispatch') {
      return { released: false, reason: 'paid_or_progressed' };
    }

    // Cancel is decisive: if the PI already succeeded (payment landed right at
    // the deadline but the webhook hasn't recorded the charge yet), the money
    // is captured — relisting the food and marking the order refunded here
    // would double-sell it and strand the consumer's payment. The
    // payment_intent.succeeded webhook owns the order in that case.
    const cancel = await step.run('cancel-payment-intent', () =>
      cancelPaymentIntentIfCancelable(event.data.payment_intent_id)
    );
    if (!cancel.canceled) {
      return { released: false, reason: `payment_intent_${cancel.status}` };
    }

    await step.run('release-listing', async () => {
      const supabase = await createServiceClient();

      const { error: revertError } = await supabase.rpc('revert_listing_to_live', {
        p_listing_id: order.listing_id,
        p_reason: 'payment_not_completed',
      });
      if (revertError) {
        throw new Error(`claim-expiry: revert_listing_to_live failed for ${order.listing_id}: ${revertError.message}`);
      }

      const { error: orderError } = await supabase
        .from('orders')
        .update({ status: 'refunded' })
        .eq('id', order.id)
        .eq('status', 'pending_dispatch');
      if (orderError) {
        throw new Error(`claim-expiry: order release failed for ${order.id}: ${orderError.message}`);
      }

      await supabase.from('audit_log').insert({
        entity_type: 'order',
        entity_id: order.id,
        event_type: 'claim_expired',
        actor_id: null,
        actor_role: 'system',
        payload: {
          listing_id: order.listing_id,
          payment_intent_id: event.data.payment_intent_id,
          reason: 'payment_not_completed',
        },
      });
    });

    return { released: true };
  }
);
