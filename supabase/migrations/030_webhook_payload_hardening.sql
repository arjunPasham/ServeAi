-- 030_webhook_payload_hardening.sql
-- Whole-branch review follow-up (Important I1 + Minor M1): complete the webhook
-- payload hardening 029 started. 029 hardened only the INVOICE branch; the
-- SUBSCRIPTION branch had the identical wedge — merchants.subscription_status is
-- NOT NULL (027) but was assigned the raw p_payload->>'subscription_status', so a
-- customer.subscription.* payload with a null/absent status would violate NOT
-- NULL, roll the whole txn back (INCLUDING the processed_stripe_events dedup
-- row), and let Stripe redeliver the same poison event forever — the exact
-- failure mode 029's premise ("a mirror of an external enum must never RAISE and
-- wedge the webhook") forbids.
--
-- Fixes, both inside handle_billing_webhook (CREATE OR REPLACE — otherwise
-- byte-identical to 029):
--   * I1: COALESCE(NULLIF(subscription_status,''), 'none') in the subscription
--         UPDATE — the same posture as 029's invoice-status COALESCE.
--   * M1: the missing-invoice-id ack-and-skip guard now uses NULLIF(...,'') so an
--         EMPTY-STRING id is skipped too (029 used IS NULL, which let '' through
--         and upserted a junk row keyed on an empty id).
--
-- Idempotent (CREATE OR REPLACE FUNCTION; REVOKE is a no-op on replay).
-- SQL-editor run is a PENDING USER action. Depends on 027 (invoices,
-- processed_stripe_events) and supersedes 029's function definition.

CREATE OR REPLACE FUNCTION handle_billing_webhook(
  p_event_id   TEXT,
  p_event_type TEXT,
  p_payload    JSONB
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_merchant_id UUID;
BEGIN
  INSERT INTO public.processed_stripe_events (event_id, event_type)
  VALUES (p_event_id, p_event_type)
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN 'duplicate';
  END IF;

  SELECT id INTO v_merchant_id
  FROM public.merchants
  WHERE stripe_customer_id = p_payload->>'stripe_customer_id';
  IF v_merchant_id IS NULL THEN
    -- Event acked (dedup row persists) but there's no merchant to apply it to.
    RETURN 'ignored';
  END IF;

  IF p_event_type IN ('customer.subscription.created',
                      'customer.subscription.updated',
                      'customer.subscription.deleted') THEN
    -- COALESCE the status (I1): a null/absent status must not violate the NOT
    -- NULL column and wedge the webhook — fall back to the 'none' sentinel.
    UPDATE public.merchants SET
      stripe_subscription_id          = p_payload->>'stripe_subscription_id',
      subscription_status             = COALESCE(NULLIF(p_payload->>'subscription_status', ''), 'none'),
      subscription_current_period_end = NULLIF(p_payload->>'current_period_end', '')::timestamptz
    WHERE id = v_merchant_id;

    INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
    VALUES ('merchant', v_merchant_id, 'subscription_' || split_part(p_event_type, '.', 3), NULL, 'system',
            jsonb_build_object('stripe_subscription_id', p_payload->>'stripe_subscription_id',
                               'subscription_status', p_payload->>'subscription_status',
                               'stripe_event_id', p_event_id));
    RETURN 'processed';

  ELSIF p_event_type IN ('invoice.paid',
                         'invoice.payment_succeeded',
                         'invoice.payment_failed',
                         'invoice.finalized') THEN
    -- Without a usable invoice id there's nothing to mirror — ack-and-skip.
    -- NULLIF so an EMPTY-STRING id (M1) is treated the same as a missing one.
    IF NULLIF(p_payload->>'stripe_invoice_id', '') IS NULL THEN
      RETURN 'ignored';
    END IF;

    INSERT INTO public.invoices (
      merchant_id, stripe_invoice_id, stripe_subscription_id, status,
      amount_due_cents, amount_paid_cents, currency, period_start, period_end, hosted_invoice_url
    ) VALUES (
      v_merchant_id, p_payload->>'stripe_invoice_id', p_payload->>'stripe_subscription_id',
      COALESCE(NULLIF(p_payload->>'invoice_status', ''), 'unknown'),
      COALESCE((p_payload->>'amount_due_cents')::integer, 0),
      COALESCE((p_payload->>'amount_paid_cents')::integer, 0),
      COALESCE(NULLIF(p_payload->>'currency', ''), 'usd'),
      NULLIF(p_payload->>'period_start', '')::timestamptz,
      NULLIF(p_payload->>'period_end', '')::timestamptz,
      p_payload->>'hosted_invoice_url'
    )
    ON CONFLICT (stripe_invoice_id) DO UPDATE SET
      status             = EXCLUDED.status,
      amount_due_cents   = EXCLUDED.amount_due_cents,
      amount_paid_cents  = EXCLUDED.amount_paid_cents,
      period_start       = EXCLUDED.period_start,
      period_end         = EXCLUDED.period_end,
      hosted_invoice_url = EXCLUDED.hosted_invoice_url,
      updated_at         = NOW();

    INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
    VALUES ('merchant', v_merchant_id, 'invoice_' || split_part(p_event_type, '.', 2), NULL, 'system',
            jsonb_build_object('stripe_invoice_id', p_payload->>'stripe_invoice_id',
                               'invoice_status', p_payload->>'invoice_status',
                               'amount_due_cents', p_payload->>'amount_due_cents',
                               'stripe_event_id', p_event_id));
    RETURN 'processed';

  ELSE
    RETURN 'ignored';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION handle_billing_webhook(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
