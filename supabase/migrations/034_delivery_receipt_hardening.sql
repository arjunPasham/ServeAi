-- 034_delivery_receipt_hardening.sql
-- v3 whole-branch review follow-up: Minors M1 + M2 (M3/M4/M5 stay tracked
-- follow-ups in progress.md, not addressed here).
--
--   M1: mark_delivered lacked the merchant-ownership re-check its siblings
--       (set_delivery_method / mark_picked_up, 031) enforce. Adds a p_merchant_id
--       arg + the same `v_load.merchant_id <> p_merchant_id -> LOAD_NOT_FOUND`
--       guard. This CHANGES mark_delivered's signature, so the old
--       mark_delivered(UUID, UUID) is dropped first (a bare CREATE OR REPLACE
--       with a new arg list would leave a second overload behind).
--   M2: recipient_confirm_delivery was re-callable after delivery, re-stamping
--       the signer / dispute window on a repeat POST. Made IDEMPOTENT: a confirm
--       on an already-acknowledged delivery is a no-op (no re-stamp, no status
--       change, no new audit row), re-checked under the load lock so two
--       concurrent confirms serialize. The original dispute timer is undisturbed
--       (dispute_window_expires_at is not re-stamped), so it still closes on its
--       original schedule.
--
-- House idiom (031/032): SECURITY DEFINER, SET search_path='', qualified
-- public.*, load row lock, in-transaction audit_log (IDs/enums/bools only — no
-- PII), REVOKE from PUBLIC/anon/authenticated. Idempotent migration
-- (DROP … IF EXISTS + CREATE OR REPLACE + REVOKE). SQL-editor run is a PENDING
-- USER action. Depends on 031 (deliveries), 032 (recipient confirm), 020 (loads).

-- ─── M1: mark_delivered gains a merchant-ownership guard ────────────────────
-- Signature change (adds p_merchant_id) → drop the old 2-arg overload first.
DROP FUNCTION IF EXISTS mark_delivered(UUID, UUID);

CREATE OR REPLACE FUNCTION mark_delivered(
  p_load_id     UUID,
  p_merchant_id UUID,
  p_actor       UUID
) RETURNS deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_load     public.loads;
  v_delivery public.deliveries;
  v_blown    BOOLEAN;
BEGIN
  SELECT * INTO v_load FROM public.loads WHERE id = p_load_id FOR UPDATE;
  -- M1: same ownership guard as set_delivery_method / mark_picked_up.
  IF NOT FOUND OR v_load.merchant_id <> p_merchant_id THEN
    RAISE EXCEPTION 'LOAD_NOT_FOUND' USING HINT = 'no such load for this merchant';
  END IF;
  IF v_load.status NOT IN ('scheduled','picked_up') THEN
    RAISE EXCEPTION 'LOAD_NOT_DELIVERABLE' USING HINT = 'load must be scheduled or picked up to mark delivered';
  END IF;

  v_blown := v_load.earliest_safety_expires_at IS NOT NULL
             AND NOW() > v_load.earliest_safety_expires_at;

  UPDATE public.deliveries
    SET delivered_at = NOW(), window_blown = window_blown OR v_blown
    WHERE load_id = p_load_id
    RETURNING * INTO v_delivery;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_DELIVERY' USING HINT = 'no delivery record — set the method first';
  END IF;

  UPDATE public.loads SET status = 'delivered' WHERE id = p_load_id;

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('load', p_load_id, 'delivery_delivered', p_actor, 'recipient',
          jsonb_build_object('window_blown', v_delivery.window_blown));

  RETURN v_delivery;
END;
$$;

REVOKE EXECUTE ON FUNCTION mark_delivered(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;

-- ─── M2: recipient_confirm_delivery is now idempotent ───────────────────────
CREATE OR REPLACE FUNCTION recipient_confirm_delivery(
  p_allocation_id      UUID,
  p_signer_name        TEXT,
  p_discrepancy_reason TEXT,
  p_expires_at         TIMESTAMPTZ,
  p_actor              UUID
) RETURNS deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery public.deliveries;
  v_load     public.loads;
  v_blown    BOOLEAN;
  v_reason   TEXT := NULLIF(p_discrepancy_reason, '');
BEGIN
  SELECT * INTO v_delivery FROM public.deliveries WHERE allocation_id = p_allocation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_DELIVERY' USING HINT = 'no delivery record for this allocation';
  END IF;

  -- Lock the load, then RE-READ the delivery so two concurrent confirms
  -- serialize: the loser sees acknowledged_at already set and no-ops.
  SELECT * INTO v_load FROM public.loads WHERE id = v_delivery.load_id FOR UPDATE;
  SELECT * INTO v_delivery FROM public.deliveries WHERE allocation_id = p_allocation_id;

  -- M2: already confirmed → idempotent no-op. Do NOT re-stamp signer /
  -- acknowledged_at / dispute_window_expires_at (the original timer stands), and
  -- write no new audit row. Checked before the signer / status validations so a
  -- repeat POST (even with different/blank args) is always a clean no-op.
  IF v_delivery.acknowledged_at IS NOT NULL THEN
    RETURN v_delivery;
  END IF;

  IF v_load.status NOT IN ('scheduled','picked_up','delivered') THEN
    RAISE EXCEPTION 'NOT_CONFIRMABLE' USING HINT = 'load is not awaiting a receipt confirmation';
  END IF;
  IF NULLIF(p_signer_name, '') IS NULL THEN
    RAISE EXCEPTION 'SIGNER_REQUIRED' USING HINT = 'a signer name is required to confirm receipt';
  END IF;

  v_blown := v_load.earliest_safety_expires_at IS NOT NULL
             AND NOW() > v_load.earliest_safety_expires_at;

  UPDATE public.deliveries SET
    delivered_at              = COALESCE(delivered_at, NOW()),
    signer_name               = p_signer_name,
    acknowledged_at           = NOW(),
    dispute_window_expires_at = p_expires_at,
    window_blown              = window_blown OR v_blown,
    discrepancy_reason        = COALESCE(v_reason, discrepancy_reason),
    discrepancy_flagged_at    = CASE WHEN v_reason IS NOT NULL THEN NOW() ELSE discrepancy_flagged_at END
  WHERE allocation_id = p_allocation_id
  RETURNING * INTO v_delivery;

  UPDATE public.loads SET status = 'delivered'
    WHERE id = v_delivery.load_id AND status IN ('scheduled','picked_up');

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('load', v_delivery.load_id, 'delivery_confirmed', p_actor, 'recipient',
          jsonb_build_object('allocation_id', p_allocation_id,
                             'has_discrepancy', v_reason IS NOT NULL,
                             'window_blown', v_delivery.window_blown));

  RETURN v_delivery;
END;
$$;

REVOKE EXECUTE ON FUNCTION recipient_confirm_delivery(UUID, TEXT, TEXT, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;
