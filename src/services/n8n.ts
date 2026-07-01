import crypto from 'crypto';

const N8N_BASE_URL = process.env.N8N_WEBHOOK_BASE_URL ?? 'https://arjunpasham.app.n8n.cloud/webhook';
const WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET ?? '';

function sign(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

async function send(path: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  await fetch(`${N8N_BASE_URL}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-n8n-signature': sign(body),
    },
    body,
  });
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
