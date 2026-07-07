import Stripe from 'stripe';
import { stripe } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/server';
import { fireDispatch } from '@/lib/dispatch-events';

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

      // Look the order up by PI id — metadata.order_id may lag the claim RPC
      const { data: order } = await service
        .from('orders')
        .select('id, listing_id, consumer_id, status, stripe_charge_id')
        .eq('stripe_payment_intent_id', paymentIntent.id)
        .single();

      if (order && chargeId && !order.stripe_charge_id) {
        await service
          .from('orders')
          .update({ stripe_charge_id: chargeId })
          .eq('id', order.id);
      }

      await service.from('audit_log').insert({
        entity_type: 'order',
        entity_id: order?.id ?? paymentIntent.metadata.order_id ?? paymentIntent.id,
        event_type: 'payment_succeeded',
        actor_id: null,
        actor_role: 'system',
        payload: {
          payment_intent_id: paymentIntent.id,
          charge_id: chargeId,
          amount_cents: paymentIntent.amount,
        },
      });

      // Payment captured → NOW dispatch a courier (PRD §7.3: never before).
      // stripe_charge_id acts as the idempotency guard against webhook retries.
      if (order && order.status === 'pending_dispatch' && !order.stripe_charge_id) {
        await fireDispatch(order.id, order.listing_id, order.consumer_id);
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      // A single failed attempt is NOT terminal — the consumer can retry with
      // another card while the claim-expiry watchdog holds the listing. Do not
      // revert the listing or mark the order refunded here (that caused a
      // double-sell window). Just record the attempt.
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      await service.from('audit_log').insert({
        entity_type: 'order',
        entity_id: paymentIntent.metadata.order_id ?? paymentIntent.id,
        event_type: 'payment_attempt_failed',
        actor_id: null,
        actor_role: 'system',
        payload: {
          payment_intent_id: paymentIntent.id,
          listing_id: paymentIntent.metadata.listing_id,
          failure_message: paymentIntent.last_payment_error?.message ?? null,
        },
      });
      break;
    }

    case 'payment_intent.canceled': {
      // Terminal: release the listing back to the marketplace
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const listingId = paymentIntent.metadata.listing_id;

      if (listingId) {
        await service.rpc('revert_listing_to_live', {
          p_listing_id: listingId,
          p_reason: 'payment_canceled',
        });
        await service
          .from('orders')
          .update({ status: 'refunded' })
          .eq('stripe_payment_intent_id', paymentIntent.id)
          .eq('status', 'pending_dispatch');
      }

      await service.from('audit_log').insert({
        entity_type: 'order',
        entity_id: paymentIntent.metadata.order_id ?? paymentIntent.id,
        event_type: 'payment_canceled',
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
