// Uber Direct provider — Uber's white-label delivery-as-a-service API (NOT the
// Uber Eats marketplace: FoodLink keeps its own storefront, Uber supplies the
// courier). Docs: https://developer.uber.com/docs/deliveries
//
// Env (all required for this provider to activate — see getDeliveryProvider):
//   UBER_CUSTOMER_ID, UBER_CLIENT_ID, UBER_CLIENT_SECRET, UBER_WEBHOOK_SECRET
// Optional: UBER_API_BASE (defaults to sandbox test-api.uber.com until set to
// https://api.uber.com for production).

import { createHmac, timingSafeEqual } from 'crypto';
import {
  DeliveryAddress,
  DeliveryAddressError,
  DeliveryCreation,
  DeliveryItem,
  DeliveryProvider,
  DeliveryQuote,
  DeliveryStatus,
  NormalizedDeliveryEvent,
} from './types';

const AUTH_URL = 'https://auth.uber.com/oauth/v2/token';

function apiBase(): string {
  return process.env.UBER_API_BASE ?? 'https://test-api.uber.com';
}

// OAuth2 client-credentials token, cached until shortly before expiry.
let cachedToken: { token: string; expiresAtMs: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAtMs - 60_000) {
    return cachedToken.token;
  }
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.UBER_CLIENT_ID!,
      client_secret: process.env.UBER_CLIENT_SECRET!,
      grant_type: 'client_credentials',
      scope: 'eats.deliveries',
    }),
  });
  if (!res.ok) {
    throw new Error(`Uber OAuth failed: ${res.status}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: body.access_token,
    expiresAtMs: Date.now() + body.expires_in * 1000,
  };
  return body.access_token;
}

async function uberFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`${apiBase()}/v1/customers/${process.env.UBER_CUSTOMER_ID}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
}

// Uber delivery statuses → internal. Reference: pending, pickup, pickup_complete,
// dropoff, delivered, canceled, returned.
const UBER_STATUS_MAP: Record<string, DeliveryStatus> = {
  pending: 'pending',
  pickup: 'courier_assigned',
  pickup_complete: 'picked_up',
  dropoff: 'picked_up',
  delivered: 'delivered',
  canceled: 'canceled',
  returned: 'returned',
};

function requireValidated(addr: DeliveryAddress, label: string): void {
  if (!addr.validated) {
    throw new DeliveryAddressError(
      `${label} address is not validated — Uber Direct requires a real, validated street address`
    );
  }
}

function toUberAddress(addr: DeliveryAddress): string {
  // Uber expects a JSON-stringified structured address in street_address form
  return JSON.stringify({ street_address: [addr.addressLine] });
}

function toManifestItems(items: DeliveryItem[]) {
  return items.map(item => ({
    name: item.name,
    quantity: 1,
    weight: Math.max(1, Math.round(item.quantityLbs * 453.6)), // grams
    must_be_upright: item.temperatureSensitive,
  }));
}

export class UberDirectProvider implements DeliveryProvider {
  readonly name = 'uber' as const;

  async quote(
    pickup: DeliveryAddress,
    dropoff: DeliveryAddress,
    _items: DeliveryItem[]
  ): Promise<DeliveryQuote> {
    requireValidated(pickup, 'Pickup');
    requireValidated(dropoff, 'Dropoff');

    const res = await uberFetch('/delivery_quotes', {
      method: 'POST',
      body: JSON.stringify({
        pickup_address: toUberAddress(pickup),
        dropoff_address: toUberAddress(dropoff),
        ...(pickup.lat != null && pickup.lng != null
          ? { pickup_latitude: pickup.lat, pickup_longitude: pickup.lng }
          : {}),
        ...(dropoff.lat != null && dropoff.lng != null
          ? { dropoff_latitude: dropoff.lat, dropoff_longitude: dropoff.lng }
          : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Uber quote failed: ${res.status} ${text.slice(0, 300)}`);
    }
    const body = (await res.json()) as {
      id: string;
      fee: number;
      duration: number;
      expires: string;
    };
    return {
      quoteId: body.id,
      feeCents: body.fee,
      etaMinutes: body.duration,
      expiresAt: body.expires,
    };
  }

  async createDelivery(
    quoteId: string,
    orderDetails: {
      orderId: string;
      pickup: DeliveryAddress;
      dropoff: DeliveryAddress;
      items: DeliveryItem[];
      pickupInstructions: string | null;
    }
  ): Promise<DeliveryCreation> {
    const { pickup, dropoff, items, orderId, pickupInstructions } = orderDetails;
    requireValidated(pickup, 'Pickup');
    requireValidated(dropoff, 'Dropoff');

    const res = await uberFetch('/deliveries', {
      method: 'POST',
      body: JSON.stringify({
        quote_id: quoteId,
        pickup_address: toUberAddress(pickup),
        pickup_name: pickup.name,
        pickup_phone_number: pickup.phone ?? '+10000000000',
        pickup_notes: pickupInstructions ?? undefined,
        dropoff_address: toUberAddress(dropoff),
        dropoff_name: dropoff.name,
        dropoff_phone_number: dropoff.phone ?? '+10000000000',
        manifest_items: toManifestItems(items),
        external_id: orderId,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Uber delivery creation failed: ${res.status} ${text.slice(0, 300)}`);
    }
    const body = (await res.json()) as {
      id: string;
      tracking_url?: string;
      pickup_eta?: string;
    };
    return {
      deliveryId: body.id,
      trackingUrl: body.tracking_url ?? null,
      pickupEta: body.pickup_eta ?? null,
    };
  }

  async cancel(deliveryId: string): Promise<void> {
    const res = await uberFetch(`/deliveries/${deliveryId}/cancel`, { method: 'POST' });
    // 4xx on an already-terminal delivery is fine — the reconciler will pick
    // up the true state; only infrastructure failures should throw.
    if (!res.ok && res.status >= 500) {
      throw new Error(`Uber cancel failed: ${res.status}`);
    }
  }

  async getDelivery(deliveryId: string): Promise<NormalizedDeliveryEvent> {
    const res = await uberFetch(`/deliveries/${deliveryId}`, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Uber get-delivery failed: ${res.status}`);
    }
    const body = (await res.json()) as { id: string; status: string; tracking_url?: string };
    return {
      deliveryId: body.id,
      status: UBER_STATUS_MAP[body.status] ?? 'pending',
      trackingUrl: body.tracking_url ?? null,
      rawStatus: body.status,
    };
  }

  normalizeWebhook(payload: unknown): NormalizedDeliveryEvent | null {
    const p = payload as {
      kind?: string;
      status?: string;
      delivery_id?: string;
      data?: { id?: string; status?: string; tracking_url?: string };
    };
    // Uber Direct webhooks: kind = event.delivery_status | event.courier_update
    if (p.kind !== 'event.delivery_status') return null;
    const deliveryId = p.delivery_id ?? p.data?.id;
    const rawStatus = p.status ?? p.data?.status;
    if (!deliveryId || !rawStatus) return null;
    const status = UBER_STATUS_MAP[rawStatus];
    if (!status) return null;
    return {
      deliveryId,
      status,
      trackingUrl: p.data?.tracking_url ?? null,
      rawStatus,
    };
  }
}

/** Verify Uber's webhook HMAC (X-Postmates-Signature / X-Uber-Signature: hex sha256 of raw body). */
export function verifyUberWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.UBER_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
}
