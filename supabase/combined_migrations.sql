-- ==========================================================================
-- FoodLink combined migration script
-- Generated for one-paste execution in the Supabase SQL editor.
-- Runs 001 through 013 (no 011 by design) plus seed.sql, in order.
-- ==========================================================================

-- ============================================================
-- FILE: migrations/001_extensions.sql
-- ============================================================
-- 001_extensions.sql
-- Enable required PostgreSQL extensions
-- Run this first — other migrations depend on uuid_generate_v4() and PostGIS types

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- pg_cron requires Supabase Pro plan and must be enabled via:
-- Dashboard → Database → Extensions → pg_cron → Enable
-- Then uncomment:
-- CREATE EXTENSION IF NOT EXISTS "pg_cron";


-- ============================================================
-- FILE: migrations/002_schema.sql
-- ============================================================
-- 002_schema.sql
-- Core table definitions for FoodLink
-- All 10 tables in dependency order (no forward FK references)
-- Idempotent: safe to replay on an existing database (Supabase Preview CI requirement)

-- ─── HELPER: auto-update updated_at ────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── USERS ──────────────────────────────────────────────────────────────────
-- Mirrors auth.users (managed by Supabase Auth). id = auth.uid().
-- A trigger (below) auto-inserts this row when auth.users is created.
CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email          TEXT UNIQUE NOT NULL,
  phone          TEXT UNIQUE,
  phone_verified BOOLEAN DEFAULT FALSE,
  role           TEXT NOT NULL CHECK (role IN ('donor','consumer','courier','admin')),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-create public.users row when Supabase Auth creates a new user.
-- Role defaults to 'consumer' — registration flow updates it on first login.
CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO users (id, email, role)
  VALUES (NEW.id, NEW.email, 'consumer')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();

-- ─── USDA COMMODITY PRICES ──────────────────────────────────────────────────
-- Manually maintained in MVP; reviewed every 4 weeks (PRD §7.2.1).
-- Categories with updated_at > 60 days block listing creation.
CREATE TABLE IF NOT EXISTS usda_commodity_prices (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category                TEXT NOT NULL UNIQUE,
  price_per_lb            NUMERIC(10,4) NOT NULL,
  retail_benchmark_per_lb NUMERIC(10,4) NOT NULL,
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_by              UUID REFERENCES users(id)
);

-- ─── DONOR PROFILES ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS donor_profiles (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  type               TEXT NOT NULL CHECK (type IN ('commercial','residential')),
  business_name      TEXT,
  license_number     TEXT,
  license_verified   BOOLEAN DEFAULT FALSE,
  address            TEXT NOT NULL,
  address_lat        FLOAT8,
  address_lng        FLOAT8,
  location           GEOGRAPHY(POINT,4326),
  cancellation_count INTEGER DEFAULT 0,
  account_review     BOOLEAN DEFAULT FALSE
);

-- ─── CONSUMER PROFILES ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumer_profiles (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('shelter','household')),
  organization_name TEXT,
  delivery_address  TEXT NOT NULL,
  delivery_lat      FLOAT8,
  delivery_lng      FLOAT8,
  location          GEOGRAPHY(POINT,4326),
  receiving_window  JSONB NOT NULL   -- [{day:"Mon",start:"09:00",end:"17:00"}]
);

-- ─── COURIER PROFILES ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS courier_profiles (
  user_id                     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  is_available                BOOLEAN DEFAULT FALSE,
  current_lat                 FLOAT8,
  current_lng                 FLOAT8,
  current_location            GEOGRAPHY(POINT,4326),
  insulated_transport_capable BOOLEAN DEFAULT FALSE,
  stripe_account_id           TEXT,
  location_updated_at         TIMESTAMPTZ
);

-- Sync current_location geography when lat/lng are updated
CREATE OR REPLACE FUNCTION sync_courier_location()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.current_lat IS NOT NULL AND NEW.current_lng IS NOT NULL THEN
    NEW.current_location = ST_SetSRID(ST_MakePoint(NEW.current_lng, NEW.current_lat), 4326)::geography;
    NEW.location_updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS courier_location_sync ON courier_profiles;
CREATE TRIGGER courier_location_sync
  BEFORE INSERT OR UPDATE OF current_lat, current_lng ON courier_profiles
  FOR EACH ROW EXECUTE FUNCTION sync_courier_location();

