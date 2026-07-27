'use server';

// Merchant subscription billing actions (Task B — SUBSCRIPTION LANE ONLY; no
// sale lane). Ops-initiated: an admin sets a merchant up on Stripe Billing.
//
// Dev vs prod (the src/lib/stripe.ts dev-mode pattern, applied at the action
// level like the payment flow does):
//   - dev  (no STRIPE_SECRET_KEY): create a synthetic Customer, link it, then
//     drive a synthetic customer.subscription.created + invoice.paid through
//     the SAME handle_billing_webhook RPC prod's webhook uses — so the merchant
//     lands 'active' with an invoice mirror row, no real charge, no network.
//   - prod: create the Customer, link it, then return a Checkout Session URL
//     (mode:'subscription'); the subscription goes 'active' when Stripe's
//     webhook fires customer.subscription.created against
//     /api/stripe/billing/webhook.
//
// requireAdmin()/assertAdmin() are copied VERBATIM from allocations.ts — every
// 'use server' export is its own HTTP endpoint and must self-guard.

import { randomUUID } from 'crypto';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import {
  isStripeDevMode,
  createBillingCustomer,
  createSubscriptionCheckoutSession,
} from '@/lib/stripe';
import { BILLING_PLANS, isBillingPlan, addBillingInterval } from '@/lib/billing';

async function requireAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const service = await createServiceClient();
  const { data } = await service
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  return data?.role === 'admin';
}

export type StartSubscriptionResult =
  | { success: true; mode: 'dev_simulated' }
  | { success: true; mode: 'checkout'; checkoutUrl: string }
  | {
      success: false;
      error:
        | 'NOT_ADMIN'
        | 'MERCHANT_NOT_FOUND'
        | 'NOT_SUBSCRIPTION_PLAN'
        | 'ALREADY_SUBSCRIBED'
        | 'PRICE_NOT_CONFIGURED'
        | 'SERVER_ERROR';
    };

/**
 * Starts (or resumes) a merchant's subscription on their current plan. Admin
 * only. Idempotent-ish: an already active/trialing merchant returns
 * ALREADY_SUBSCRIBED rather than creating a second subscription; a merchant
 * with a linked Customer but no live subscription reuses that Customer.
 */
export async function startMerchantSubscription(merchantId: string): Promise<StartSubscriptionResult> {
  if (!(await requireAdmin())) return { success: false, error: 'NOT_ADMIN' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'NOT_ADMIN' };

  const service = await createServiceClient();

  const { data: merchant, error: merchantError } = await service
    .from('merchants')
    .select('id, business_name, plan, fee_cents, stripe_customer_id, subscription_status, users!inner(email)')
    .eq('id', merchantId)
    .maybeSingle();
  if (merchantError) return { success: false, error: 'SERVER_ERROR' };
  if (!merchant) return { success: false, error: 'MERCHANT_NOT_FOUND' };

  if (!isBillingPlan(merchant.plan)) return { success: false, error: 'NOT_SUBSCRIPTION_PLAN' };
  if (merchant.subscription_status === 'active' || merchant.subscription_status === 'trialing') {
    return { success: false, error: 'ALREADY_SUBSCRIBED' };
  }

  const plan = BILLING_PLANS[merchant.plan];
  const email = (merchant.users as unknown as { email: string } | null)?.email ?? '';

  // Ensure a Stripe Customer, then take the AUTHORITATIVE id back from the link
  // RPC (handles the already-linked case — never creates a duplicate Customer,
  // and guarantees the id we use below matches the merchant row so the
  // dev-mode webhook can resolve the merchant).
  let customerId = merchant.stripe_customer_id as string | null;
  if (!customerId) {
    const { customerId: created } = await createBillingCustomer({
      merchantId,
      email,
      name: merchant.business_name,
    });
    const { data: linked, error: linkError } = await service.rpc('link_billing_customer', {
      p_merchant_id: merchantId,
      p_stripe_customer_id: created,
      p_actor: user.id,
    });
    if (linkError || !linked) return { success: false, error: 'SERVER_ERROR' };
    customerId = linked.stripe_customer_id as string;
  }

  if (isStripeDevMode()) {
    const now = new Date().toISOString();
    const periodEnd = addBillingInterval(now, plan.interval);
    const subId = `sub_dev_${randomUUID().replace(/-/g, '')}`;
    const invoiceId = `in_dev_${randomUUID().replace(/-/g, '')}`;

    const sub = await service.rpc('handle_billing_webhook', {
      p_event_id: `evt_dev_${randomUUID().replace(/-/g, '')}`,
      p_event_type: 'customer.subscription.created',
      p_payload: {
        stripe_customer_id: customerId,
        stripe_subscription_id: subId,
        subscription_status: 'active',
        current_period_end: periodEnd,
      },
    });
    if (sub.error) return { success: false, error: 'SERVER_ERROR' };

    const inv = await service.rpc('handle_billing_webhook', {
      p_event_id: `evt_dev_${randomUUID().replace(/-/g, '')}`,
      p_event_type: 'invoice.paid',
      p_payload: {
        stripe_customer_id: customerId,
        stripe_invoice_id: invoiceId,
        stripe_subscription_id: subId,
        invoice_status: 'paid',
        amount_due_cents: String(merchant.fee_cents),
        amount_paid_cents: String(merchant.fee_cents),
        currency: 'usd',
        period_start: now,
        period_end: periodEnd,
        hosted_invoice_url: null,
      },
    });
    if (inv.error) return { success: false, error: 'SERVER_ERROR' };

    return { success: true, mode: 'dev_simulated' };
  }

  // Real mode — a Checkout Session; the webhook flips the merchant 'active'.
  const priceId = process.env[plan.priceEnvVar];
  if (!priceId) return { success: false, error: 'PRICE_NOT_CONFIGURED' };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  try {
    const { url } = await createSubscriptionCheckoutSession({
      customerId: customerId as string,
      priceId,
      merchantId,
      successUrl: `${appUrl}/admin/dashboard?billing=started`,
      cancelUrl: `${appUrl}/admin/dashboard?billing=canceled`,
    });
    return { success: true, mode: 'checkout', checkoutUrl: url };
  } catch (err) {
    console.error('[startMerchantSubscription] checkout session failed:', err);
    return { success: false, error: 'SERVER_ERROR' };
  }
}
