-- 007_fixes.sql
-- Fixes identified by full codebase audit (2026-06-30)
-- Run this after 001–006 migrations.

-- ─── FIX 1: prevent_pricing_update — NULL-safe comparisons + missing field ────
-- Old trigger used != which evaluates to NULL when either side is NULL, allowing
-- a NULL assignment to bypass the lock. Also adds suggested_donor_payout_cents.
CREATE OR REPLACE FUNCTION prevent_pricing_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM 'draft' AND (
    NEW.donor_payout_cents          IS DISTINCT FROM OLD.donor_payout_cents OR
    NEW.consumer_price_cents        IS DISTINCT FROM OLD.consumer_price_cents OR
    NEW.platform_fee_cents          IS DISTINCT FROM OLD.platform_fee_cents OR
    NEW.courier_fee_cents           IS DISTINCT FROM OLD.courier_fee_cents OR
    NEW.base_commodity_price_cents  IS DISTINCT FROM OLD.base_commodity_price_cents OR
    NEW.suggested_donor_payout_cents IS DISTINCT FROM OLD.suggested_donor_payout_cents
  ) THEN
    RAISE EXCEPTION 'PRICING_LOCKED'
      USING HINT = 'Pricing fields cannot be modified after listing leaves draft status';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger (function is already replaced above)
DROP TRIGGER IF EXISTS listings_pricing_lock ON listings;
CREATE TRIGGER listings_pricing_lock
  BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION prevent_pricing_update();

-- ─── FIX 2: publish_listing — accept safety attestation as parameter ──────────
-- Old version required safety_attested = TRUE already set, making itself unreachable.
-- Now the call passes p_safety_attested; the function validates and sets it atomically.
CREATE OR REPLACE FUNCTION publish_listing(
  p_listing_id UUID,
  p_donor_id UUID,
  p_safety_attested BOOLEAN
) RETURNS VOID AS $$
BEGIN
  IF p_safety_attested IS NOT TRUE THEN
    RAISE EXCEPTION 'SAFETY_ATTESTATION_REQUIRED'
      USING HINT = 'Donor must confirm safety attestation before publishing';
  END IF;

  UPDATE listings
  SET status = 'live',
      published_at = NOW(),
      safety_attested = TRUE,
      safety_attested_at = NOW()
  WHERE id = p_listing_id
    AND donor_id = p_donor_id
    AND status = 'draft';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LISTING_NOT_PUBLISHABLE'
      USING HINT = 'Listing must be in draft status and owned by this donor';
  END IF;

  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES (
    'listing', p_listing_id, 'published', p_donor_id, 'donor',
    jsonb_build_object(
      'from_status', 'draft',
      'to_status', 'live',
      'published_at', NOW()
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── FIX 3: accept_dispatch — guard listing status to prevent silent no-op ───
-- Old version updated listings without checking its current status. If a cold-chain
-- job hid the listing between the orders UPDATE and the listings UPDATE, the listing
-- stayed hidden while the order was marked dispatched — diverged state, no error.
CREATE OR REPLACE FUNCTION accept_dispatch(
  p_order_id UUID,
  p_courier_id UUID,
  p_dispatch_event_id UUID
) RETURNS VOID AS $$
DECLARE
  v_listing_id UUID;
BEGIN
  -- Assign courier to order atomically
  UPDATE orders
  SET courier_id = p_courier_id,
      status = 'dispatched'
  WHERE id = p_order_id
    AND status = 'pending_dispatch'
    AND courier_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_AVAILABLE_FOR_DISPATCH'
      USING HINT = 'Order may have been claimed by another courier';
  END IF;

  UPDATE dispatch_events
  SET responded_at = NOW(), response = 'accepted'
  WHERE id = p_dispatch_event_id;

  -- Update listing with explicit status guard to catch cold-chain race
  UPDATE listings l
  SET status = 'dispatched', dispatched_at = NOW()
  FROM orders o
  WHERE o.id = p_order_id
    AND o.listing_id = l.id
    AND l.status = 'purchased';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LISTING_NOT_IN_EXPECTED_STATE'
      USING HINT = 'Listing may have been hidden by cold-chain job since order was created';
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

-- ─── FIX 4: confirm_delivery — add listing status guard ───────────────────────
-- Old version had a TOCTOU race: a cold-chain job could hide the listing between
-- the orders UPDATE and the listing UPDATE, leaving listing.status = 'hidden' while
-- order.status = 'delivered' with no error raised.
CREATE OR REPLACE FUNCTION confirm_delivery(
  p_order_id UUID,
  p_courier_id UUID
) RETURNS VOID AS $$
DECLARE
  v_now        TIMESTAMPTZ := NOW();
  v_listing_id UUID;
BEGIN
  -- Update order: dispatched → delivered + open dispute window
  UPDATE orders
  SET status = 'delivered',
      delivered_at = v_now,
      dispute_window_expires_at = v_now + INTERVAL '2 hours'
  WHERE id = p_order_id
    AND courier_id = p_courier_id
    AND status = 'dispatched';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND_OR_INVALID_STATE'
      USING HINT = 'Order must be in dispatched status and assigned to this courier';
  END IF;

  -- Fetch listing_id (order is now committed above)
  SELECT listing_id INTO v_listing_id FROM orders WHERE id = p_order_id;

  -- Update listing with explicit status guard
  UPDATE listings
  SET status = 'delivered', delivered_at = v_now
  WHERE id = v_listing_id
    AND status = 'dispatched';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LISTING_NOT_IN_DISPATCHED_STATE'
      USING HINT = 'Listing may have been hidden by cold-chain job during delivery';
  END IF;

  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES (
    'order', p_order_id, 'delivered', p_courier_id, 'courier',
    jsonb_build_object(
      'listing_id', v_listing_id,
      'delivered_at', v_now,
      'dispute_window_expires_at', v_now + INTERVAL '2 hours',
      'from_status', 'dispatched',
      'to_status', 'delivered'
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── FIX 5: hide_expired_listing — dynamic from_status in audit ───────────────
-- Old version hardcoded 'from_status': 'live' even though the WHERE clause allows
-- both 'live' and 'dispatched', producing a false audit record for dispatched listings.
CREATE OR REPLACE FUNCTION hide_expired_listing(
  p_listing_id UUID
) RETURNS VOID AS $$
DECLARE
  v_from_status TEXT;
BEGIN
  -- Capture actual status before hiding (ensures audit record is truthful)
  SELECT status INTO v_from_status
  FROM listings
  WHERE id = p_listing_id
    AND temperature_sensitive = TRUE
    AND status IN ('live', 'dispatched')
    AND safety_expires_at IS NOT NULL
    AND safety_expires_at <= NOW();

  IF NOT FOUND THEN
    RETURN; -- Already hidden, not expired, or not temperature-sensitive — idempotent
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

-- ─── FIX 6: feedback_events RLS — require order ownership ─────────────────────
-- Old policy only checked consumer_id = auth.uid(), allowing a consumer to submit
-- feedback for any order_id, including orders they did not place.
DROP POLICY IF EXISTS consumers_insert_feedback ON feedback_events;
CREATE POLICY consumers_insert_feedback ON feedback_events
  FOR INSERT TO authenticated
  WITH CHECK (
    consumer_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = feedback_events.order_id
        AND orders.consumer_id = auth.uid()
    )
  );