-- Sync donor geography
CREATE OR REPLACE FUNCTION sync_donor_location()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.address_lat IS NOT NULL AND NEW.address_lng IS NOT NULL THEN
    NEW.location = ST_SetSRID(ST_MakePoint(NEW.address_lng, NEW.address_lat), 4326)::geography;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS donor_location_sync ON donor_profiles;
CREATE TRIGGER donor_location_sync
  BEFORE INSERT OR UPDATE OF address_lat, address_lng ON donor_profiles
  FOR EACH ROW EXECUTE FUNCTION sync_donor_location();

-- Sync consumer geography
CREATE OR REPLACE FUNCTION sync_consumer_location()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.delivery_lat IS NOT NULL AND NEW.delivery_lng IS NOT NULL THEN
    NEW.location = ST_SetSRID(ST_MakePoint(NEW.delivery_lng, NEW.delivery_lat), 4326)::geography;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS consumer_location_sync ON consumer_profiles;
CREATE TRIGGER consumer_location_sync
  BEFORE INSERT OR UPDATE OF delivery_lat, delivery_lng ON consumer_profiles
  FOR EACH ROW EXECUTE FUNCTION sync_consumer_location();

-- ─── LISTINGS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listings (
  id                           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  donor_id                     UUID NOT NULL REFERENCES users(id),
  status                       TEXT NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','live','purchased',
                                                 'dispatched','delivered',
                                                 'disputed','hidden','cancelled')),
  -- AI scan results
  detected_item                TEXT NOT NULL,
  estimated_quantity_lbs       NUMERIC(8,2) NOT NULL,
  confidence_score             NUMERIC(4,3) NOT NULL,
  temperature_sensitive        BOOLEAN NOT NULL DEFAULT FALSE,
  usda_category                TEXT REFERENCES usda_commodity_prices(category),
  prepared_at                  TIMESTAMPTZ,
  safety_expires_at            TIMESTAMPTZ,
  -- pricing (USD cents — never written by n8n)
  base_commodity_price_cents   INTEGER NOT NULL,
  suggested_donor_payout_cents INTEGER NOT NULL,
  donor_payout_cents           INTEGER NOT NULL,
  consumer_price_cents         INTEGER NOT NULL,
  platform_fee_cents           INTEGER NOT NULL,
  courier_fee_cents            INTEGER NOT NULL,
  -- legal
  safety_attested              BOOLEAN NOT NULL DEFAULT FALSE,
  safety_attested_at           TIMESTAMPTZ,
  -- logistics
  image_url                    TEXT NOT NULL,
  handling_notes               TEXT,
  -- timestamps
  created_at                   TIMESTAMPTZ DEFAULT NOW(),
  published_at                 TIMESTAMPTZ,
  purchased_at                 TIMESTAMPTZ,
  dispatched_at                TIMESTAMPTZ,
  delivered_at                 TIMESTAMPTZ
);

-- ─── ORDERS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id                UUID NOT NULL REFERENCES listings(id),
  consumer_id               UUID NOT NULL REFERENCES users(id),
  courier_id                UUID REFERENCES users(id),
  stripe_payment_intent_id  TEXT NOT NULL,
  stripe_charge_id          TEXT,
  donor_transfer_id         TEXT,
  courier_transfer_id       TEXT,
  status                    TEXT NOT NULL DEFAULT 'pending_dispatch'
                            CHECK (status IN ('pending_dispatch','dispatched',
                                              'delivered','refunded','disputed')),
  dispatch_attempts         INTEGER DEFAULT 0,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  delivered_at              TIMESTAMPTZ,
  dispute_window_expires_at TIMESTAMPTZ
);

-- ─── DISPATCH EVENTS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dispatch_events (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id     UUID NOT NULL REFERENCES orders(id),
  courier_id   UUID NOT NULL REFERENCES users(id),
  offered_at   TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  response     TEXT CHECK (response IN ('accepted','declined','timeout'))
);

