import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { transferToDonor } from '@/lib/stripe';

export const disputeWindow = inngest.createFunction(
  { id: 'dispute-window', retries: 3 },
  { event: 'delivery/confirmed' },
  async ({ event, step }) => {
    await step.sleep('wait-dispute-window', '2h');

    const order = await step.run('check-dispute-status', async () => {
      const supabase = await createServiceClient();
      const { data } = await supabase
        .from('orders')
        .select('id, status, stripe_charge_id, donor_transfer_id')
        .eq('id', event.data.order_id)
        .single();
      return data;
    });

    // If disputed or already transferred, do not pay out
    if (!order || order.status !== 'delivered') {
      return { skipped: true, reason: `order_status=${order?.status ?? 'not_found'}` };
    }

    // Guard: don't double-transfer if somehow already done
    if (order.donor_transfer_id) {
      return { skipped: true, reason: 'donor_transfer_already_exists' };
    }

    const transfer = await step.run('release-donor-payout', async () => {
      return transferToDonor({
        amountCents: event.data.donor_payout_cents,
        donorStripeAccountId: event.data.donor_stripe_account_id,
        chargeId: event.data.stripe_charge_id,
        orderId: event.data.order_id,
      });
    });

    await step.run('record-donor-transfer', async () => {
      const supabase = await createServiceClient();
      await supabase
        .from('orders')
        .update({ donor_transfer_id: transfer.id })
        .eq('id', event.data.order_id);

      await supabase.from('audit_log').insert({
        entity_type: 'order',
        entity_id: event.data.order_id,
        event_type: 'donor_payout_released',
        actor_id: null,
        actor_role: 'system',
        payload: {
          transfer_id: transfer.id,
          amount_cents: event.data.donor_payout_cents,
          donor_stripe_account: event.data.donor_stripe_account_id,
        },
      });
    });

    return { transfer_id: transfer.id };
  }
);
