import Stripe from 'stripe';
import { stripe } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/server';

export async function POST(req: Request) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  if (!sig) {
    return Response.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return Response.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const service = await createServiceClient();

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const chargeId = paymentIntent.latest_charge as string | null;

      if (chargeId) {
        // Store charge_id on the order for later transfers
        await service
          .from('orders')
          .update({ stripe_charge_id: chargeId })
          .eq('stripe_payment_intent_id', paymentIntent.id);
      }

      await service.from('audit_log').insert({
        entity_type: 'order',
        entity_id: paymentIntent.metadata.order_id ?? paymentIntent.id,
        event_type: 'payment_succeeded',
        actor_id: null,
        actor_role: 'system',
        payload: {
          payment_intent_id: paymentIntent.id,
          charge_id: chargeId,
          amount_cents: paymentIntent.amount,
        },
      });
      break;
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const listingId = paymentIntent.metadata.listing_id;

      if (listingId) {
        await service.rpc('revert_listing_to_live', {
          p_listing_id: listingId,
          p_reason: 'payment_failed',
        });

        // Mark order as refunded
        await service
          .from('orders')
          .update({ status: 'refunded' })
          .eq('stripe_payment_intent_id', paymentIntent.id);
      }

      await service.from('audit_log').insert({
        entity_type: 'order',
        entity_id: paymentIntent.metadata.order_id ?? paymentIntent.id,
        event_type: 'payment_failed',
        actor_id: null,
        actor_role: 'system',
        payload: {
          payment_intent_id: paymentIntent.id,
          listing_id: listingId,
        },
      });
      break;
    }

    case 'transfer.created': {
      const transfer = event.data.object as Stripe.Transfer;
      await service.from('audit_log').insert({
        entity_type: 'order',
        entity_id: transfer.metadata.order_id ?? transfer.id,
        event_type: 'transfer_created',
        actor_id: null,
        actor_role: 'system',
        payload: {
          transfer_id: transfer.id,
          amount_cents: transfer.amount,
          reason: transfer.metadata.reason,
        },
      });
      break;
    }

    default:
      // Unhandled event — return 200 so Stripe doesn't retry
      break;
  }

  return Response.json({ received: true });
}