-- ─── FEEDBACK EVENTS ────────────────────────────────────────────────────────
-- FIX: photo_url added per TRD fix — required when outcome = 'issue_reported' (PRD §8.3)
CREATE TABLE IF NOT EXISTS feedback_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID NOT NULL REFERENCES orders(id),
  consumer_id UUID NOT NULL REFERENCES users(id),
  outcome     TEXT NOT NULL CHECK (outcome IN ('positive','issue_reported','implicit_accept')),
  photo_url   TEXT,   -- required when outcome = 'issue_reported'; null otherwise
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── AUDIT LOG ──────────────────────────────────────────────────────────────
-- Append-only. UPDATE and DELETE revoked in 005_audit.sql.
-- Every status transition must write here atomically via PostgreSQL RPCs.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   UUID NOT NULL,
  event_type  TEXT NOT NULL,
  actor_id    UUID,
  actor_role  TEXT,
  payload     JSONB NOT NULL,   -- NEVER contains raw PII (addresses, names, contact)
  created_at  TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================
-- FILE: migrations/003_rls.sql
-- ============================================================
-- 003_rls.sql
-- Row Level Security policies for FoodLink
-- service_role key bypasses all RLS — use only in server-side code

-- ─── USERS ──────────────────────────────────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_select_own" ON users;
CREATE POLICY "users_select_own" ON users
  FOR SELECT TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS "users_update_own" ON users;
CREATE POLICY "users_update_own" ON users
  FOR UPDATE TO authenticated
  USING (id = auth.uid());

-- ─── DONOR PROFILES ─────────────────────────────────────────────────────────
ALTER TABLE donor_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "donor_profiles_select_own" ON donor_profiles;
CREATE POLICY "donor_profiles_select_own" ON donor_profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "donor_profiles_insert_own" ON donor_profiles;
CREATE POLICY "donor_profiles_insert_own" ON donor_profiles
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "donor_profiles_update_own" ON donor_profiles;
CREATE POLICY "donor_profiles_update_own" ON donor_profiles
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid());

-- ─── CONSUMER PROFILES ──────────────────────────────────────────────────────
ALTER TABLE consumer_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "consumer_profiles_select_own" ON consumer_profiles;
CREATE POLICY "consumer_profiles_select_own" ON consumer_profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "consumer_profiles_insert_own" ON consumer_profiles;
CREATE POLICY "consumer_profiles_insert_own" ON consumer_profiles
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "consumer_profiles_update_own" ON consumer_profiles;
CREATE POLICY "consumer_profiles_update_own" ON consumer_profiles
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid());

-- ─── COURIER PROFILES ───────────────────────────────────────────────────────
ALTER TABLE courier_profiles ENABLE ROW LEVEL SECURITY;

-- Couriers see their own profile only (location is sensitive)
DROP POLICY IF EXISTS "courier_location_service_only" ON courier_profiles;
CREATE POLICY "courier_location_service_only" ON courier_profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "courier_profiles_insert_own" ON courier_profiles;
CREATE POLICY "courier_profiles_insert_own" ON courier_profiles
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "courier_profiles_update_own" ON courier_profiles;
CREATE POLICY "courier_profiles_update_own" ON courier_profiles
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid());

-- ─── USDA COMMODITY PRICES ──────────────────────────────────────────────────
ALTER TABLE usda_commodity_prices ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read prices (needed for pricing engine)
DROP POLICY IF EXISTS "usda_prices_select_all" ON usda_commodity_prices;
CREATE POLICY "usda_prices_select_all" ON usda_commodity_prices
  FOR SELECT TO authenticated
  USING (true);

-- Only admins can insert/update (enforced in application layer + here)
DROP POLICY IF EXISTS "usda_prices_admin_write" ON usda_commodity_prices;
CREATE POLICY "usda_prices_admin_write" ON usda_commodity_prices
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin')
  );

-- ─── LISTINGS ───────────────────────────────────────────────────────────────
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;

-- Consumers see live listings only
DROP POLICY IF EXISTS "consumers_see_live_listings" ON listings;
CREATE POLICY "consumers_see_live_listings" ON listings
  FOR SELECT TO authenticated
  USING (
    status = 'live'
    AND EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'consumer')
  );

-- Donors see their own listings (all statuses)
DROP POLICY IF EXISTS "donors_see_own_listings" ON listings;
CREATE POLICY "donors_see_own_listings" ON listings
  FOR SELECT TO authenticated
  USING (donor_id = auth.uid());

-- Couriers see listings tied to their active orders
DROP POLICY IF EXISTS "couriers_see_dispatched_listings" ON listings;
CREATE POLICY "couriers_see_dispatched_listings" ON listings
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.listing_id = listings.id
        AND orders.courier_id = auth.uid()
        AND orders.status IN ('dispatched','delivered')
    )
  );

