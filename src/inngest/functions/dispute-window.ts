import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { transferToDonor, canReceiveTransfers } from '@/lib/stripe';

// supabase-js never throws — every step here destructures { error } and throws
// on it so Inngest's retry machinery engages. A swallowed error would show a
// green checkmark while the write silently never happened.

export const disputeWindow = inngest.createFunction(
  { id: 'dispute-window', retries: 3 },
  { event: 'delivery/confirmed' },
  async ({ event, step }) => {
    await step.sleep('wait-dispute-window', '2h');

    const order = await step.run('check-dispute-status', async () => {
      const supabase = await createServiceClient();
      const { data, error } = await supabase
        .from('orders')
        .select('id, status, stripe_charge_id, donor_transfer_id')
        .eq('id', event.data.order_id)
        .maybeSingle();
      if (error) {
        throw new Error(`dispute-window: order lookup failed for ${event.data.order_id}: ${error.message}`);
      }
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
    // The partial unique index (016) makes the check-then-insert race-proof:
    // a 23505 on insert means another run already recorded it — success.
    await step.run('record-implicit-accept', async () => {
      if (!event.data.consumer_id) return;
      const supabase = await createServiceClient();

      const { data: existing, error: existsError } = await supabase
        .from('feedback_events')
        .select('id')
        .eq('order_id', event.data.order_id)
        .limit(1);
      // On a failed exists-check we must NOT fall through to insert — that is
      // the double-insert path. Throw and let the retry re-check.
      if (existsError) {
        throw new Error(`dispute-window: feedback exists-check failed for ${event.data.order_id}: ${existsError.message}`);
      }
      if (existing?.length) return;

      const { error: insertError } = await supabase.from('feedback_events').insert({
        order_id: event.data.order_id,
        consumer_id: event.data.consumer_id,
        outcome: 'implicit_accept',
      });
      if (insertError && insertError.code !== '23505') {
        throw new Error(`dispute-window: implicit-accept insert failed for ${event.data.order_id}: ${insertError.message}`);
      }
    });

    // Payout eligibility. Beyond mere presence of an account id, the account
    // must have finished onboarding (payouts_enabled, read fresh — it can
    // change during the 2h window) and must not be a synthetic acct_dev_* id
    // while real Stripe keys are active. Anything not payable lands in the
    // skipped-payout audit trail for manual payout — never a doomed retry loop.
    let skipReason: string | null = null;
    if (!event.data.donor_stripe_account_id || !event.data.stripe_charge_id) {
      skipReason = 'missing_stripe_account_or_charge';
    } else {
      const donorProfile = await step.run('check-donor-payout-eligibility', async () => {
        const supabase = await createServiceClient();
        const { data, error } = await supabase
          .from('donor_profiles')
          .select('payouts_enabled')
          .eq('stripe_account_id', event.data.donor_stripe_account_id)
          .maybeSingle();
        if (error) {
          throw new Error(`dispute-window: donor profile lookup failed for account ${event.data.donor_stripe_account_id}: ${error.message}`);
        }
        return data;
      });
      const eligibility = canReceiveTransfers({
        stripeAccountId: event.data.donor_stripe_account_id,
        payoutsEnabled: donorProfile?.payouts_enabled === true,
      });
      if (!eligibility.ok) {
        skipReason = eligibility.reason;
      }
    }

    if (skipReason) {
      const reason = skipReason;
      await step.run('record-skipped-payout', async () => {
        const supabase = await createServiceClient();
        const { error } = await supabase.from('audit_log').insert({
          entity_type: 'order',
          entity_id: event.data.order_id,
          event_type: 'donor_payout_skipped',
          actor_id: null,
          actor_role: 'system',
          payload: {
            amount_cents: event.data.donor_payout_cents,
            reason,
            has_stripe_account: Boolean(event.data.donor_stripe_account_id),
            has_charge: Boolean(event.data.stripe_charge_id),
            action_required: 'manual_payout',
          },
        });
        if (error) {
          throw new Error(`dispute-window: skipped-payout audit insert failed for ${event.data.order_id}: ${error.message}`);
        }
      });
      return { skipped: true, reason };
    }

    const transfer = await step.run('release-donor-payout', async () => {
      return transferToDonor({
        amountCents: event.data.donor_payout_cents,
        donorStripeAccountId: event.data.donor_stripe_account_id,
        chargeId: event.data.stripe_charge_id,
        orderId: event.data.order_id,
      });
    });

    // Safe to throw here: release-donor-payout is memoized by Inngest, so a
    // retry of this step never re-runs the transfer.
    await step.run('record-donor-transfer', async () => {
      const supabase = await createServiceClient();
      const { error: updateError } = await supabase
        .from('orders')
        .update({ donor_transfer_id: transfer.id })
        .eq('id', event.data.order_id);
      if (updateError) {
        throw new Error(`dispute-window: donor_transfer_id update failed for ${event.data.order_id} (transfer ${transfer.id}): ${updateError.message}`);
      }

      const { error: auditError } = await supabase.from('audit_log').insert({
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
      if (auditError) {
        throw new Error(`dispute-window: payout audit insert failed for ${event.data.order_id} (transfer ${transfer.id}): ${auditError.message}`);
      }
    });

    return { transfer_id: transfer.id };
  }
);
