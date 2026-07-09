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

    // Window closed with no consumer feedback → record implicit acceptance
    // (PRD §8.3). Direct insert as the system path — the submit_feedback RPC
    // is the consumer path and raises on edge cases the system must tolerate.
    await step.run('record-implicit-accept', async () => {
      const supabase = await createServiceClient();
      const { data: existing } = await supabase
        .from('feedback_events')
        .select('id')
        .eq('order_id', event.data.order_id)
        .limit(1);
      if (existing?.length || !event.data.consumer_id) return;

      await supabase.from('feedback_events').insert({
        order_id: event.data.order_id,
        consumer_id: event.data.consumer_id,
        outcome: 'implicit_accept',
      });
    });

    // Donor has no connected Stripe account (or charge is missing in dev mode):
    // record it for manual payout instead of throwing into a retry loop that
    // never succeeds and never alerts anyone.
    if (!event.data.donor_stripe_account_id || !event.data.stripe_charge_id) {
      await step.run('record-skipped-payout', async () => {
        const supabase = await createServiceClient();
        await supabase.from('audit_log').insert({
          entity_type: 'order',
          entity_id: event.data.order_id,
          event_type: 'donor_payout_skipped',
          actor_id: null,
          actor_role: 'system',
          payload: {
            amount_cents: event.data.donor_payout_cents,
            has_stripe_account: Boolean(event.data.donor_stripe_account_id),
            has_charge: Boolean(event.data.stripe_charge_id),
            action_required: 'manual_payout',
          },
        });
      });
      return { skipped: true, reason: 'missing_stripe_account_or_charge' };
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