-- Donors can insert drafts
DROP POLICY IF EXISTS "donors_insert_listings" ON listings;
CREATE POLICY "donors_insert_listings" ON listings
  FOR INSERT TO authenticated
  WITH CHECK (
    donor_id = auth.uid()
    AND EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'donor')
  );

-- Donors can update their own draft/live listings (not after purchase)
DROP POLICY IF EXISTS "donors_update_own_listings" ON listings;
CREATE POLICY "donors_update_own_listings" ON listings
  FOR UPDATE TO authenticated
  USING (
    donor_id = auth.uid()
    AND status IN ('draft','live')
  );

-- Admins see everything
DROP POLICY IF EXISTS "admin_all_listings" ON listings;
CREATE POLICY "admin_all_listings" ON listings
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin')
  );

-- ─── ORDERS ─────────────────────────────────────────────────────────────────
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Consumers see their own orders
DROP POLICY IF EXISTS "consumers_see_own_orders" ON orders;
CREATE POLICY "consumers_see_own_orders" ON orders
  FOR SELECT TO authenticated
  USING (consumer_id = auth.uid());

-- Couriers see their assigned orders
DROP POLICY IF EXISTS "couriers_see_assigned_orders" ON orders;
CREATE POLICY "couriers_see_assigned_orders" ON orders
  FOR SELECT TO authenticated
  USING (courier_id = auth.uid());

-- Donors see orders for their listings
DROP POLICY IF EXISTS "donors_see_listing_orders" ON orders;
CREATE POLICY "donors_see_listing_orders" ON orders
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM listings
      WHERE listings.id = orders.listing_id
        AND listings.donor_id = auth.uid()
    )
  );

-- Admins see all orders
DROP POLICY IF EXISTS "admin_all_orders" ON orders;
CREATE POLICY "admin_all_orders" ON orders
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin')
  );

-- ─── DISPATCH EVENTS ────────────────────────────────────────────────────────
ALTER TABLE dispatch_events ENABLE ROW LEVEL SECURITY;

-- Couriers see their own dispatch events
DROP POLICY IF EXISTS "couriers_see_own_dispatch_events" ON dispatch_events;
CREATE POLICY "couriers_see_own_dispatch_events" ON dispatch_events
  FOR SELECT TO authenticated
  USING (courier_id = auth.uid());

-- ─── FEEDBACK EVENTS ────────────────────────────────────────────────────────
ALTER TABLE feedback_events ENABLE ROW LEVEL SECURITY;

-- Consumers can insert feedback for their own orders
DROP POLICY IF EXISTS "consumers_insert_feedback" ON feedback_events;
CREATE POLICY "consumers_insert_feedback" ON feedback_events
  FOR INSERT TO authenticated
  WITH CHECK (consumer_id = auth.uid());

-- Consumers can see their own feedback
DROP POLICY IF EXISTS "consumers_see_own_feedback" ON feedback_events;
CREATE POLICY "consumers_see_own_feedback" ON feedback_events
  FOR SELECT TO authenticated
  USING (consumer_id = auth.uid());

-- Admins see all feedback
DROP POLICY IF EXISTS "admin_all_feedback" ON feedback_events;
CREATE POLICY "admin_all_feedback" ON feedback_events
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin')
  );

-- ─── AUDIT LOG ──────────────────────────────────────────────────────────────
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Only admins can read the audit log via client; service_role reads everything
DROP POLICY IF EXISTS "admin_read_audit_log" ON audit_log;
CREATE POLICY "admin_read_audit_log" ON audit_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin')
  );

-- No client-side inserts — audit log is written only via PostgreSQL RPCs
-- (which run as SECURITY DEFINER with service_role privileges)


-- ============================================================
-- FILE: migrations/004_rpc.sql
-- ============================================================
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


-- ============================================================
-- FILE: migrations/005_audit.sql
-- ============================================================
-- 005_audit.sql
-- Enforce audit_log immutability and feedback_events immutability
-- These REVOKE statements ensure no application-layer user can modify history

-- ─── AUDIT LOG — APPEND-ONLY ENFORCEMENT ────────────────────────────────────
-- Application users (authenticated, anon) may never modify or delete audit records.
-- The RPCs in 004_rpc.sql insert via SECURITY DEFINER (bypasses this restriction).
REVOKE UPDATE, DELETE ON audit_log FROM authenticated;
REVOKE UPDATE, DELETE ON audit_log FROM anon;

