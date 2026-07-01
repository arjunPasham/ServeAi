-- 002_schema.sql
-- Core table definitions for FoodLink
-- All 10 tables in dependency order (no forward FK references)

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
CREATE TABLE users (
  id             UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email          TEXT UNIQUE NOT NULL,
  phone          TEXT UNIQUE,
  phone_verified BOOLEAN DEFAULT FALSE,
  role           TEXT NOT NULL CHECK (role IN ('donor','consumer','courier','admin')),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

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

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();

-- ─── USDA COMMODITY PRICES ──────────────────────────────────────────────────
-- Manually maintained in MVP; reviewed every 4 weeks (PRD §7.2.1).
-- Categories with updated_at > 60 days block listing creation.
CREATE TABLE usda_commodity_prices (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category                TEXT NOT NULL UNIQUE,
  price_per_lb            NUMERIC(10,4) NOT NULL,
  retail_benchmark_per_lb NUMERIC(10,4) NOT NULL,
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_by              UUID REFERENCES users(id)
);

-- ─── DONOR PROFILES ─────────────────────────────────────────────────────────
CREATE TABLE donor_profiles (
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
CREATE TABLE consumer_profiles (
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
CREATE TABLE courier_profiles (
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

CREATE TRIGGER consumer_location_sync
  BEFORE INSERT OR UPDATE OF delivery_lat, delivery_lng ON consumer_profiles
  FOR EACH ROW EXECUTE FUNCTION sync_consumer_location();

-- ─── LISTINGS ───────────────────────────────────────────────────────────────
CREATE TABLE listings (
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
CREATE TABLE orders (
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
CREATE TABLE dispatch_events (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id     UUID NOT NULL REFERENCES orders(id),
  courier_id   UUID NOT NULL REFERENCES users(id),
  offered_at   TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  response     TEXT CHECK (response IN ('accepted','declined','timeout'))
);

-- ─── FEEDBACK EVENTS ────────────────────────────────────────────────────────
-- FIX: photo_url added per TRD fix — required when outcome = 'issue_reported' (PRD §8.3)
CREATE TABLE feedback_events (
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
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   UUID NOT NULL,
  event_type  TEXT NOT NULL,
  actor_id    UUID,
  actor_role  TEXT,
  payload     JSONB NOT NULL,   -- NEVER contains raw PII (addresses, names, contact)
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
