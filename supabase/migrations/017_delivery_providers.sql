-- 017_delivery_providers.sql
-- Phase 3: delivery model overhaul — third-party delivery (Uber Direct) +
-- consumer self-pickup replace the internal courier fleet (which stays in the
-- schema, gated off by DELIVERY_MODE).

-- ─── ORDERS: fulfillment + provider tracking ───────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_method TEXT NOT NULL DEFAULT 'delivery'
  CHECK (fulfillment_method IN ('delivery','pickup'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_provider     TEXT;    -- 'uber' | 'simulated' (null = internal courier / pickup)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_external_id  TEXT;    -- provider's delivery id
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee_cents    INTEGER; -- quoted fee passed through to the consumer at cost
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_tracking_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_status       TEXT     -- provider-normalized granular status
  CHECK (delivery_status IS NULL OR delivery_status IN
         ('pending','courier_assigned','picked_up','delivered','canceled','returned'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_code           TEXT;    -- short code consumer shows the donor

CREATE INDEX IF NOT EXISTS idx_orders_delivery_external_id
  ON orders (delivery_external_id) WHERE delivery_external_id IS NOT NULL;
-- The reconciler scans non-terminal delivery orders
CREATE INDEX IF NOT EXISTS idx_orders_active_provider_deliveries
  ON orders (created_at)
  WHERE delivery_external_id IS NOT NULL AND status IN ('pending_dispatch','dispatched');

-- ─── PROFILES: real-validator flag (Uber requires real validated addresses;
--     Smarty dev mode synthesizes Detroit coords that must never reach Uber) ─
ALTER TABLE donor_profiles    ADD COLUMN IF NOT EXISTS address_validated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE consumer_profiles ADD COLUMN IF NOT EXISTS address_validated BOOLEAN NOT NULL DEFAULT FALSE;

-- ─── RPC: provider delivery confirmation (system path — no courier) ────────
-- Mirrors confirm_delivery's atomic transition + audit, minus the courier
-- ownership guard: the caller is the Uber webhook / reconciler (service role).
CREATE OR REPLACE FUNCTION confirm_provider_delivery(
  p_order_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now        TIMESTAMPTZ := NOW();
  v_listing_id UUID;
BEGIN
  UPDATE public.orders
  SET status = 'delivered',
      delivered_at = v_now,
      dispute_window_expires_at = v_now + INTERVAL '2 hours'
  WHERE id = p_order_id
    AND fulfillment_method = 'delivery'
    AND delivery_external_id IS NOT NULL
    AND status IN ('pending_dispatch','dispatched');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND_OR_INVALID_STATE'
      USING HINT = 'Order must be an active provider delivery';
  END IF;

  SELECT listing_id INTO v_listing_id FROM public.orders WHERE id = p_order_id;

  UPDATE public.listings
  SET status = 'delivered', delivered_at = v_now
  WHERE id = v_listing_id
    AND status IN ('purchased','dispatched');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LISTING_NOT_IN_DISPATCHED_STATE'
      USING HINT = 'Listing may have been hidden by cold-chain job during delivery';
  END IF;

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES (
    'order', p_order_id, 'delivered', NULL, 'system',
    jsonb_build_object(
      'listing_id', v_listing_id,
      'delivered_at', v_now,
      'dispute_window_expires_at', v_now + INTERVAL '2 hours',
      'via', 'delivery_provider'
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION confirm_provider_delivery(UUID) FROM PUBLIC, anon, authenticated;

-- ─── RPC: self-pickup handoff confirmation (donor path) ────────────────────
-- The consumer shows their pickup_code; the donor confirms in their dashboard.
-- Fires the same 'delivered' state the courier/provider paths produce, so the
-- dispute-window and feedback pipelines are untouched.
CREATE OR REPLACE FUNCTION confirm_pickup(
  p_order_id    UUID,
  p_donor_id    UUID,
  p_pickup_code TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now        TIMESTAMPTZ := NOW();
  v_listing_id UUID;
BEGIN
  SELECT o.listing_id INTO v_listing_id
  FROM public.orders o
  JOIN public.listings l ON l.id = o.listing_id
  WHERE o.id = p_order_id
    AND l.donor_id = p_donor_id
    AND o.fulfillment_method = 'pickup'
    AND o.status = 'pending_dispatch'
    AND o.pickup_code = upper(trim(p_pickup_code));

  IF v_listing_id IS NULL THEN
    RAISE EXCEPTION 'PICKUP_NOT_CONFIRMABLE'
      USING HINT = 'Wrong code, wrong donor, or order not awaiting pickup';
  END IF;

  UPDATE public.orders
  SET status = 'delivered',
      delivered_at = v_now,
      dispute_window_expires_at = v_now + INTERVAL '2 hours'
  WHERE id = p_order_id
    AND status = 'pending_dispatch';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND_OR_INVALID_STATE';
  END IF;

  UPDATE public.listings
  SET status = 'delivered', delivered_at = v_now
  WHERE id = v_listing_id
    AND status = 'purchased';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LISTING_NOT_IN_DISPATCHED_STATE'
      USING HINT = 'Listing may have been hidden by cold-chain job before pickup';
  END IF;

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES (
    'order', p_order_id, 'delivered', p_donor_id, 'donor',
    jsonb_build_object(
      'listing_id', v_listing_id,
      'delivered_at', v_now,
      'dispute_window_expires_at', v_now + INTERVAL '2 hours',
      'via', 'self_pickup'
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION confirm_pickup(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