-- ─── FEEDBACK EVENTS — IMMUTABLE ────────────────────────────────────────────
-- Once a feedback_event is written, it cannot be changed.
-- PRD §8.3: dispute history must be tamper-proof.
REVOKE UPDATE, DELETE ON feedback_events FROM authenticated;
REVOKE UPDATE, DELETE ON feedback_events FROM anon;

-- ─── VERIFY IMMUTABILITY (run manually to confirm) ──────────────────────────
-- The following must raise "ERROR: permission denied" when run as authenticated role:
--   UPDATE audit_log SET event_type = 'modified' WHERE entity_type = 'test';
--   DELETE FROM audit_log WHERE entity_type = 'test';
--   UPDATE feedback_events SET outcome = 'positive' WHERE id = '00000000-0000-0000-0000-000000000000';

-- ─── PRICING FIELD PROTECTION ───────────────────────────────────────────────
-- Once a listing moves out of 'draft', its pricing columns are locked.
-- This trigger enforces it at the database layer.
CREATE OR REPLACE FUNCTION prevent_pricing_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status != 'draft' AND (
    NEW.donor_payout_cents != OLD.donor_payout_cents OR
    NEW.consumer_price_cents != OLD.consumer_price_cents OR
    NEW.platform_fee_cents != OLD.platform_fee_cents OR
    NEW.courier_fee_cents != OLD.courier_fee_cents OR
    NEW.base_commodity_price_cents != OLD.base_commodity_price_cents
  ) THEN
    RAISE EXCEPTION 'PRICING_LOCKED'
      USING HINT = 'Pricing fields cannot be modified after listing leaves draft status';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS listings_pricing_lock ON listings;
CREATE TRIGGER listings_pricing_lock
  BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION prevent_pricing_update();


-- ============================================================
-- FILE: migrations/006_indexes.sql
-- ============================================================
-- 006_indexes.sql
-- Performance indexes for FoodLink
-- GIST indexes are required for PostGIS geography queries (TRD §2.9: <200ms)

-- ─── GEOGRAPHY (PostGIS) — GIST indexes ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_courier_profiles_location
  ON courier_profiles USING GIST (current_location);

CREATE INDEX IF NOT EXISTS idx_donor_profiles_location
  ON donor_profiles USING GIST (location);

CREATE INDEX IF NOT EXISTS idx_consumer_profiles_location
  ON consumer_profiles USING GIST (location);

-- ─── COURIER AVAILABILITY ────────────────────────────────────────────────────
-- Primary dispatch query filter: is_available + optional insulated_transport_capable
CREATE INDEX IF NOT EXISTS idx_courier_available
  ON courier_profiles (is_available)
  WHERE is_available = TRUE;

CREATE INDEX IF NOT EXISTS idx_courier_available_insulated
  ON courier_profiles (is_available, insulated_transport_capable)
  WHERE is_available = TRUE;

-- ─── LISTINGS ────────────────────────────────────────────────────────────────
-- Consumer marketplace feed: status + published_at
CREATE INDEX IF NOT EXISTS idx_listings_status
  ON listings (status);

CREATE INDEX IF NOT EXISTS idx_listings_live_feed
  ON listings (published_at DESC)
  WHERE status = 'live';

-- Donor dashboard: see own listings
CREATE INDEX IF NOT EXISTS idx_listings_donor_id
  ON listings (donor_id);

-- Cold-chain check (Inngest every 5 min): temperature-sensitive listings approaching expiry
CREATE INDEX IF NOT EXISTS idx_listings_cold_chain_check
  ON listings (temperature_sensitive, safety_expires_at, status)
  WHERE temperature_sensitive = TRUE AND status IN ('live', 'dispatched');

-- ─── ORDERS ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_consumer_id
  ON orders (consumer_id);

CREATE INDEX IF NOT EXISTS idx_orders_courier_id
  ON orders (courier_id)
  WHERE courier_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_listing_id
  ON orders (listing_id);

CREATE INDEX IF NOT EXISTS idx_orders_status
  ON orders (status);

-- Dispute window query (Inngest): delivered orders whose window hasn't expired
CREATE INDEX IF NOT EXISTS idx_orders_dispute_window
  ON orders (dispute_window_expires_at)
  WHERE status = 'delivered';

