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
