import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';

// v3 dispute window (Task 2) — repurposes the old dispute-window shape
// (event -> sleep -> check status -> act), but with the v3 records-only
// outcome: on close the load simply goes 'delivered' -> 'closed'. A recorded
// discrepancy does NOT block the close (recorded, not refereed) and there is NO
// payout/transfer (v3 takes 0%, money moves directly between the businesses).
//
// The deadline is single-sourced: recipient_confirm_delivery stamped
// dispute_window_expires_at, and this function sleeps until that exact
// timestamp — no drift. supabase-js never throws, so every step destructures
// { error } and throws on it to engage Inngest's retry machinery.
export const deliveryDisputeWindow = inngest.createFunction(
  { id: 'delivery-dispute-window', retries: 3 },
  { event: 'load/delivered' },
  async ({ event, step }) => {
    const loadId = event.data.load_id;

    const expiresAt = await step.run('read-dispute-window', async () => {
      const supabase = await createServiceClient();
      const { data, error } = await supabase
        .from('deliveries')
        .select('dispute_window_expires_at')
        .eq('load_id', loadId)
        .maybeSingle();
      if (error) {
        throw new Error(`delivery-dispute-window: delivery lookup failed for ${loadId}: ${error.message}`);
      }
      return data?.dispute_window_expires_at ?? null;
    });

    if (!expiresAt) {
      return { skipped: true, reason: 'no_dispute_window' };
    }

    await step.sleepUntil('await-dispute-window', new Date(expiresAt));

    return step.run('close-dispute-window', async () => {
      const supabase = await createServiceClient();
      // Only close a still-'delivered' load. A flag doesn't block the close, but
      // a load that already moved on (or was closed by an earlier run) is left
      // alone — makes the function idempotent under retry / redelivery.
      const { data: load, error: loadErr } = await supabase
        .from('loads')
        .select('status')
        .eq('id', loadId)
        .maybeSingle();
      if (loadErr) {
        throw new Error(`delivery-dispute-window: load lookup failed for ${loadId}: ${loadErr.message}`);
      }
      if (!load || load.status !== 'delivered') {
        return { closed: false, reason: `load_status=${load?.status ?? 'not_found'}` };
      }

      const { error: closeErr } = await supabase.rpc('close_delivery_window', {
        p_load_id: loadId,
        p_actor: null,
      });
      if (closeErr) {
        throw new Error(`delivery-dispute-window: close_delivery_window failed for ${loadId}: ${closeErr.message}`);
      }
      return { closed: true };
    });
  }
);
