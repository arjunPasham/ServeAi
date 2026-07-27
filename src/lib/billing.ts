// Merchant subscription billing — pure helpers (Task B). No Stripe SDK calls
// here (those live in src/lib/stripe.ts behind isStripeDevMode); this module is
// the plan catalog + the pure webhook-event → RPC-payload mapper, both
// unit-tested. SUBSCRIPTION LANE ONLY — there is no sale-lane logic anywhere.

import type Stripe from 'stripe';

export type BillingPlan = 'weekly' | 'monthly' | 'annual';

export interface PlanConfig {
  interval: 'week' | 'month' | 'year';
  label: string;
  // Env var holding this plan's Stripe Price id. The dollar amount lives on the
  // Stripe Price (dashboard-configured), NOT here — so we never hardcode (or
  // drift from) the real price. weekly is the $99/wk flagship; monthly/annual
  // are the other billing intervals of the same membership (one Product, three
  // Prices — the Stripe best-practice shape for billing-interval variants).
  priceEnvVar: string;
}

export const BILLING_PLANS: Record<BillingPlan, PlanConfig> = {
  weekly:  { interval: 'week',  label: 'Weekly ($99/wk flagship)', priceEnvVar: 'STRIPE_PRICE_WEEKLY' },
  monthly: { interval: 'month', label: 'Monthly',                  priceEnvVar: 'STRIPE_PRICE_MONTHLY' },
  annual:  { interval: 'year',  label: 'Annual',                   priceEnvVar: 'STRIPE_PRICE_ANNUAL' },
};

/** merchants.plan also allows 'per_pickup' (the usage/sale lane, out of scope) — this narrows to the three subscription plans. */
export function isBillingPlan(plan: string): plan is BillingPlan {
  return plan === 'weekly' || plan === 'monthly' || plan === 'annual';
}

// A merchant may START a new subscription ONLY when they have no live one, or
// double-billing results: active/trialing are subscribed; past_due/unpaid/
// incomplete/paused all mean a subscription Stripe is still managing (dunning /
// awaiting first payment), so a fresh Checkout would create a SECOND
// subscription. Only these terminal/empty states are safe to (re)start from.
// An unknown/future status is treated as NOT startable (conservative — never
// risk a duplicate charge).
const STARTABLE_SUBSCRIPTION_STATUSES = new Set(['none', 'canceled', 'incomplete_expired']);
export function canStartSubscription(subscriptionStatus: string): boolean {
  return STARTABLE_SUBSCRIPTION_STATUSES.has(subscriptionStatus);
}

/** Advances an ISO timestamp by one billing interval. Used to synthesize a
 *  current_period_end for the dev-mode subscription simulation. Pure. */
export function addBillingInterval(fromIso: string, interval: PlanConfig['interval']): string {
  const d = new Date(fromIso);
  if (interval === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else if (interval === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString();
}

// ─── Webhook event → handle_billing_webhook payload ─────────────────────────

/** JSONB payload shape handle_billing_webhook (027) consumes. All string|null;
 *  the RPC casts amounts/timestamps out of the text. */
export type BillingEventPayload = Record<string, string | null>;

function asStripeId(ref: unknown): string | null {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && typeof (ref as { id?: unknown }).id === 'string') {
    return (ref as { id: string }).id;
  }
  return null;
}

function epochToIso(epochSeconds: unknown): string | null {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return null;
  return new Date(epochSeconds * 1000).toISOString();
}

// current_period_end moved onto subscription items in recent Stripe API
// versions (SDK v22); read the item first, fall back to the older top-level
// field. Best-effort — it only feeds the display mirror, never a gate.
function subscriptionPeriodEnd(sub: Stripe.Subscription): number | null {
  const item = sub.items?.data?.[0] as { current_period_end?: number } | undefined;
  if (item && typeof item.current_period_end === 'number') return item.current_period_end;
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  return typeof top === 'number' ? top : null;
}

/**
 * Maps a Stripe billing webhook event to the flat payload handle_billing_webhook
 * expects. Pure — the webhook route builds this then calls the RPC; the RPC
 * decides handled/ignored by event_type, so an unmapped type still passes
 * through (carrying just the customer id, if any). Amounts are stringified
 * because the RPC reads them back with ->>'…'::integer.
 */
export function buildBillingEventPayload(event: Stripe.Event): BillingEventPayload {
  const obj = event.data.object as unknown as Record<string, unknown>;

  if (event.type.startsWith('customer.subscription.')) {
    const sub = obj as unknown as Stripe.Subscription;
    return {
      stripe_customer_id: asStripeId(sub.customer),
      stripe_subscription_id: sub.id ?? null,
      subscription_status: sub.status ?? null,
      current_period_end: epochToIso(subscriptionPeriodEnd(sub)),
    };
  }

  if (event.type.startsWith('invoice.')) {
    const inv = obj as unknown as Stripe.Invoice;
    return {
      stripe_customer_id: asStripeId(inv.customer),
      stripe_invoice_id: inv.id ?? null,
      stripe_subscription_id: asStripeId((inv as unknown as { subscription?: unknown }).subscription),
      invoice_status: inv.status ?? null,
      amount_due_cents: String(inv.amount_due ?? 0),
      amount_paid_cents: String(inv.amount_paid ?? 0),
      currency: inv.currency ?? 'usd',
      period_start: epochToIso(inv.period_start),
      period_end: epochToIso(inv.period_end),
      hosted_invoice_url: inv.hosted_invoice_url ?? null,
    };
  }

  return { stripe_customer_id: asStripeId((obj as { customer?: unknown }).customer) };
}
