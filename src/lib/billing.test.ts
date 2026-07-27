import { describe, expect, test } from 'vitest';
import type Stripe from 'stripe';
import {
  BILLING_PLANS,
  isBillingPlan,
  canStartSubscription,
  subscriptionStatusLabel,
  addBillingInterval,
  buildBillingEventPayload,
} from './billing';

describe('BILLING_PLANS / isBillingPlan', () => {
  test('the three subscription plans map to their intervals', () => {
    expect(BILLING_PLANS.weekly.interval).toBe('week');
    expect(BILLING_PLANS.monthly.interval).toBe('month');
    expect(BILLING_PLANS.annual.interval).toBe('year');
  });

  test('isBillingPlan accepts the three plans and rejects the usage lane', () => {
    expect(isBillingPlan('weekly')).toBe(true);
    expect(isBillingPlan('monthly')).toBe(true);
    expect(isBillingPlan('annual')).toBe(true);
    expect(isBillingPlan('per_pickup')).toBe(false); // usage/sale lane, not billable via subscription
    expect(isBillingPlan('nope')).toBe(false);
  });
});

describe('canStartSubscription', () => {
  test('only no-live-subscription states can start a new one', () => {
    for (const s of ['none', 'canceled', 'incomplete_expired']) {
      expect(canStartSubscription(s)).toBe(true);
    }
  });
  test('any live/dunning subscription state blocks a new one (no double-billing)', () => {
    for (const s of ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']) {
      expect(canStartSubscription(s)).toBe(false);
    }
  });
  test('an unknown/future status is treated as NOT startable (conservative)', () => {
    expect(canStartSubscription('some_new_stripe_status')).toBe(false);
  });
});

describe('subscriptionStatusLabel', () => {
  test('maps known statuses to friendly labels', () => {
    expect(subscriptionStatusLabel('none')).toBe('No subscription');
    expect(subscriptionStatusLabel('active')).toBe('Active');
    expect(subscriptionStatusLabel('past_due')).toBe('Past due');
  });
  test('falls back to the raw value for an unknown status', () => {
    expect(subscriptionStatusLabel('some_new_status')).toBe('some_new_status');
  });
});

describe('addBillingInterval', () => {
  test('advances by one interval in UTC', () => {
    expect(addBillingInterval('2026-01-01T00:00:00.000Z', 'week')).toBe('2026-01-08T00:00:00.000Z');
    expect(addBillingInterval('2026-01-01T00:00:00.000Z', 'month')).toBe('2026-02-01T00:00:00.000Z');
    expect(addBillingInterval('2026-01-01T00:00:00.000Z', 'year')).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('buildBillingEventPayload', () => {
  test('maps a subscription event (customer as id, period end from the item)', () => {
    const event = {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_123',
          customer: 'cus_123',
          status: 'active',
          items: { data: [{ current_period_end: 1_900_000_000 }] },
        },
      },
    } as unknown as Stripe.Event;

    expect(buildBillingEventPayload(event)).toEqual({
      stripe_customer_id: 'cus_123',
      stripe_subscription_id: 'sub_123',
      subscription_status: 'active',
      current_period_end: new Date(1_900_000_000 * 1000).toISOString(),
    });
  });

  test('maps an invoice event (customer as object, stringified amounts)', () => {
    const event = {
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_123',
          customer: { id: 'cus_456' },
          subscription: 'sub_456',
          status: 'paid',
          amount_due: 9900,
          amount_paid: 9900,
          currency: 'usd',
          period_start: 1_800_000_000,
          period_end: 1_802_592_000,
          hosted_invoice_url: 'https://pay.stripe.com/x',
        },
      },
    } as unknown as Stripe.Event;

    expect(buildBillingEventPayload(event)).toEqual({
      stripe_customer_id: 'cus_456',
      stripe_invoice_id: 'in_123',
      stripe_subscription_id: 'sub_456',
      invoice_status: 'paid',
      amount_due_cents: '9900',
      amount_paid_cents: '9900',
      currency: 'usd',
      period_start: new Date(1_800_000_000 * 1000).toISOString(),
      period_end: new Date(1_802_592_000 * 1000).toISOString(),
      hosted_invoice_url: 'https://pay.stripe.com/x',
    });
  });

  test('an unhandled event type falls through to just the customer id (RPC will ignore it)', () => {
    const event = {
      type: 'charge.refunded',
      data: { object: { customer: 'cus_789' } },
    } as unknown as Stripe.Event;

    expect(buildBillingEventPayload(event)).toEqual({ stripe_customer_id: 'cus_789' });
  });

  test('missing/absent fields degrade to null, not throw', () => {
    const event = {
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_x', customer: 'cus_x', status: 'canceled', items: { data: [] } } },
    } as unknown as Stripe.Event;

    expect(buildBillingEventPayload(event)).toEqual({
      stripe_customer_id: 'cus_x',
      stripe_subscription_id: 'sub_x',
      subscription_status: 'canceled',
      current_period_end: null,
    });
  });
});
