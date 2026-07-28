-- 032_recipient_confirm.sql
-- v3 recipient confirm + dispute window (Task 2) — the lightweight, batch-level
-- successor to the CUT Phase 4 per-item custody engine. The recipient confirms
-- receipt on arrival (signer + acknowledgment), the load is marked delivered, a
-- dispute window opens, and within it the recipient MAY flag a discrepancy —
-- RECORDED, NOT REFEREED. On window close the load goes to 'closed' regardless
-- of any flag. No per-item accept/reject, no temperature, no excursion hard-stop.
--
-- House idiom (031 et al.): SECURITY DEFINER, SET search_path='', qualified
-- public.*, load row lock, in-transaction audit_log (IDs/enums/bools only — NO
-- signer name or reason text; 002's payload rule forbids PII), REVOKE from
-- PUBLIC/anon/authenticated. p_actor is nullable so the no-login /inbound token
-- path can drive these (like respond_to_offer). Idempotent; SQL-editor run is a
-- PENDING USER action. Depends on 031 (deliveries), 024 (allocations), 020 (loads).

-- ─── Recipient-confirm + dispute-window columns on deliveries ───────────────
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS signer_name               TEXT;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS acknowledged_at           TIMESTAMPTZ;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS discrepancy_reason        TEXT;        -- NULL = none flagged
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS discrepancy_flagged_at    TIMESTAMPTZ;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS dispute_window_expires_at TIMESTAMPTZ; -- opens at confirm

-- ─── RPC: recipient confirms receipt (…-> delivered, opens the window) ──────
-- Keyed by the accepted allocation (the recipient holds its token). Captures
-- the signer + acknowledgment, marks the load delivered, and opens the dispute
-- window (p_expires_at, computed by the action). An optional discrepancy may be
-- flagged right here at confirm time.
CREATE OR REPLACE FUNCTION recipient_confirm_delivery(
  p_allocation_id     UUID,
  p_signer_name       TEXT,
  p_discrepancy_reason TEXT,
  p_expires_at        TIMESTAMPTZ,
  p_actor             UUID
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
  IF NULLIF(p_signer_name, '') IS NULL THEN
    RAISE EXCEPTION 'SIGNER_REQUIRED' USING HINT = 'a signer name is required to confirm receipt';
  END IF;

  SELECT * INTO v_delivery FROM public.deliveries WHERE allocation_id = p_allocation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_DELIVERY' USING HINT = 'no delivery record for this allocation';
  END IF;

  SELECT * INTO v_load FROM public.loads WHERE id = v_delivery.load_id FOR UPDATE;
  IF v_load.status NOT IN ('scheduled','picked_up','delivered') THEN
    RAISE EXCEPTION 'NOT_CONFIRMABLE' USING HINT = 'load is not awaiting a receipt confirmation';
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

-- ─── RPC: flag a discrepancy within the open dispute window ─────────────────
-- The recipient found an issue after confirming. Allowed only while the window
-- is open. Recorded, not refereed — it does not change the load's status.
CREATE OR REPLACE FUNCTION flag_delivery_discrepancy(
  p_allocation_id UUID,
  p_reason        TEXT,
  p_actor         UUID
) RETURNS deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery public.deliveries;
BEGIN
  IF NULLIF(p_reason, '') IS NULL THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING HINT = 'a reason is required to flag a discrepancy';
  END IF;

  SELECT * INTO v_delivery FROM public.deliveries WHERE allocation_id = p_allocation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_DELIVERY' USING HINT = 'no delivery record for this allocation';
  END IF;
  -- Lock the load so a concurrent close_delivery_window serializes with this.
  PERFORM 1 FROM public.loads WHERE id = v_delivery.load_id FOR UPDATE;

  IF v_delivery.dispute_window_expires_at IS NULL OR v_delivery.dispute_window_expires_at <= NOW() THEN
    RAISE EXCEPTION 'WINDOW_CLOSED' USING HINT = 'the dispute window is closed';
  END IF;

  UPDATE public.deliveries
    SET discrepancy_reason = p_reason, discrepancy_flagged_at = NOW()
    WHERE allocation_id = p_allocation_id
    RETURNING * INTO v_delivery;

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('load', v_delivery.load_id, 'delivery_discrepancy_flagged', p_actor, 'recipient',
          jsonb_build_object('allocation_id', p_allocation_id));

  RETURN v_delivery;
END;
$$;

REVOKE EXECUTE ON FUNCTION flag_delivery_discrepancy(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;

-- ─── RPC: close the dispute window (delivered -> closed) ────────────────────
-- Called by the Inngest dispute-window function when the window elapses. Closes
-- regardless of any recorded discrepancy — v3 records, does not referee.
CREATE OR REPLACE FUNCTION close_delivery_window(
  p_load_id UUID,
  p_actor   UUID
) RETURNS loads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_load public.loads;
BEGIN
  UPDATE public.loads SET status = 'closed'
    WHERE id = p_load_id AND status = 'delivered'
    RETURNING * INTO v_load;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_CLOSABLE' USING HINT = 'load is not in the delivered state';
  END IF;

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('load', p_load_id, 'delivery_closed', p_actor, 'system', '{}'::jsonb);

  RETURN v_load;
END;
$$;

REVOKE EXECUTE ON FUNCTION close_delivery_window(UUID, UUID) FROM PUBLIC, anon, authenticated;
