// Task B — link_billing_customer / handle_billing_webhook RPC invariants
// (027_billing.sql). Exercises the RPCs directly against the real dev DB,
// mirroring allocations.api.spec.ts. The dev-mode simulation
// (startMerchantSubscription) and the /api/stripe/billing/webhook route are
// thin glue over these RPCs and buildBillingEventPayload (unit-tested in
// src/lib/billing.test.ts) — no server action / HTTP layer is reachable from
// this project, same as the other api specs.
//
// Cleanup: invoices are swept by cleanup()'s merchant sweep (helpers.ts);
// processed_stripe_events rows carry the run id in their event_id so afterAll
// can delete them (they're append-only dedup markers with no FK).
import { test, expect } from '@playwright/test';
import {
  getServiceClient,
  newContext,
  createTestUser,
  createMerchant,
  cleanup,
  type TestContext,
} from './helpers';

let ctx: TestContext;
const service = getServiceClient();

function periodEnd(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

test.describe('billing RPCs', () => {
  test.beforeAll(() => {
    ctx = newContext('billing');
  });

  test.afterAll(async () => {
    await service.from('processed_stripe_events').delete().like('event_id', `%${ctx.runId}%`);
    await cleanup(ctx);
  });

  test('link_billing_customer is idempotent — it never overwrites an existing customer', async () => {
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'link' });
    const { merchantId } = await createMerchant(ctx, user.id);
    const custA = `cus_${ctx.runId}_A`;
    const custB = `cus_${ctx.runId}_B`;

    const { data: first, error: e1 } = await service.rpc('link_billing_customer', {
      p_merchant_id: merchantId,
      p_stripe_customer_id: custA,
      p_actor: user.id,
    });
    expect(e1).toBeNull();
    expect(first.stripe_customer_id).toBe(custA);

    // A second link with a DIFFERENT id must be a no-op (returns the existing row).
    const { data: second, error: e2 } = await service.rpc('link_billing_customer', {
      p_merchant_id: merchantId,
      p_stripe_customer_id: custB,
      p_actor: user.id,
    });
    expect(e2).toBeNull();
    expect(second.stripe_customer_id).toBe(custA);
  });

  test('handle_billing_webhook applies a subscription event, dedups a replay, and applies a later update', async () => {
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'sub' });
    const { merchantId } = await createMerchant(ctx, user.id);
    const customerId = `cus_${ctx.runId}_sub`;
    await service.rpc('link_billing_customer', {
      p_merchant_id: merchantId,
      p_stripe_customer_id: customerId,
      p_actor: user.id,
    });

    const evtCreate = `evt-${ctx.runId}-create`;
    const { data: r1, error: e1 } = await service.rpc('handle_billing_webhook', {
      p_event_id: evtCreate,
      p_event_type: 'customer.subscription.created',
      p_payload: {
        stripe_customer_id: customerId,
        stripe_subscription_id: `sub_${ctx.runId}`,
        subscription_status: 'active',
        current_period_end: periodEnd(),
      },
    });
    expect(e1).toBeNull();
    expect(r1).toBe('processed');

    const { data: m1 } = await service.from('merchants').select('subscription_status, stripe_subscription_id').eq('id', merchantId).single();
    expect(m1!.subscription_status).toBe('active');
    expect(m1!.stripe_subscription_id).toBe(`sub_${ctx.runId}`);

    // Replay of the SAME event id → deduped, not reprocessed.
    const { data: r2, error: e2 } = await service.rpc('handle_billing_webhook', {
      p_event_id: evtCreate,
      p_event_type: 'customer.subscription.created',
      p_payload: {
        stripe_customer_id: customerId,
        stripe_subscription_id: `sub_${ctx.runId}`,
        subscription_status: 'canceled', // would flip status IF it weren't deduped
        current_period_end: periodEnd(),
      },
    });
    expect(e2).toBeNull();
    expect(r2).toBe('duplicate');

    const { data: m2 } = await service.from('merchants').select('subscription_status').eq('id', merchantId).single();
    expect(m2!.subscription_status).toBe('active'); // unchanged by the deduped replay

    // A NEW event id with a dunning status → applied (proves updates still flow).
    const { data: r3, error: e3 } = await service.rpc('handle_billing_webhook', {
      p_event_id: `evt-${ctx.runId}-update`,
      p_event_type: 'customer.subscription.updated',
      p_payload: {
        stripe_customer_id: customerId,
        stripe_subscription_id: `sub_${ctx.runId}`,
        subscription_status: 'past_due',
        current_period_end: periodEnd(),
      },
    });
    expect(e3).toBeNull();
    expect(r3).toBe('processed');

    const { data: m3 } = await service.from('merchants').select('subscription_status').eq('id', merchantId).single();
    expect(m3!.subscription_status).toBe('past_due');
  });

  test('handle_billing_webhook mirrors an invoice; an unmapped customer is ignored (acked, not retried)', async () => {
    const user = await createTestUser(ctx, 'donor', { emailLabel: 'inv' });
    const { merchantId } = await createMerchant(ctx, user.id);
    const customerId = `cus_${ctx.runId}_inv`;
    await service.rpc('link_billing_customer', {
      p_merchant_id: merchantId,
      p_stripe_customer_id: customerId,
      p_actor: user.id,
    });

    const invoiceId = `in_${ctx.runId}`;
    const { data: r1, error: e1 } = await service.rpc('handle_billing_webhook', {
      p_event_id: `evt-${ctx.runId}-invoice`,
      p_event_type: 'invoice.paid',
      p_payload: {
        stripe_customer_id: customerId,
        stripe_invoice_id: invoiceId,
        stripe_subscription_id: `sub_${ctx.runId}`,
        invoice_status: 'paid',
        amount_due_cents: '9900',
        amount_paid_cents: '9900',
        currency: 'usd',
        period_start: new Date().toISOString(),
        period_end: periodEnd(),
        hosted_invoice_url: null,
      },
    });
    expect(e1).toBeNull();
    expect(r1).toBe('processed');

    const { data: invoice } = await service
      .from('invoices')
      .select('merchant_id, status, amount_paid_cents')
      .eq('stripe_invoice_id', invoiceId)
      .single();
    expect(invoice!.merchant_id).toBe(merchantId);
    expect(invoice!.status).toBe('paid');
    expect(invoice!.amount_paid_cents).toBe(9900);

    // An event for a customer we don't know → 'ignored' (dedup row persists so
    // Stripe stops retrying; nothing applied).
    const { data: r2, error: e2 } = await service.rpc('handle_billing_webhook', {
      p_event_id: `evt-${ctx.runId}-unmapped`,
      p_event_type: 'customer.subscription.updated',
      p_payload: {
        stripe_customer_id: `cus_${ctx.runId}_nobody`,
        stripe_subscription_id: 'sub_nobody',
        subscription_status: 'active',
        current_period_end: periodEnd(),
      },
    });
    expect(e2).toBeNull();
    expect(r2).toBe('ignored');
  });
});
