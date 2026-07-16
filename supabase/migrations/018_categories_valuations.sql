-- 018_categories_valuations.sql
-- Phase 1 (pivot): stable category taxonomy + versioned valuation table.
-- categories.category_key is IMMUTABLE — the prediction dataset's time series
-- keys on it. Never rename a key; add a new row instead.
-- valuation_table is append-only: a price change INSERTS a new row with a
-- later effective_from. Loads/receipts snapshot values at use time and never
-- re-read (IRS-facing documents must be reproducible).
-- usda_commodity_prices stays untouched — the frozen consumer flow reads it.

CREATE TABLE IF NOT EXISTS categories (
  category_key          TEXT PRIMARY KEY,
  label                 TEXT NOT NULL,
  temperature_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  -- NULL = no TCS window. 2h hot / 4h cold ports the FDA defaults already
  -- used in src/actions/listing.ts (counsel sign-off still pending — old TRD
  -- blocking decision #3; values live in data now so counsel can tune them).
  safety_window_hours   INTEGER,
  sort                  INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS valuation_table (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_key       TEXT NOT NULL REFERENCES categories(category_key),
  fmv_per_lb_cents   INTEGER NOT NULL CHECK (fmv_per_lb_cents >= 0),
  basis_per_lb_cents INTEGER NOT NULL CHECK (basis_per_lb_cents >= 0),
  effective_from     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES users(id)
);

REVOKE UPDATE, DELETE ON valuation_table FROM authenticated, anon;

CREATE INDEX IF NOT EXISTS idx_valuation_current
  ON valuation_table (category_key, effective_from DESC);

-- RLS: authenticated users read (merchant UI shows valuation previews);
-- writes are service-role only (ops console — Phase 2+).
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE valuation_table ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "categories_select_all" ON categories;
CREATE POLICY "categories_select_all" ON categories
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "valuation_select_all" ON valuation_table;
CREATE POLICY "valuation_select_all" ON valuation_table
  FOR SELECT TO authenticated USING (true);

INSERT INTO categories (category_key, label, temperature_sensitive, safety_window_hours, sort) VALUES
  ('PREPARED_HOT',  'Prepared food — hot',        TRUE,  2,    10),
  ('PREPARED_COLD', 'Prepared food — cold',       TRUE,  4,    20),
  ('MEAT_RAW',      'Meat (raw / short-dated)',   TRUE,  4,    30),
  ('POULTRY_RAW',   'Poultry (raw / short-dated)',TRUE,  4,    40),
  ('SEAFOOD',       'Seafood',                    TRUE,  4,    50),
  ('DELI',          'Deli — sliced meats & cheeses', TRUE, 4,  60),
  ('DAIRY',         'Dairy',                      TRUE,  4,    70),
  ('EGGS',          'Eggs',                       TRUE,  4,    80),
  ('CUT_PRODUCE',   'Cut produce',                TRUE,  4,    90),
  ('BAKERY',        'Bakery & desserts',          FALSE, NULL, 100),
  ('PRODUCE_WHOLE', 'Whole produce',              FALSE, NULL, 110),
  ('GRAIN_DRY',     'Dry goods & grains',         FALSE, NULL, 120),
  ('BEVERAGE',      'Beverages',                  FALSE, NULL, 130),
  ('OTHER',         'Other',                      FALSE, NULL, 140)
ON CONFLICT (category_key) DO NOTHING;

-- Seed valuations only into an empty table (idempotent replay-safe).
-- Values derived from the old usda_commodity_prices seed (retail benchmark →
-- FMV proxy, commodity price → basis proxy). Ops-editable; EGGS flagged for
-- review at valuation-table setup (old seed priced per-egg, not per-lb).
INSERT INTO valuation_table (category_key, fmv_per_lb_cents, basis_per_lb_cents)
SELECT v.category_key, v.fmv, v.basis
FROM (VALUES
  ('PREPARED_HOT',  499, 150),
  ('PREPARED_COLD', 449, 140),
  ('MEAT_RAW',      699, 245),
  ('POULTRY_RAW',   429, 189),
  ('SEAFOOD',       899, 320),
  ('DELI',          649, 260),
  ('DAIRY',         189,  65),
  ('EGGS',          210,  95),
  ('CUT_PRODUCE',   249,  80),
  ('BAKERY',        299,  85),
  ('PRODUCE_WHOLE', 149,  45),
  ('GRAIN_DRY',     109,  30),
  ('BEVERAGE',      179,  50),
  ('OTHER',         179,  50)
) AS v(category_key, fmv, basis)
WHERE NOT EXISTS (SELECT 1 FROM valuation_table);
