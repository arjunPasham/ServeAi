-- 004_rpc.sql
-- PostgreSQL RPC functions for FoodLink
-- These are the ONLY paths that may write listing/order status transitions.
-- Every function atomically writes to audit_log in the same transaction.

-- ─── ATOMIC LISTING CLAIM ───────────────────────────────────────────────────
-- Called by Next.js after Stripe payment is captured.
-- Uses SELECT FOR UPDATE SKIP LOCKED to prevent two consumers buying same listing.
-- Returns the created order row.
CREATE OR REPLACE FUNCTION claim_listing(
  p_listing_id UUID,
  p_consumer_id UUID,
  p_stripe_payment_intent_id TEXT
) RETURNS orders AS $$
DECLARE
  v_listing listings;
  v_order   orders;
BEGIN
  -- Atomic lock: skip if another transaction holds the row
  SELECT * INTO v_listing
  FROM listings
  WHERE id = p_listing_id AND status = 'live'
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LISTING_UNAVAILABLE'
      USING HINT = 'Listing already purchased or unavailable';
  END IF;

  -- Transition status: live → purchased
  UPDATE listings
  SET status = 'purchased', purchased_at = NOW()
  WHERE id = p_listing_id;

  -- Create purchase order
  INSERT INTO orders (
    listing_id, consumer_id, stripe_payment_intent_id,
    status, dispute_window_expires_at
  )
  VALUES (
    p_listing_id, p_consumer_id, p_stripe_payment_intent_id,
    'pending_dispatch', NULL
  )
  RETURNING * INTO v_order;

  -- Immutable audit record (no PII in payload)
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

-- ─── DELIVERY CONFIRMATION ───────────────────────────────────────────────────
-- Called by Next.js after courier taps "Confirm Delivery".
-- Sets dispute_window_expires_at = NOW() + 2 hours.
-- Inngest dispute-window function listens for the delivery/confirmed event
-- fired by Next.js after this RPC returns.
CREATE OR REPLACE FUNCTION confirm_delivery(
  p_order_id UUID,
  p_courier_id UUID
) RETURNS VOID AS $$
DECLARE
  v_now       TIMESTAMPTZ := NOW();
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

  -- Update listing: dispatched → delivered
  UPDATE listings
  SET status = 'delivered', delivered_at = v_now
  WHERE id = (SELECT listing_id FROM orders WHERE id = p_order_id)
  RETURNING id INTO v_listing_id;

  -- Immutable audit record
  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES (
    'order', p_order_id, 'delivered', p_courier_id, 'courier',
    jsonb_build_object(
      'delivered_at', v_now,
      'dispute_window_expires_at', v_now + INTERVAL '2 hours',
      'from_status', 'dispatched',
      'to_status', 'delivered'
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── ACCEPT COURIER DISPATCH ─────────────────────────────────────────────────
-- Called by Next.js when courier taps Accept on dispatch notification.
-- Transitions order: pending_dispatch → dispatched.
CREATE OR REPLACE FUNCTION accept_dispatch(
  p_order_id UUID,
  p_courier_id UUID,
  p_dispatch_event_id UUID
) RETURNS VOID AS $$
DECLARE
  v_listing_id UUID;
BEGIN
  -- Assign courier to order
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

  -- Mark dispatch event as accepted
  UPDATE dispatch_events
  SET responded_at = NOW(), response = 'accepted'
  WHERE id = p_dispatch_event_id;

  -- Update listing status: purchased → dispatched
  UPDATE listings l
  SET status = 'dispatched', dispatched_at = NOW()
  FROM orders o
  WHERE o.id = p_order_id AND o.listing_id = l.id
  RETURNING l.id INTO v_listing_id;

  -- Audit
  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES (
    'order', p_order_id, 'dispatched', p_courier_id, 'courier',
    jsonb_build_object(
      'dispatch_event_id', p_dispatch_event_id,
      'from_status', 'pending_dispatch',
      'to_status', 'dispatched'
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── PUBLISH LISTING ─────────────────────────────────────────────────────────
-- Called by Next.js after donor confirms safety attestation.
-- Locks in pricing — donor_payout_cents and consumer_price_cents cannot change after this.
CREATE OR REPLACE FUNCTION publish_listing(
  p_listing_id UUID,
  p_donor_id UUID
) RETURNS VOID AS $$
BEGIN
  UPDATE listings
  SET status = 'live',
      published_at = NOW(),
      safety_attested = TRUE,
      safety_attested_at = NOW()
  WHERE id = p_listing_id
    AND donor_id = p_donor_id
    AND status = 'draft'
    AND safety_attested = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LISTING_NOT_PUBLISHABLE'
      USING HINT = 'Listing must be in draft status, owned by donor, and safety attested';
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

-- ─── HIDE EXPIRED LISTING (called by Inngest cold-chain job) ────────────────
-- Inngest cold-chain-check cron calls this via Supabase service_role client.
-- Transitions live/dispatched temperature-sensitive listings to hidden.
CREATE OR REPLACE FUNCTION hide_expired_listing(
  p_listing_id UUID
) RETURNS VOID AS $$
BEGIN
  UPDATE listings
  SET status = 'hidden'
  WHERE id = p_listing_id
    AND temperature_sensitive = TRUE
    AND status IN ('live', 'dispatched')
    AND safety_expires_at IS NOT NULL
    AND safety_expires_at <= NOW();

  IF NOT FOUND THEN
    RETURN; -- Already hidden or not expired — idempotent, not an error
  END IF;

  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES (
    'listing', p_listing_id, 'safety_expired', NULL, 'system',
    jsonb_build_object(
      'from_status', 'live',
      'to_status', 'hidden',
      'triggered_by', 'cold_chain_check'
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
