// Delivery-provider abstraction (TRD Phase 3). FoodLink no longer employs its
// own couriers: orders move donor → consumer via a white-label delivery API
// (Uber Direct today, DoorDash Drive-shaped tomorrow) or consumer self-pickup.
// Everything provider-specific lives behind this interface; the rest of the
// app only ever sees internal statuses.

export interface DeliveryAddress {
  /** Street address line, already standardized (Smarty). */
  addressLine: string;
  lat: number | null;
  lng: number | null;
  /** True only when a real validator confirmed the address (not dev-mode synthetic). */
  validated: boolean;
  /** Contact shown to the courier. */
  name: string;
  phone: string | null;
}

export interface DeliveryQuote {
  feeCents: number;
  etaMinutes: number;
  quoteId: string;
  /** Provider quotes expire (~15 min for Uber) — always re-quote at checkout time. */
  expiresAt: string;
}

export interface DeliveryCreation {
  deliveryId: string;
  trackingUrl: string | null;
  pickupEta: string | null;
}

export interface DeliveryItem {
  name: string;
  quantityLbs: number;
  temperatureSensitive: boolean;
}

/** Internal normalized statuses — providers map their webhook/API payloads to these. */
export type DeliveryStatus =
  | 'pending'
  | 'courier_assigned'
  | 'picked_up'
  | 'delivered'
  | 'canceled'
  | 'returned';

export const TERMINAL_DELIVERY_STATUSES: ReadonlySet<DeliveryStatus> = new Set([
  'delivered',
  'canceled',
  'returned',
]);

export interface NormalizedDeliveryEvent {
  deliveryId: string;
  status: DeliveryStatus;
  trackingUrl: string | null;
  /** Provider's raw status string, kept for audit payloads. */
  rawStatus: string;
}

export interface DeliveryProvider {
  /** Stored on orders.delivery_provider. */
  readonly name: 'uber' | 'simulated';

  quote(
    pickup: DeliveryAddress,
    dropoff: DeliveryAddress,
    items: DeliveryItem[]
  ): Promise<DeliveryQuote>;

  createDelivery(
    quoteId: string,
    orderDetails: {
      orderId: string;
      pickup: DeliveryAddress;
      dropoff: DeliveryAddress;
      items: DeliveryItem[];
      /** Free-text courier instructions (cold-chain guidance etc.). */
      pickupInstructions: string | null;
    }
  ): Promise<DeliveryCreation>;

  cancel(deliveryId: string): Promise<void>;

  /** Poll current state — the reconciliation loop's view when webhooks are lost. */
  getDelivery(deliveryId: string): Promise<NormalizedDeliveryEvent>;

  /** Map a provider webhook payload to the internal shape (null = ignorable event). */
  normalizeWebhook(payload: unknown): NormalizedDeliveryEvent | null;
}

/** Thrown by providers when an address can't be used (e.g. unvalidated in real mode). */
export class DeliveryAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryAddressError';
  }
}
