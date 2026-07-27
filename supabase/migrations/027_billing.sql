-- 027_billing.sql
-- Task B — merchant subscription billing (Stripe Billing, SUBSCRIPTION LANE
-- ONLY; the sale lane is deliberately out of scope, per the pending model
-- decision). Transition-plan Phase 6, subscription half. House idiom
-- throughout (020/024/025): SECURITY DEFINER + SET search_path='', qualified
-- public.*, in-transaction audit_log (IDs/enums/amounts only — no PII),
-- REVOKE from PUBLIC/anon/authenticated. Idempotent; SQL-editor run is a
-- PENDING USER action. Depends on 019 (merchants) and 002 (audit_log).
--
-- What this adds:
--   1. merchants: subscription tracking columns + 'annual' plan tier.
--      (stripe_customer_id already exists — 019:23.)
--   2. invoices          — a mirror of Stripe invoices for the merchant's
--                          subscription (source of truth stays in Stripe;
--                          this is the queryable local copy for the ops UI).
--   3. processed_stripe_events — webhook dedup keyed on Stripe's event.id, so
--                          a duplicate/redelivered webhook can't double-process
--                          (the deferred audit item). First-writer-wins.
--   4. link_billing_customer   — records the Stripe Customer id on a merchant
--                          (idempotent; never overwrites an existing link).
--   5. handle_billing_webhook  — the ONE guarded entry point the webhook route
--                          (and the dev-mode simulation) calls. Dedup + apply
--                          in a single transaction, so a transient failure
--                          rolls back the dedup row too and Stripe's retry can
--                          reprocess.

-- ─── 1. merchants: subscription tracking ────────────────────────────────────
-- Stripe subscription id + status mirror + current period end. subscription_status
-- mirrors Stripe's subscription.status (active/past_due/unpaid/canceled/…);
-- 'none' is our "no subscription yet" sentinel. Intentionally UNconstrained
-- (no CHECK): a mirror of an external enum must not RAISE — and thereby wedge
-- the webhook into an infinite Stripe retry — if Stripe ever introduces a new
-- status. Dunning lives in these values (past_due / unpaid), set by the
-- customer.subscription.updated webhook.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS stripe_subscription_id          TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS subscription_status             TEXT NOT NULL DEFAULT 'none';
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMPTZ;

-- Extend the plan tier set to include 'annual' (weekly = $99/wk flagship,
-- monthly + annual are the other billing intervals of the same membership).
-- Drop the existing plan CHECK by whatever name it carries (inline column
-- CHECKs are auto-named merchants_plan_check, but resolve it dynamically so
-- this is robust and idempotent on replay), then re-add the widened one.
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.merchants'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%plan%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.merchants DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE merchants ADD CONSTRAINT merchants_plan_check
  CHECK (plan IN ('weekly','monthly','annual','per_pickup'));

-- ─── 2. invoices (mirror of Stripe subscription invoices) ───────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id            UUID NOT NULL REFERENCES merchants(id),
  stripe_invoice_id      TEXT NOT NULL UNIQUE,          -- mirror/idempotency key
  stripe_subscription_id TEXT,
  status                 TEXT NOT NULL,                 -- Stripe invoice status: draft/open/paid/uncollectible/void
  amount_due_cents       INTEGER NOT NULL DEFAULT 0 CHECK (amount_due_cents >= 0),
  amount_paid_cents      INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  currency               TEXT NOT NULL DEFAULT 'usd',
  period_start           TIMESTAMPTZ,
  period_end             TIMESTAMPTZ,
  hosted_invoice_url     TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_merchant ON invoices (merchant_id, created_at DESC);

DROP TRIGGER IF EXISTS invoices_updated_at ON invoices;
CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

-- A merchant reads its own invoices; admins read all; every write goes through
-- the service client / handle_billing_webhook. Mirrors the 019/020 posture.
DROP POLICY IF EXISTS "invoices_select_own" ON invoices;
CREATE POLICY "invoices_select_own" ON invoices
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM merchants m
                 WHERE m.id = invoices.merchant_id AND m.user_id = auth.uid()));

DROP POLICY IF EXISTS "invoices_admin_all" ON invoices;
CREATE POLICY "invoices_admin_all" ON invoices
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

-- ─── 3. processed_stripe_events (webhook dedup) ─────────────────────────────
-- One row per Stripe event.id we've handled. RLS on with NO policies: only the
-- service role (which bypasses RLS) ever touches it — there is no user-facing
-- read of this table.
CREATE TABLE IF NOT EXISTS processed_stripe_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE processed_stripe_events ENABLE ROW LEVEL SECURITY;

-- ─── 4. RPC: link a Stripe Customer to a merchant ───────────────────────────
-- Idempotent: sets stripe_customer_id only when it's currently NULL, so a
-- replay (or a second call) never overwrites an existing customer link.
CREATE OR REPLACE FUNCTION link_billing_customer(
  p_merchant_id        UUID,
  p_stripe_customer_id TEXT,
  p_actor              UUID
) RETURNS merchants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_merchant public.merchants;
BEGIN
  UPDATE public.merchants
    SET stripe_customer_id = p_stripe_customer_id
    WHERE id = p_merchant_id AND stripe_customer_id IS NULL
    RETURNING * INTO v_merchant;

  IF NOT FOUND THEN
    -- Merchant missing, or a customer is already linked (no-op, no audit).
    SELECT * INTO v_merchant FROM public.merchants WHERE id = p_merchant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MERCHANT_NOT_FOUND' USING HINT = 'no merchant with that id';
    END IF;
    RETURN v_merchant;
  END IF;

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('merchant', p_merchant_id, 'billing_customer_linked', p_actor, 'admin',
          jsonb_build_object('stripe_customer_id', p_stripe_customer_id));

  RETURN v_merchant;
END;
$$;

REVOKE EXECUTE ON FUNCTION link_billing_customer(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;

-- ─── 5. RPC: apply a billing webhook event (dedup + state transition) ───────
-- The single entry point for every subscription/invoice event — from the real
-- webhook route AND from the dev-mode simulation (which drives synthetic events
-- through this same path). Returns 'processed' | 'duplicate' | 'ignored'.
--
-- Dedup is first-writer-wins: the INSERT ... ON CONFLICT DO NOTHING either
-- claims the event id (FOUND) or reveals it was already handled (RETURN
-- 'duplicate'). Because the whole function is one transaction, a failure in the
-- apply step rolls back the dedup row too, so Stripe's retry can reprocess — we
-- never mark an event done without also applying it.
--
-- p_payload keys (all optional except stripe_customer_id):
--   stripe_customer_id, stripe_subscription_id, subscription_status,
--   current_period_end (ISO), stripe_invoice_id, invoice_status,
--   amount_due_cents, amount_paid_cents, currency, period_start, period_end,
--   hosted_invoice_url
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
    -- merchant.subscription_status is driven ONLY by subscription.* events —
    -- the single source of truth for the dunning state.
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
    -- invoice.* events drive the invoices mirror only. Upsert on the Stripe
    -- invoice id so out-of-order / repeated deliveries converge to the latest.
    INSERT INTO public.invoices (
      merchant_id, stripe_invoice_id, stripe_subscription_id, status,
      amount_due_cents, amount_paid_cents, currency, period_start, period_end, hosted_invoice_url
    ) VALUES (
      v_merchant_id, p_payload->>'stripe_invoice_id', p_payload->>'stripe_subscription_id',
      p_payload->>'invoice_status',
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
    -- Subscribed-to but not acted on (still deduped/acked).
    RETURN 'ignored';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION handle_billing_webhook(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
