import Stripe from 'stripe';

// Lazy singleton — not instantiated at module load so build-time doesn't need STRIPE_SECRET_KEY
let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set');
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      apiVersion: '2026-06-24.dahlia' as any,
    });
  }
  return _stripe;
}

// Convenience alias — use getStripe() instead of this in new code
export const stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getStripe() as any)[prop];
  },
});

export async function createPaymentIntent(params: {
  amountCents: number;
  listingId: string;
  orderId: string;
  donorPayoutCents: number;
  courierFeeCents: number;
  platformFeeCents: number;
}): Promise<Stripe.PaymentIntent> {
  return getStripe().paymentIntents.create({
    amount: params.amountCents,
    currency: 'usd',
    payment_method_types: ['card'],
    capture_method: 'automatic',
    metadata: {
      listing_id: params.listingId,
      order_id: params.orderId,
      donor_payout_cents: String(params.donorPayoutCents),
      courier_fee_cents: String(params.courierFeeCents),
      platform_fee_cents: String(params.platformFeeCents),
    },
  });
}

export async function transferToCourier(params: {
  amountCents: number;
  courierStripeAccountId: string;
  chargeId: string;
  orderId: string;
}): Promise<Stripe.Transfer> {
  return getStripe().transfers.create({
    amount: params.amountCents,
    currency: 'usd',
    destination: params.courierStripeAccountId,
    source_transaction: params.chargeId,
    metadata: { order_id: params.orderId, reason: 'courier_fee' },
  });
}

export async function transferToDonor(params: {
  amountCents: number;
  donorStripeAccountId: string;
  chargeId: string;
  orderId: string;
}): Promise<Stripe.Transfer> {
  return getStripe().transfers.create({
    amount: params.amountCents,
    currency: 'usd',
    destination: params.donorStripeAccountId,
    source_transaction: params.chargeId,
    metadata: { order_id: params.orderId, reason: 'donor_payout' },
  });
}
