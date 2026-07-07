-- 013_merge_reconciliation.sql (renamed from 011 alongside the
-- 009_security_hardening → 012 rename; must always apply after 012)
-- Reconciles the two parallel hardening passes (012_security_hardening.sql and
-- 010_feedback_guards.sql) after merging branches. Run after 001–012.

-- ─── FIX 1: revert_listing_to_live lost its EXECUTE revoke ────────────────────
-- 010 dropped revert_listing_to_live(UUID) and created (UUID, TEXT). A DROP +
-- CREATE resets privileges to the default (EXECUTE granted to PUBLIC), which
-- silently undid the client-execution revoke from 009 — any authenticated user
-- could flip a purchased listing back to 'live' via PostgREST. Re-revoke.
REVOKE EXECUTE ON FUNCTION revert_listing_to_live(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ─── FIX 2: consolidated submit_feedback ──────────────────────────────────────
-- 009 and 010 each replaced submit_feedback with overlapping-but-different
-- guards and error codes. This is the union, using 010's error names (the
-- client maps these): ownership+status lock (010), dispute window (both),
-- duplicate-feedback guard (009 — without it a second submission hits the
-- uniq_feedback_events_order index and surfaces as an opaque SERVER_ERROR).
-- CREATE OR REPLACE preserves the EXECUTE revoke from 009.
CREATE OR REPLACE FUNCTION submit_feedback(
  p_order_id     UUID,
  p_consumer_id  UUID,
  p_outcome      TEXT,
  p_photo_url    TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
  v_order orders;
BEGIN
  IF p_outcome NOT IN ('positive', 'issue_reported', 'implicit_accept') THEN
    RAISE EXCEPTION 'INVALID_OUTCOME'
      USING HINT = 'outcome must be positive, issue_reported, or implicit_accept';
  END IF;

  IF p_outcome = 'issue_reported' AND p_photo_url IS NULL THEN
    RAISE EXCEPTION 'PHOTO_REQUIRED'
      USING HINT = 'A photo is required when reporting an issue';
  END IF;

  -- Ownership + status guard. Lock the row so a concurrent dispute-window
  -- payout job and a dispute cannot interleave.
  SELECT * INTO v_order
  FROM orders
  WHERE id = p_order_id
    AND consumer_id = p_consumer_id
    AND status = 'delivered'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND_OR_NOT_DELIVERED'
      USING HINT = 'Order must exist, belong to this consumer, and be in delivered status';
  END IF;

  -- Disputes are only valid inside the 2-hour window (TRD §2.12 / PRD §8.3).
  IF p_outcome = 'issue_reported'
     AND (v_order.dispute_window_expires_at IS NULL
          OR v_order.dispute_window_expires_at <= NOW()) THEN
    RAISE EXCEPTION 'DISPUTE_WINDOW_EXPIRED'
      USING HINT = 'Issues must be reported within 2 hours of delivery';
  END IF;

  -- One feedback record per order (positive confirmations included)
  IF EXISTS (SELECT 1 FROM feedback_events WHERE order_id = p_order_id) THEN
    RAISE EXCEPTION 'FEEDBACK_ALREADY_SUBMITTED'
      USING HINT = 'Feedback was already recorded for this order';
  END IF;

  INSERT INTO feedback_events (order_id, consumer_id, outcome, photo_url)
  VALUES (p_order_id, p_consumer_id, p_outcome, p_photo_url);

  IF p_outcome = 'issue_reported' THEN
    UPDATE orders
    SET status = 'disputed'
    WHERE id = p_order_id;

    INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
    VALUES (
      'order', p_order_id, 'disputed', p_consumer_id, 'consumer',
      jsonb_build_object(
        'outcome', p_outcome,
        'photo_url', p_photo_url
      )
    );
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
REVOKE EXECUTE ON FUNCTION submit_feedback(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
