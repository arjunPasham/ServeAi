import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { getDeliveryProvider, TERMINAL_DELIVERY_STATUSES } from '@/lib/delivery';
import { applyDeliveryStatus } from '@/lib/delivery/apply';

// Webhooks get lost. Every 5 minutes, poll the provider for non-terminal
// delivery orders older than RECONCILE_AFTER_MINUTES and reconcile status —
// the same silent-skip philosophy as the dispute-window fix: a status update
// must never fail invisibly.
//
// This poller also enforces the perishability invariant: a delivery that is
// not terminal once the listing's safety window has closed is canceled and
// refunded — food never sits in limbo. (And with the SimulatedProvider it is
// what drives dev-mode deliveries forward, since simulation has no webhooks.)

const RECONCILE_AFTER_MINUTES = 5;
const BATCH_LIMIT = 50;

interface ReconcilableOrder {
  id: string;
  delivery_external_id: string;
  listings: { safety_expires_at: string | null };
}

export const deliveryReconcile = inngest.createFunction(
  { id: 'delivery-reconcile', retries: 2 },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const orders = await step.run('find-stale-deliveries', async () => {
      const supabase = await createServiceClient();
      const cutoff = new Date(Date.now() - RECONCILE_AFTER_MINUTES * 60_000).toISOString();
      const { data, error } = await supabase
        .from('orders')
        .select('id, delivery_external_id, listings!inner(safety_expires_at)')
        .not('delivery_external_id', 'is', null)
        .in('status', ['pending_dispatch', 'dispatched'])
        .lt('created_at', cutoff)
        .limit(BATCH_LIMIT);
      if (error) {
        throw new Error(`delivery-reconcile: query failed: ${error.message}`);
      }
      return (data ?? []) as unknown as ReconcilableOrder[];
    });

    let reconciled = 0;
    let canceled = 0;

    for (const order of orders) {
      const outcome = await step.run(`reconcile-${order.id}`, async () => {
        const provider = getDeliveryProvider();
        const state = await provider.getDelivery(order.delivery_external_id);

        // Safety-window enforcement: still not terminal after the food's
        // window closed → cancel with the provider and let the canceled
        // transition refund the consumer.
        const safetyExpiresAt = order.listings.safety_expires_at;
        if (
          !TERMINAL_DELIVERY_STATUSES.has(state.status) &&
          safetyExpiresAt &&
          new Date(safetyExpiresAt).getTime() < Date.now()
        ) {
          await provider.cancel(order.delivery_external_id);
          await applyDeliveryStatus({
            deliveryId: order.delivery_external_id,
            status: 'canceled',
            trackingUrl: state.trackingUrl,
            rawStatus: 'safety_window_expired',
          });
          return 'canceled_safety_window';
        }

        await applyDeliveryStatus(state);
        return state.status;
      });

      reconciled++;
      if (outcome === 'canceled_safety_window') canceled++;
    }

    return { scanned: orders.length, reconciled, canceled_for_safety: canceled };
  }
);
