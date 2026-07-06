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