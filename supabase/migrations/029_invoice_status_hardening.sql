-- 029_invoice_status_hardening.sql
-- Task 3 (model-independent cleanup) — the deferred billing minor from the
-- whole-branch review: invoices.status is NOT NULL, so a webhook payload with a
-- null invoice_status would violate the constraint, roll the whole txn back
-- (INCLUDING the processed_stripe_events dedup row), and let Stripe redeliver
-- the same poison event forever. This contradicts the deliberate "a mirror of an
-- external enum must never RAISE and wedge the webhook" posture that 027 applied
-- to merchants.subscription_status.
--
-- Fix, entirely inside handle_billing_webhook (CREATE OR REPLACE — the rest of
-- the function is byte-identical to 027):
--   * If a required invoice field is absent (no stripe_invoice_id), ACK-and-skip
--     (RETURN 'ignored') — the dedup row commits, so Stripe stops retrying.
--   * COALESCE a missing/empty invoice_status to the 'unknown' sentinel so the
--     NOT NULL column can never wedge on a null status.
--
-- Idempotent (CREATE OR REPLACE FUNCTION; REVOKE is a no-op on replay).
-- SQL-editor run is a PENDING USER action. Depends on 027 (invoices,
-- processed_stripe_events, handle_billing_webhook).

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
    UPDATE public.merchants SET
      stripe_subscription_id          = p_payload->>'stripe_subscription_id',
      subscription_status             = p_payload->>'subscription_status',
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
    -- HARDENING (029): a malformed payload must not wedge the webhook. Without an
    -- invoice id there's nothing to mirror — ack-and-skip. And COALESCE a
    -- missing status to a sentinel so the NOT NULL column can't roll the txn
    -- back and trigger an infinite Stripe retry.
    IF p_payload->>'stripe_invoice_id' IS NULL THEN
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
