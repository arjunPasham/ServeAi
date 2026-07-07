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