-- ─── DISPATCH EVENTS ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_dispatch_events_order_id
  ON dispatch_events (order_id);

CREATE INDEX IF NOT EXISTS idx_dispatch_events_courier_id
  ON dispatch_events (courier_id);

-- Unanswered dispatch events (for 5-min timeout check)
CREATE INDEX IF NOT EXISTS idx_dispatch_events_pending
  ON dispatch_events (offered_at)
  WHERE response IS NULL;

-- ─── AUDIT LOG ───────────────────────────────────────────────────────────────
-- Entity lookup (admin dashboard, dispute review)
CREATE INDEX IF NOT EXISTS idx_audit_log_entity
  ON audit_log (entity_type, entity_id);

-- Recent activity (admin dashboard)
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
  ON audit_log (created_at DESC);

-- ─── FEEDBACK EVENTS ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_feedback_events_order_id
  ON feedback_events (order_id);

-- Food safety incident rate metric (PRD §4.2)
CREATE INDEX IF NOT EXISTS idx_feedback_events_outcome
  ON feedback_events (outcome, created_at DESC);


-- ============================================================
-- FILE: migrations/007_fixes.sql
-- ============================================================
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


-- ============================================================
-- FILE: migrations/008_rpcs.sql
-- ============================================================
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


-- ============================================================
-- FILE: migrations/009_storage.sql
-- ============================================================
-- 009_storage.sql
-- Create listing-photos bucket as private per TRD §2.16 SH-3
-- Unauthenticated GET to storage object URL must return 403.
INSERT INTO storage.buckets (id, name, public)
VALUES ('listing-photos', 'listing-photos', false)
ON CONFLICT (id) DO UPDATE SET public = false;


-- ============================================================
-- FILE: migrations/010_feedback_guards.sql
-- ============================================================
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


-- ============================================================
-- FILE: migrations/012_security_hardening.sql
-- ============================================================
-- 012_security_hardening.sql (renamed from 009_security_hardening.sql — the
-- 009 version prefix collided with 009_storage.sql and broke Supabase Preview)
-- Security + correctness fixes from the 2026-07-06 pre-showcase audit.
-- Run after 001–010. 013_merge_reconciliation.sql must run after this file.

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
-- (UUID, TEXT): 010_feedback_guards dropped the original one-arg signature
REVOKE EXECUTE ON FUNCTION revert_listing_to_live(UUID, TEXT)                      FROM PUBLIC, anon, authenticated;
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


-- ============================================================
-- FILE: migrations/013_merge_reconciliation.sql
-- ============================================================
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


-- ============================================================
-- FILE: seed.sql
-- ============================================================
-- seed.sql
-- USDA commodity price table — MVP initial data
-- Review cadence: every 4 weeks (PRD §7.2.1)
-- Categories with updated_at > 60 days block listing creation (enforced in application)
-- LAST REVIEWED: 2026-06-30

INSERT INTO usda_commodity_prices (category, price_per_lb, retail_benchmark_per_lb)
VALUES
  -- Temperature-sensitive categories (temperature_sensitive = TRUE)
  ('POULTRY',           1.89,  4.29),
  ('BEEF',              2.45,  6.99),
  ('PORK',              1.75,  4.49),
  ('SEAFOOD',           3.20,  8.99),
  ('EGGS',              0.22,  0.39),   -- per egg equivalent by weight
  ('DAIRY',             0.65,  1.89),
  ('COOKED_RICE',       0.35,  1.29),
  ('COOKED_BEANS',      0.40,  1.49),
  ('PREPARED_HOT_FOOD', 1.50,  4.99),
  ('CUT_PRODUCE',       0.80,  2.49),
  ('SPROUTS',           1.20,  3.99),
  -- Non-temperature-sensitive categories
  ('PRODUCE_LEAFY',     0.55,  1.99),
  ('PRODUCE_ROOT',      0.45,  1.49),
  ('GRAIN',             0.30,  1.09),
  ('BAKED_GOOD',        0.85,  2.99),
  ('OTHER',             0.50,  1.79)
ON CONFLICT (category) DO UPDATE
  SET price_per_lb            = EXCLUDED.price_per_lb,
      retail_benchmark_per_lb = EXCLUDED.retail_benchmark_per_lb,
      updated_at              = NOW();