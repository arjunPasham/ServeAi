import Stripe from 'stripe';
import { getStripe, isStripeDevMode } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/server';
import { buildBillingEventPayload } from '@/lib/billing';

// Merchant subscription billing webhook (Task B). Separate endpoint + secret
// from the consumer-payment webhook (/api/stripe/webhook), subscribed only to
// subscription/invoice events. Signature verification is timing-safe via
// Stripe's constructEvent (HMAC), exactly like the existing webhook. All
// business logic — dedup on event.id + the state transition — lives in the
// guarded handle_billing_webhook RPC (027), so this route is thin glue.
export async function POST(req: Request) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');
  const secret = process.env.STRIPE_BILLING_WEBHOOK_SECRET;

  // Fail closed. In dev there's no real Stripe (billing is simulated through
  // startMerchantSubscription -> handle_billing_webhook), and a missing secret
  // in prod is caught at boot by REQUIRED_PROD_ENV — either way we refuse an
  // unverifiable inbound call rather than trusting an unsigned body.
  if (isStripeDevMode() || !secret) {
    return Response.json({ error: 'Billing webhook not configured' }, { status: 400 });
  }
  if (!sig) {
    return Response.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, secret);
  } catch {
    return Response.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const service = await createServiceClient();
  const { data, error } = await service.rpc('handle_billing_webhook', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_payload: buildBillingEventPayload(event),
  });

  if (error) {
    // The RPC is atomic — a failure rolled back the dedup row too, so returning
    // 500 lets Stripe retry and reprocess (rather than silently dropping it).
    console.error('[billing webhook] handle_billing_webhook failed:', error.message);
    return Response.json({ error: 'processing_failed' }, { status: 500 });
  }

  return Response.json({ received: true, result: data });
}
