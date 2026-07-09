// Simulated delivery provider — mirrors the twilio.ts/stripe.ts dev-bypass
// pattern: active whenever the Uber env vars are absent, so the full delivery
// loop works locally with zero external dependencies.
//
// Status transitions are derived from elapsed time since creation (the epoch
// is embedded in the delivery id), so any poll — the reconciler or an
// order-page read — sees the delivery "progress" without background timers:
//   0–1 min pending → 1–3 min courier_assigned → 3–6 min picked_up → delivered.

import { randomUUID } from 'crypto';
import {
  DeliveryAddress,
  DeliveryCreation,
  DeliveryItem,
  DeliveryProvider,
  DeliveryQuote,
  DeliveryStatus,
  NormalizedDeliveryEvent,
} from './types';

const SIM_FEE_CENTS = 399;
const SIM_ETA_MINUTES = 25;

function statusForElapsed(elapsedMs: number): { status: DeliveryStatus; raw: string } {
  const minutes = elapsedMs / 60_000;
  if (minutes < 1) return { status: 'pending', raw: 'sim_pending' };
  if (minutes < 3) return { status: 'courier_assigned', raw: 'sim_courier_assigned' };
  if (minutes < 6) return { status: 'picked_up', raw: 'sim_picked_up' };
  return { status: 'delivered', raw: 'sim_delivered' };
}

export class SimulatedProvider implements DeliveryProvider {
  readonly name = 'simulated' as const;

  async quote(
    _pickup: DeliveryAddress,
    _dropoff: DeliveryAddress,
    _items: DeliveryItem[]
  ): Promise<DeliveryQuote> {
    // Geography is ignored on purpose — donor addresses are synthetic in dev.
    const quoteId = `sq_dev_${randomUUID().replace(/-/g, '')}`;
    console.log(`[DEV] Simulated delivery quote ${quoteId}: ${SIM_FEE_CENTS}¢, ~${SIM_ETA_MINUTES}min`);
    return {
      quoteId,
      feeCents: SIM_FEE_CENTS,
      etaMinutes: SIM_ETA_MINUTES,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }

  async createDelivery(
    _quoteId: string,
    orderDetails: { orderId: string }
  ): Promise<DeliveryCreation> {
    const deliveryId = `del_dev_${Date.now()}_${randomUUID().slice(0, 8)}`;
    console.log(`[DEV] Simulated delivery ${deliveryId} created for order ${orderDetails.orderId}`);
    return {
      deliveryId,
      trackingUrl: null,
      pickupEta: new Date(Date.now() + 3 * 60_000).toISOString(),
    };
  }

  async cancel(deliveryId: string): Promise<void> {
    console.log(`[DEV] Simulated delivery ${deliveryId} canceled`);
  }

  async getDelivery(deliveryId: string): Promise<NormalizedDeliveryEvent> {
    // del_dev_<epochMs>_<suffix>
    const epoch = Number(deliveryId.split('_')[2] ?? 0);
    const { status, raw } = statusForElapsed(Number.isFinite(epoch) && epoch > 0 ? Date.now() - epoch : 0);
    return { deliveryId, status, trackingUrl: null, rawStatus: raw };
  }

  normalizeWebhook(_payload: unknown): NormalizedDeliveryEvent | null {
    // The simulated provider has no webhooks — the reconciler drives progress.
    return null;
  }
}
