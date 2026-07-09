import Stripe from 'stripe';
import { randomUUID } from 'crypto';

// DEV BYPASS: when STRIPE_SECRET_KEY is not set, payments are simulated —
// PaymentIntents/Transfers/Refunds become synthetic objects and the purchase
// is treated as captured immediately. Mirrors the twilio.ts/onesignal.ts pattern.
export function isStripeDevMode(): boolean {
  return !process.env.STRIPE_SECRET_KEY;
}

// Lazy singleton — not instantiated at module load so build-time doesn't need STRIPE_SECRET_KEY
let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set');
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
  if (isStripeDevMode()) {
    const id = `pi_dev_${randomUUID().replace(/-/g, '')}`;
    console.log(`[DEV] Simulated PaymentIntent ${id} for ${params.amountCents}¢ (listing ${params.listingId})`);
    return {
      id,
      object: 'payment_intent',
      amount: params.amountCents,
      currency: 'usd',
      status: 'succeeded',
      client_secret: `${id}_secret_dev`,
      latest_charge: `ch_dev_${randomUUID().replace(/-/g, '')}`,
      metadata: {
        listing_id: params.listingId,
        order_id: params.orderId,
      },
    } as unknown as Stripe.PaymentIntent;
  }

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

// Update PI metadata with the real order id once claim_listing has created it
export async function attachOrderToPaymentIntent(paymentIntentId: string, orderId: string): Promise<void> {
  if (isStripeDevMode()) return;
  await getStripe().paymentIntents.update(paymentIntentId, {
    metadata: { order_id: orderId },
  });
}

export async function cancelPaymentIntent(paymentIntentId: string): Promise<void> {
  if (isStripeDevMode()) {
    console.log(`[DEV] Simulated cancel of PaymentIntent ${paymentIntentId}`);
    return;
  }
  await getStripe().paymentIntents.cancel(paymentIntentId);
}

// Refund a consumer. Never use reason 'fraudulent' for operational refunds —
// it flags the customer in Stripe Radar and can get their card blocked.
export async function refundOrderPayment(params: {
  paymentIntentId: string;
  orderId: string;
  reason: string; // internal reason, stored in metadata
}): Promise<{ refunded: boolean }> {
  if (isStripeDevMode()) {
    console.log(`[DEV] Simulated refund for PI ${params.paymentIntentId} (${params.reason})`);
    return { refunded: true };
  }

  const stripeClient = getStripe();
  const paymentIntent = await stripeClient.paymentIntents.retrieve(params.paymentIntentId);

  if (paymentIntent.status === 'succeeded' && paymentIntent.latest_charge) {
    await stripeClient.refunds.create({
      charge: paymentIntent.latest_charge as string,
      reason: 'requested_by_customer',
      metadata: { order_id: params.orderId, reason: params.reason },
    });
    return { refunded: true };
  }

  // Not captured yet — cancel instead of refund
  if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(paymentIntent.status)) {
    await stripeClient.paymentIntents.cancel(paymentIntent.id);
    return { refunded: true };
  }

  return { refunded: false };
}

export async function transferToCourier(params: {
  amountCents: number;
  courierStripeAccountId: string;
  chargeId: string;
  orderId: string;
}): Promise<Stripe.Transfer> {
  if (isStripeDevMode()) {
    const id = `tr_dev_${randomUUID().replace(/-/g, '')}`;
    console.log(`[DEV] Simulated courier transfer ${id}: ${params.amountCents}¢ → ${params.courierStripeAccountId}`);
    return { id, object: 'transfer', amount: params.amountCents } as unknown as Stripe.Transfer;
  }

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
  if (isStripeDevMode()) {
    const id = `tr_dev_${randomUUID().replace(/-/g, '')}`;
    console.log(`[DEV] Simulated donor transfer ${id}: ${params.amountCents}¢ → ${params.donorStripeAccountId}`);
    return { id, object: 'transfer', amount: params.amountCents } as unknown as Stripe.Transfer;
  }

  return getStripe().transfers.create({
    amount: params.amountCents,
    currency: 'usd',
    destination: params.donorStripeAccountId,
    source_transaction: params.chargeId,
    metadata: { order_id: params.orderId, reason: 'donor_payout' },
  });
}

// ─── Stripe Connect Express onboarding (TRD Step 3/10, decision #2: Express) ──

export async function createConnectAccount(params: {
  userId: string;
  email: string;
}): Promise<{ accountId: string }> {
  if (isStripeDevMode()) {
    const accountId = `acct_dev_${randomUUID()}`;
    console.log(`[DEV] Simulated Connect account ${accountId} for user ${params.userId}`);
    return { accountId };
  }

  const account = await getStripe().accounts.create({
    type: 'express',
    email: params.email,
    capabilities: { transfers: { requested: true } },
    metadata: { user_id: params.userId },
  });
  return { accountId: account.id };
}

export async function createConnectOnboardingLink(params: {
  accountId: string;
  refreshUrl: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  if (isStripeDevMode()) {
    // Simulates instant completion — dev mode has no real onboarding flow
    return { url: params.returnUrl };
  }

  const accountLink = await getStripe().accountLinks.create({
    account: params.accountId,
    refresh_url: params.refreshUrl,
    return_url: params.returnUrl,
    type: 'account_onboarding',
  });
  return { url: accountLink.url };
}

export async function getConnectAccountStatus(accountId: string): Promise<{ payoutsEnabled: boolean }> {
  if (isStripeDevMode()) {
    return { payoutsEnabled: true };
  }
  // A dev-onboarded synthetic account can never receive real transfers — never
  // report it payable once real Stripe keys are in place. (See
  // scripts/cleanup-dev-stripe-accounts.sql for purging these rows.)
  if (accountId.startsWith('acct_dev_')) {
    return { payoutsEnabled: false };
  }

  const account = await getStripe().accounts.retrieve(accountId);
  return { payoutsEnabled: account.payouts_enabled === true };
}

export type TransferEligibility =
  | { ok: true }
  | { ok: false; reason: 'no_stripe_account' | 'payouts_disabled' | 'dev_account_in_real_mode' };

// Single guard for EVERY transfer path (donor payout, courier fee). An account
// is payable only when it exists, onboarding finished (payouts_enabled), and
// it isn't a synthetic acct_dev_* id left over from dev mode while real Stripe
// keys are active. Callers route { ok: false } into their skipped-payout audit
// branch — never into a retry loop.
export function canReceiveTransfers(account: {
  stripeAccountId: string | null | undefined;
  payoutsEnabled: boolean;
}): TransferEligibility {
  if (!account.stripeAccountId) {
    return { ok: false, reason: 'no_stripe_account' };
  }
  if (account.stripeAccountId.startsWith('acct_dev_') && !isStripeDevMode()) {
    return { ok: false, reason: 'dev_account_in_real_mode' };
  }
  if (!account.payoutsEnabled) {
    return { ok: false, reason: 'payouts_disabled' };
  }
  return { ok: true };
}
