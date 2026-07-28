// v3 Delivery-log — pure helpers (method/party vocab + labels + validation).
// No DB access; the guarded reads/mutators live in src/actions/deliveries.ts and
// the state transitions in the 031 RPCs. Records-only: nothing here routes,
// dispatches, or brokers a courier.

export const DELIVERY_METHODS = [
  'merchant_delivery',
  'pickup',
  'uber_direct',
  'local_courier',
  'other',
] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export const RESPONSIBLE_PARTIES = ['donor', 'recipient'] as const;
export type ResponsibleParty = (typeof RESPONSIBLE_PARTIES)[number];

// How long the recipient can flag a discrepancy after confirming receipt (v3
// Task 2). Single-sourced: the confirm action stamps dispute_window_expires_at
// = now + this, and the Inngest dispute-window function sleeps until that exact
// timestamp — no drift between the DB deadline and the timer. 24h gives a
// recipient a day to unpack and flag an issue; a flag is recorded, not refereed.
export const DISPUTE_WINDOW_HOURS = 24;
export const DISPUTE_WINDOW_MS = DISPUTE_WINDOW_HOURS * 60 * 60 * 1000;

export function isDeliveryMethod(x: string): x is DeliveryMethod {
  return (DELIVERY_METHODS as readonly string[]).includes(x);
}

export function isResponsibleParty(x: string): x is ResponsibleParty {
  return (RESPONSIBLE_PARTIES as readonly string[]).includes(x);
}

const DELIVERY_METHOD_LABELS: Record<DeliveryMethod, string> = {
  merchant_delivery: 'Merchant delivers',
  pickup: 'Recipient pickup',
  uber_direct: 'Uber Direct',
  local_courier: 'Local courier',
  other: 'Other',
};
export function deliveryMethodLabel(method: string): string {
  return DELIVERY_METHOD_LABELS[method as DeliveryMethod] ?? method;
}

const RESPONSIBLE_PARTY_LABELS: Record<ResponsibleParty, string> = {
  donor: 'Merchant (donor)',
  recipient: 'Recipient',
};
export function responsiblePartyLabel(party: string): string {
  return RESPONSIBLE_PARTY_LABELS[party as ResponsibleParty] ?? party;
}
