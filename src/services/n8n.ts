import crypto from 'crypto';

// DEV BYPASS: when N8N_WEBHOOK_BASE_URL is not set, webhooks are logged instead
// of sent. Never default to a hardcoded third-party URL — that ships user data
// (addresses, order details) to an instance the operator doesn't control.
const N8N_BASE_URL = process.env.N8N_WEBHOOK_BASE_URL;
const WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET ?? '';

function sign(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

// Fire-and-forget: an n8n outage must never fail the business operation that
// already committed (e.g. a published listing or confirmed delivery).
async function send(path: string, payload: unknown): Promise<void> {
  if (!N8N_BASE_URL) {
    console.log(`[DEV] n8n webhook skipped (${path}):`, JSON.stringify(payload));
    return;
  }

  const body = JSON.stringify(payload);
  try {
    await fetch(`${N8N_BASE_URL}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-n8n-signature': sign(body),
      },
      body,
    });
  } catch (err) {
    console.error(`n8n webhook failed (${path}):`, err instanceof Error ? err.message : err);
  }
}

// Call after listings.status is set to 'live' in Supabase
export function notifyListingPublished(payload: {
  listing_id: string;
  donor_id: string;
  detected_item: string;
  estimated_quantity_lbs: number;
  consumer_price_cents: number;
  temperature_sensitive: boolean;
  image_url: string | null;
  published_at: string;
}) {
  return send('listing-published', payload);
}

// Call from Inngest cold-chain job after listings.status is set to 'hidden'
export function notifyListingExpired(payload: {
  listing_id: string;
  donor_id: string;
  detected_item: string;
}) {
  return send('listing-expired', payload);
}

// Call after claim_listing() RPC succeeds and Stripe payment is captured
export function notifyOrderPlaced(payload: {
  order_id: string;
  listing_id: string;
  consumer_id: string;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  courier_fee_cents: number;
  temperature_sensitive: boolean;
  handling_notes: string | null;
}) {
  return send('order-placed', payload);
}

// Call after confirm_delivery() RPC succeeds
export function notifyDeliveryConfirmed(payload: {
  order_id: string;
  listing_id: string;
  consumer_id: string;
  courier_id: string;
  delivered_at: string;
}) {
  return send('delivery-confirmed', payload);
}
