-- 006_indexes.sql
-- Performance indexes for FoodLink
-- GIST indexes are required for PostGIS geography queries (TRD §2.9: <200ms)

-- ─── GEOGRAPHY (PostGIS) — GIST indexes ─────────────────────────────────────
CREATE INDEX idx_courier_profiles_location
  ON courier_profiles USING GIST (current_location);

CREATE INDEX idx_donor_profiles_location
  ON donor_profiles USING GIST (location);

CREATE INDEX idx_consumer_profiles_location
  ON consumer_profiles USING GIST (location);

-- ─── COURIER AVAILABILITY ────────────────────────────────────────────────────
-- Primary dispatch query filter: is_available + optional insulated_transport_capable
CREATE INDEX idx_courier_available
  ON courier_profiles (is_available)
  WHERE is_available = TRUE;

CREATE INDEX idx_courier_available_insulated
  ON courier_profiles (is_available, insulated_transport_capable)
  WHERE is_available = TRUE;

-- ─── LISTINGS ────────────────────────────────────────────────────────────────
-- Consumer marketplace feed: status + published_at
CREATE INDEX idx_listings_status
  ON listings (status);

CREATE INDEX idx_listings_live_feed
  ON listings (published_at DESC)
  WHERE status = 'live';

-- Donor dashboard: see own listings
CREATE INDEX idx_listings_donor_id
  ON listings (donor_id);

-- Cold-chain check (Inngest every 5 min): temperature-sensitive listings approaching expiry
CREATE INDEX idx_listings_cold_chain_check
  ON listings (temperature_sensitive, safety_expires_at, status)
  WHERE temperature_sensitive = TRUE AND status IN ('live', 'dispatched');

-- ─── ORDERS ──────────────────────────────────────────────────────────────────
CREATE INDEX idx_orders_consumer_id
  ON orders (consumer_id);

CREATE INDEX idx_orders_courier_id
  ON orders (courier_id)
  WHERE courier_id IS NOT NULL;

CREATE INDEX idx_orders_listing_id
  ON orders (listing_id);

CREATE INDEX idx_orders_status
  ON orders (status);

-- Dispute window query (Inngest): delivered orders whose window hasn't expired
CREATE INDEX idx_orders_dispute_window
  ON orders (dispute_window_expires_at)
  WHERE status = 'delivered';

-- ─── DISPATCH EVENTS ─────────────────────────────────────────────────────────
CREATE INDEX idx_dispatch_events_order_id
  ON dispatch_events (order_id);

CREATE INDEX idx_dispatch_events_courier_id
  ON dispatch_events (courier_id);

-- Unanswered dispatch events (for 5-min timeout check)
CREATE INDEX idx_dispatch_events_pending
  ON dispatch_events (offered_at)
  WHERE response IS NULL;

-- ─── AUDIT LOG ───────────────────────────────────────────────────────────────
-- Entity lookup (admin dashboard, dispute review)
CREATE INDEX idx_audit_log_entity
  ON audit_log (entity_type, entity_id);

-- Recent activity (admin dashboard)
CREATE INDEX idx_audit_log_created_at
  ON audit_log (created_at DESC);

-- ─── FEEDBACK EVENTS ─────────────────────────────────────────────────────────
CREATE INDEX idx_feedback_events_order_id
  ON feedback_events (order_id);

-- Food safety incident rate metric (PRD §4.2)
CREATE INDEX idx_feedback_events_outcome
  ON feedback_events (outcome, created_at DESC);
