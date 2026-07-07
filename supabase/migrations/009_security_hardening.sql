-- 009_security_hardening.sql
-- Security + correctness fixes from the 2026-07-06 pre-showcase audit.
-- Run after 001–008.

-- ─── FIX 1: privilege escalation via users_update_own ─────────────────────────
-- The RLS policy allows a user to UPDATE their own row with no column
-- restrictions, so anyone could `SET role='admin'` (or phone_verified=true)
-- through PostgREST. Block privileged-column changes unless the request comes
-- from the service role (server actions) or a direct DB admin session.
CREATE OR REPLACE FUNCTION prevent_user_privilege_change()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW.role           IS DISTINCT FROM OLD.role OR
    NEW.phone_verified IS DISTINCT FROM OLD.phone_verified OR
    NEW.email          IS DISTINCT FROM OLD.email
  )
  AND COALESCE(auth.role(), 'postgres') NOT IN ('service_role', 'postgres', 'supabase_admin')
  THEN
    RAISE EXCEPTION 'PRIVILEGE_CHANGE_FORBIDDEN'
      USING HINT = 'role/phone_verified/email can only be changed server-side';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_privilege_lock ON users;
CREATE TRIGGER users_privilege_lock
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION prevent_user_privilege_change();

-- ─── FIX 2: lock down SECURITY DEFINER RPCs ───────────────────────────────────
-- All state-transition RPCs run as their owner (bypassing RLS) and trusted the
-- p_consumer_id/p_courier_id arguments, while remaining executable by ANY
-- authenticated user via PostgREST — i.e. anyone could claim listings, confirm
-- deliveries, or move other couriers' GPS pins. The server always calls these
-- with the service-role key, so client execution is simply revoked.
REVOKE EXECUTE ON FUNCTION claim_listing(UUID, UUID, TEXT)                         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION confirm_delivery(UUID, UUID)                            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION accept_dispatch(UUID, UUID, UUID)                       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION publish_listing(UUID, UUID, BOOLEAN)                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION hide_expired_listing(UUID)                              FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION revert_listing_to_live(UUID)                            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION create_draft_listing(UUID, TEXT, NUMERIC, NUMERIC, BOOLEAN, TEXT, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_nearest_couriers(FLOAT8, FLOAT8, BOOLEAN, FLOAT8, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION submit_feedback(UUID, UUID, TEXT, TEXT)                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION update_courier_location(UUID, FLOAT8, FLOAT8)           FROM PUBLIC, anon, authenticated;

-- Remove the superseded 2-arg publish_listing from 004 (007 added the 3-arg one)
DROP FUNCTION IF EXISTS publish_listing(UUID, UUID);

-- ─── FIX 3: donors could edit LIVE listings ───────────────────────────────────
-- The old policy allowed updates while status IN ('draft','live'), letting a
-- donor rewrite safety_expires_at / temperature_sensitive on a live listing and
-- defeat the food-safety window (PRD §9.3: not overridable by any role).
DROP POLICY IF EXISTS "donors_update_own_listings" ON listings;
CREATE POLICY "donors_update_own_listings" ON listings
  FOR UPDATE TO authenticated
  USING (
    donor_id = auth.uid()
    AND status = 'draft'
  );

-- ─── FIX 4: claim_listing must reject safety-expired listings ─────────────────
-- The 5-minute cold-chain sweep leaves a window where an expired listing is
-- still 'live'; the claim itself must be the hard backstop.
CREATE OR REPLACE FUNCTION claim_listing(
  p_listing_id            UUID,
  p_consumer_id           UUID,
  p_stripe_payment_intent_id TEXT
) RETURNS orders AS $$
DECLARE
  v_listing listings;
  v_order   orders;
BEGIN
  SELECT * INTO v_listing
  FROM listings
  WHERE id = p_listing_id
    AND status = 'live'
    AND (safety_expires_at IS NULL OR safety_expires_at > NOW())
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LISTING_UNAVAILABLE'
      USING HINT = 'Listing already purchased, expired, or unavailable';
  END IF;

  UPDATE listings
  SET status = 'purchased', purchased_at = NOW()
  WHERE id = p_listing_id;

  INSERT INTO orders (
    listing_id, consumer_id, stripe_payment_intent_id,
    status, dispute_window_expires_at
  )
  VALUES (
    p_listing_id, p_consumer_id, p_stripe_payment_intent_id,
    'pending_dispatch', NULL
  )
  RETURNING * INTO v_order;

  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES (
    'listing', p_listing_id, 'purchased', p_consumer_id, 'consumer',
    jsonb_build_object(
      'order_id', v_order.id,
      'payment_intent', p_stripe_payment_intent_id,
      'from_status', 'live',
      'to_status', 'purchased'
    )
  );

  RETURN v_order;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
REVOKE EXECUTE ON FUNCTION claim_listing(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ─── FIX 5: accept_dispatch — validate the offer + block expired food ─────────
-- Old version updated dispatch_events unconditionally (any courier could mark
-- someone else's offer accepted), never enforced the 5-minute window
-- server-side, and would dispatch food past its safety expiry.
CREATE OR REPLACE FUNCTION accept_dispatch(
  p_order_id UUID,
  p_courier_id UUID,
  p_dispatch_event_id UUID
) RETURNS VOID AS $$
DECLARE
  v_listing_id UUID;
  v_expired BOOLEAN;
BEGIN
  -- Offer must belong to this courier + order, be unanswered, and be within
  -- the 5-minute window (60s grace for latency/clock skew)
  UPDATE dispatch_events
  SET responded_at = NOW(), response = 'accepted'
  WHERE id = p_dispatch_event_id
    AND courier_id = p_courier_id
    AND order_id = p_order_id
    AND response IS NULL
    AND offered_at > NOW() - INTERVAL '6 minutes';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DISPATCH_EVENT_INVALID'
      USING HINT = 'Offer expired, already answered, or not addressed to this courier';
  END IF;

  -- Assign courier to order atomically
  UPDATE orders
  SET courier_id = p_courier_id,
      status = 'dispatched'
  WHERE id = p_order_id
    AND status = 'pending_dispatch'
    AND courier_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_AVAILABLE_FOR_DISPATCH'
      USING HINT = 'Order may have been claimed by another courier or refunded';
  END IF;

  -- Update listing with status guard AND safety-expiry backstop
  UPDATE listings l
  SET status = 'dispatched', dispatched_at = NOW()
  FROM orders o
  WHERE o.id = p_order_id
    AND o.listing_id = l.id
    AND l.status = 'purchased'
    AND (l.safety_expires_at IS NULL OR l.safety_expires_at > NOW());

  IF NOT FOUND THEN
    SELECT (l.safety_expires_at IS NOT NULL AND l.safety_expires_at <= NOW())
    INTO v_expired
    FROM listings l JOIN orders o ON o.listing_id = l.id
    WHERE o.id = p_order_id;

    IF v_expired THEN
      RAISE EXCEPTION 'LISTING_SAFETY_EXPIRED'
        USING HINT = 'Food safety window closed before pickup';
    END IF;
    RAISE EXCEPTION 'LISTING_NOT_IN_EXPECTED_STATE'
      USING HINT = 'Listing may have been hidden since the order was created';
  END IF;

  SELECT listing_id INTO v_listing_id FROM orders WHERE id = p_order_id;

  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES (
    'order', p_order_id, 'dispatched', p_courier_id, 'courier',
    jsonb_build_object(
      'dispatch_event_id', p_dispatch_event_id,
      'listing_id', v_listing_id,
      'from_status', 'pending_dispatch',
      'to_status', 'dispatched'
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
REVOKE EXECUTE ON FUNCTION accept_dispatch(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;

-- ─── FIX 6: hide_expired_listing — live/purchased only, never dispatched ──────
-- Hiding a 'dispatched' listing bricked confirm_delivery for food already in
-- transit (courier could never complete, no payouts, no refund). In-transit
-- degradation is handled by rejection-at-door + the dispute flow instead.
CREATE OR REPLACE FUNCTION hide_expired_listing(
  p_listing_id UUID
) RETURNS VOID AS $$
DECLARE
  v_from_status TEXT;
BEGIN
  SELECT status INTO v_from_status
  FROM listings
  WHERE id = p_listing_id
    AND temperature_sensitive = TRUE
    AND status IN ('live', 'purchased')
    AND safety_expires_at IS NOT NULL
    AND safety_expires_at <= NOW();

  IF NOT FOUND THEN
    RETURN; -- Already hidden, dispatched, or not expired — idempotent
  END IF;

  UPDATE listings
  SET status = 'hidden'
  WHERE id = p_listing_id;

  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES (
    'listing', p_listing_id, 'safety_expired', NULL, 'system',
    jsonb_build_object(
      'from_status', v_from_status,
      'to_status', 'hidden',
      'triggered_by', 'cold_chain_check'
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
REVOKE EXECUTE ON FUNCTION hide_expired_listing(UUID) FROM PUBLIC, anon, authenticated;

-- ─── FIX 7: submit_feedback — enforce eligibility + the 2-hour window ─────────
-- Old version accepted disputes on any order in any state at any time (even
-- after the donor payout released), and allowed unlimited duplicate feedback.
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

  SELECT * INTO v_order
  FROM orders
  WHERE id = p_order_id AND consumer_id = p_consumer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  IF v_order.status <> 'delivered' THEN
    RAISE EXCEPTION 'ORDER_NOT_ELIGIBLE'
      USING HINT = 'Feedback is only accepted on delivered orders';
  END IF;

  -- Disputes must land inside the 2-hour window (PRD §7.5); positive
  -- confirmations are harmless later and remain accepted.
  IF p_outcome = 'issue_reported'
     AND (v_order.dispute_window_expires_at IS NULL OR v_order.dispute_window_expires_at < NOW()) THEN
    RAISE EXCEPTION 'DISPUTE_WINDOW_CLOSED'
      USING HINT = 'The 2-hour dispute window has passed';
  END IF;

  IF EXISTS (SELECT 1 FROM feedback_events WHERE order_id = p_order_id) THEN
    RAISE EXCEPTION 'FEEDBACK_ALREADY_SUBMITTED';
  END IF;

  INSERT INTO feedback_events (order_id, consumer_id, outcome, photo_url)
  VALUES (p_order_id, p_consumer_id, p_outcome, p_photo_url);

  IF p_outcome = 'issue_reported' THEN
    UPDATE orders
    SET status = 'disputed'
    WHERE id = p_order_id AND consumer_id = p_consumer_id;

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

-- One feedback record per order, enforced at the schema level too
CREATE UNIQUE INDEX IF NOT EXISTS uniq_feedback_events_order
  ON feedback_events (order_id);

-- ─── FIX 8: storage bucket ────────────────────────────────────────────────────
-- Bucket provisioning lives in 009_storage.sql (private bucket per TRD SH-3);
-- readers use short-lived signed URLs generated server-side.
