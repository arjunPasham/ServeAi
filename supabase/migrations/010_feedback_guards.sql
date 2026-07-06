-- 010_feedback_guards.sql
-- Security review fixes for SECURITY DEFINER RPCs.
--
-- FIX 1: submit_feedback — enforce order ownership, delivered status, and the
--   2-hour dispute window server-side. Previously only the client UI hid the
--   feedback buttons after the window; the RPC accepted disputes at any time,
--   including after the donor payout had been released. It also allowed any
--   consumer to insert feedback_events rows against orders they did not own
--   (SECURITY DEFINER bypasses the RLS ownership policy from 007 FIX 6), and
--   those rows are immutable per 005.
--
-- FIX 2: revert_listing_to_live — only write the audit record when a listing
--   was actually reverted, and record the caller's reason instead of a
--   hardcoded 'payment_failed' (the no-courier refund path also calls this).

-- ─── FIX 1: submit_feedback with ownership + status + window guards ──────────
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

-- ─── FIX 2: revert_listing_to_live — truthful audit + caller-supplied reason ──
-- The new signature (UUID, TEXT) would OVERLOAD the old (UUID) version rather
-- than replace it, making PostgREST rpc() calls ambiguous — drop the old one.
DROP FUNCTION IF EXISTS revert_listing_to_live(UUID);

CREATE OR REPLACE FUNCTION revert_listing_to_live(
  p_listing_id UUID,
  p_reason     TEXT DEFAULT 'payment_failed'
) RETURNS VOID AS $$
DECLARE
  v_reverted BOOLEAN;
BEGIN
  UPDATE listings
  SET status = 'live', purchased_at = NULL
  WHERE id = p_listing_id AND status = 'purchased';

  v_reverted := FOUND;

  -- Only audit a revert that actually happened; a no-op call must not
  -- fabricate an immutable 'purchase_reverted' record.
  IF v_reverted THEN
    INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
    VALUES (
      'listing', p_listing_id, 'purchase_reverted', NULL, 'system',
      jsonb_build_object('reason', p_reason)
    );
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
