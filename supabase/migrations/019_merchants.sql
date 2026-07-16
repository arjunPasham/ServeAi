-- 019_merchants.sql
-- Phase 1 (pivot): the paying customer. New table — donor_profiles is NOT
-- mutated (frozen consumer/donor flow still reads it). A user "is a merchant"
-- iff they have a row here; users.role stays 'donor' in Phase 1 (no auth churn).
-- plan/fee defaults follow ACTION_PLAN Q5 (weekly $99 flagship; monthly is a
-- negotiated tier; billing logic itself is Phase 6).

CREATE TABLE IF NOT EXISTS merchants (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  business_name      TEXT NOT NULL,
  ein                TEXT,
  contact_name       TEXT,
  phone              TEXT,
  address            TEXT NOT NULL,
  address_lat        FLOAT8,
  address_lng        FLOAT8,
  address_validated  BOOLEAN NOT NULL DEFAULT FALSE,
  service_days       JSONB NOT NULL DEFAULT '["Mon","Tue","Wed","Thu","Fri"]',
  plan               TEXT NOT NULL DEFAULT 'weekly'
                     CHECK (plan IN ('weekly','monthly','per_pickup')),
  fee_cents          INTEGER NOT NULL DEFAULT 9900,
  stripe_customer_id TEXT,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('invited','active','paused','churned')),
  metro_id           TEXT NOT NULL DEFAULT 'atl',
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS merchants_updated_at ON merchants;
CREATE TRIGGER merchants_updated_at
  BEFORE UPDATE ON merchants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_merchants_user_id ON merchants (user_id);

ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;

-- Merchants read their own row; admins read all; writes are service-role only.
DROP POLICY IF EXISTS "merchants_select_own" ON merchants;
CREATE POLICY "merchants_select_own" ON merchants
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "merchants_admin_all" ON merchants;
CREATE POLICY "merchants_admin_all" ON merchants
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

-- Backfill: every existing donor becomes a merchant so dev/e2e accounts keep
-- working. dev-mode synthetic addresses stay address_validated = FALSE.
INSERT INTO merchants (user_id, business_name, address, address_lat, address_lng, address_validated)
SELECT dp.user_id,
       COALESCE(dp.business_name, 'Unnamed merchant (backfilled)'),
       dp.address, dp.address_lat, dp.address_lng, dp.address_validated
FROM donor_profiles dp
ON CONFLICT (user_id) DO NOTHING;
