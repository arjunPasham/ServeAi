// Uber Direct webhook receiver. Verifies the HMAC signature, maps the payload
// through the provider normalizer, and applies the status via the same
// applyDeliveryStatus path the polling reconciler uses — lost webhooks and
// polls converge on identical transitions.

import { UberDirectProvider, verifyUberWebhookSignature } from '@/lib/delivery/uber';
import { applyDeliveryStatus } from '@/lib/delivery/apply';

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature =
    req.headers.get('x-postmates-signature') ?? req.headers.get('x-uber-signature');

  if (!verifyUberWebhookSignature(rawBody, signature)) {
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const normalized = new UberDirectProvider().normalizeWebhook(payload);
  if (!normalized) {
    // Event kind we don't act on (e.g. courier location pings) — ack it.
    return Response.json({ received: true, ignored: true });
  }

  try {
    const result = await applyDeliveryStatus(normalized);
    return Response.json({ received: true, ...result });
  } catch (err) {
    // 500 → Uber retries; the reconciler is the second line of defense.
    console.error('[uber-webhook] apply failed:', err);
    return Response.json({ error: 'Apply failed' }, { status: 500 });
  }
}
