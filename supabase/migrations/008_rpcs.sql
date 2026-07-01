-- 008_rpcs.sql
-- Additional RPCs needed for Steps 6-11
-- Run after 001–007 migrations.

-- ─── claim_listing: atomic purchase with SELECT FOR UPDATE SKIP LOCKED ─────
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
  WHERE id = p_listing_id AND status = 'live'
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LISTING_UNAVAILABLE'
      USING HINT = 'Listing already purchased or unavailable';
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
      'payment_intent', p_stripe_payment_intent_id
    )
  );

  RETURN v_order;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── revert_listing_to_live: used on payment failure ─────────────────────────
CREATE OR REPLACE FUNCTION revert_listing_to_live(
  p_listing_id UUID
) RETURNS VOID AS $$
BEGIN
  UPDATE listings
  SET status = 'live', purchased_at = NULL
  WHERE id = p_listing_id AND status = 'purchased';

  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES (
    'listing', p_listing_id, 'purchase_reverted', NULL, 'system',
    jsonb_build_object('reason', 'payment_failed')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── create_draft_listing: insert a draft listing ────────────────────────────
CREATE OR REPLACE FUNCTION create_draft_listing(
  p_donor_id                   UUID,
  p_detected_item              TEXT,
  p_estimated_quantity_lbs     NUMERIC,
  p_confidence_score           NUMERIC,
  p_temperature_sensitive      BOOLEAN,
  p_usda_category              TEXT,
  p_image_url                  TEXT,
  p_base_commodity_price_cents INTEGER,
  p_suggested_donor_payout_cents INTEGER,
  p_donor_payout_cents         INTEGER,
  p_consumer_price_cents       INTEGER,
  p_platform_fee_cents         INTEGER,
  p_courier_fee_cents          INTEGER,
  p_handling_notes             TEXT DEFAULT NULL
) RETURNS listings AS $$
DECLARE
  v_listing listings;
BEGIN
  INSERT INTO listings (
    donor_id,
    detected_item,
    estimated_quantity_lbs,
    confidence_score,
    temperature_sensitive,
    usda_category,
    image_url,
    base_commodity_price_cents,
    suggested_donor_payout_cents,
    donor_payout_cents,
    consumer_price_cents,
    platform_fee_cents,
    courier_fee_cents,
    handling_notes,
    status
  )
  VALUES (
    p_donor_id,
    p_detected_item,
    p_estimated_quantity_lbs,
    p_confidence_score,
    p_temperature_sensitive,
    p_usda_category,
    p_image_url,
    p_base_commodity_price_cents,
    p_suggested_donor_payout_cents,
    p_donor_payout_cents,
    p_consumer_price_cents,
    p_platform_fee_cents,
    p_courier_fee_cents,
    p_handling_notes,
    'draft'
  )
  RETURNING * INTO v_listing;

  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES (
    'listing', v_listing.id, 'draft_created', p_donor_id, 'donor',
    jsonb_build_object(
      'detected_item', p_detected_item,
      'usda_category', p_usda_category,
      'consumer_price_cents', p_consumer_price_cents
    )
  );

  RETURN v_listing;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── get_nearest_couriers: PostGIS nearest courier query ─────────────────────
CREATE OR REPLACE FUNCTION get_nearest_couriers(
  p_donor_lat              FLOAT8,
  p_donor_lng              FLOAT8,
  p_requires_cold_chain    BOOLEAN DEFAULT FALSE,
  p_radius_meters          FLOAT8 DEFAULT 10000,
  p_limit                  INTEGER DEFAULT 5
) RETURNS TABLE (
  user_id         UUID,
  distance_meters FLOAT8,
  current_lat     FLOAT8,
  current_lng     FLOAT8
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    cp.user_id,
    ST_Distance(
      cp.current_location,
      ST_MakePoint(p_donor_lng, p_donor_lat)::geography
    ) AS distance_meters,
    cp.current_lat,
    cp.current_lng
  FROM courier_profiles cp
  JOIN users u ON u.id = cp.user_id
  WHERE
    cp.is_available = TRUE
    AND (p_requires_cold_chain = FALSE OR cp.insulated_transport_capable = TRUE)
    AND cp.current_location IS NOT NULL
    AND ST_DWithin(
      cp.current_location,
      ST_MakePoint(p_donor_lng, p_donor_lat)::geography,
      p_radius_meters
    )
  ORDER BY distance_meters ASC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── submit_feedback: insert feedback + optionally mark order disputed ────────
CREATE OR REPLACE FUNCTION submit_feedback(
  p_order_id     UUID,
  p_consumer_id  UUID,
  p_outcome      TEXT,
  p_photo_url    TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  IF p_outcome NOT IN ('positive', 'issue_reported', 'implicit_accept') THEN
    RAISE EXCEPTION 'INVALID_OUTCOME'
      USING HINT = 'outcome must be positive, issue_reported, or implicit_accept';
  END IF;

  IF p_outcome = 'issue_reported' AND p_photo_url IS NULL THEN
    RAISE EXCEPTION 'PHOTO_REQUIRED'
      USING HINT = 'A photo is required when reporting an issue';
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

-- ─── update_courier_location: update courier GPS position ────────────────────
CREATE OR REPLACE FUNCTION update_courier_location(
  p_courier_id UUID,
  p_lat        FLOAT8,
  p_lng        FLOAT8
) RETURNS VOID AS $$
BEGIN
  UPDATE courier_profiles
  SET
    current_lat = p_lat,
    current_lng = p_lng,
    current_location = ST_MakePoint(p_lng, p_lat)::geography,
    location_updated_at = NOW()
  WHERE user_id = p_courier_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
