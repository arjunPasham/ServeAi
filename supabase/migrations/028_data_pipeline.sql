-- 028_data_pipeline.sql
-- Task 1 — supply-side surplus intelligence (transition-plan Phase 7, the data
-- moat). A read-only reporting layer over data that ALREADY exists (scan_records,
-- scan_items, loads, load_items + valuation snapshots). SQL/aggregation, NOT ML.
--
-- SCAN/DECLARE-time fields ONLY. This deliberately excludes every custody /
-- receiving-confirmation field (load_items.qty_at_pickup / qty_accepted /
-- qty_rejected) — those depend on the Phase 3/4 custody flow that does not exist
-- yet, and any "delivered / diverted" metric built on them would be fiction. The
-- signal here is pure supply: what a merchant SCANNED and DECLARED.
--
-- Two views + one index:
--   1. export_scan_items       — flat per-merchant/day/item warehouse grain, so
--                                future modeling never queries production shapes.
--   2. merchant_surplus_patterns — pre-aggregated (merchant, category, weekday)
--                                supply pattern over a rolling window.
--   3. idx_scan_items_dangling — supports the disposition-hygiene sweep.
--
-- Both views are ADMIN/SERVICE scoped: SELECT is revoked from anon/authenticated
-- (only the service role — i.e. ops via the service client — reads them).
-- security_invoker=true so they respect RLS if SELECT is ever granted to a
-- user role (defense in depth; service_role bypasses RLS regardless).
--
-- Idempotent (CREATE OR REPLACE VIEW; CREATE INDEX IF NOT EXISTS; REVOKE/GRANT
-- are no-ops on replay). SQL-editor run is a PENDING USER action. Depends on
-- 019 (merchants), 020 (scan_records/scan_items/loads/load_items), 018 (categories).
--
-- Weekday note: local_dow / local_scanned_on are computed in America/New_York
-- (the pilot metro's timezone) so "every Monday" means the merchant's local
-- Monday, not a UTC-server artifact. Revisit when multi-metro: derive the tz
-- from merchants.metro_id instead of pinning Eastern.

-- ─── 1. Flat warehouse view — per-merchant/day/item grain ───────────────────
CREATE OR REPLACE VIEW export_scan_items WITH (security_invoker = true) AS
SELECT
  sr.merchant_id,
  m.business_name                                                          AS merchant_business_name,
  m.metro_id,
  si.id                                                                    AS scan_item_id,
  si.scan_record_id,
  sr.scanned_at,
  (sr.scanned_at AT TIME ZONE 'America/New_York')::date                    AS local_scanned_on,
  EXTRACT(ISODOW FROM sr.scanned_at AT TIME ZONE 'America/New_York')::int  AS local_dow,  -- 1=Mon … 7=Sun
  si.category_key,
  c.label                                                                  AS category_label,
  c.temperature_sensitive,
  si.food_name,
  si.est_lbs,
  si.ai_est_lbs,
  si.ai_confidence,
  si.merchant_confirmed,
  si.disposition,
  si.disposition_at,
  si.load_id,
  l.window_date,
  l.status                                                                 AS load_status,
  l.lane,
  -- Valuation SNAPSHOT taken at declaration (load_items); NULL until declared.
  -- Never the live valuation_table row — an IRS-facing figure must be reproducible.
  li.fmv_per_lb_cents,
  li.basis_per_lb_cents,
  CASE WHEN li.id IS NOT NULL THEN ROUND(li.est_lbs * li.fmv_per_lb_cents)::bigint   END AS est_fmv_cents,
  CASE WHEN li.id IS NOT NULL THEN ROUND(li.est_lbs * li.basis_per_lb_cents)::bigint END AS est_basis_cents,
  si.created_at
FROM scan_items si
JOIN scan_records sr ON sr.id = si.scan_record_id
JOIN merchants     m  ON m.id = sr.merchant_id
JOIN categories    c  ON c.category_key = si.category_key
LEFT JOIN loads      l  ON l.id = si.load_id
LEFT JOIN load_items li ON li.scan_item_id = si.id;

REVOKE ALL     ON export_scan_items FROM anon, authenticated;
GRANT  SELECT  ON export_scan_items TO service_role;

-- ─── 2. Per-merchant weekly surplus-pattern view ────────────────────────────
-- "What a merchant tends to have left over, by category, by weekday, over time"
-- — e.g. ~22 lbs of BAKERY every Monday. Rolling 90-day (≈13-week) window so
-- the pattern reflects recent behavior, not a one-off scan from a year ago.
-- Only merchant_confirmed items count: those are the surplus the merchant
-- actually verified (abandoned/removed scans are noise). Pure supply signal —
-- no delivery/receiving outcome involved.
CREATE OR REPLACE VIEW merchant_surplus_patterns WITH (security_invoker = true) AS
SELECT
  sr.merchant_id,
  m.business_name                                                              AS merchant_business_name,
  si.category_key,
  c.label                                                                      AS category_label,
  EXTRACT(ISODOW FROM sr.scanned_at AT TIME ZONE 'America/New_York')::int      AS local_dow,  -- 1=Mon … 7=Sun
  COUNT(*)                                                                     AS item_count,
  COUNT(DISTINCT (sr.scanned_at AT TIME ZONE 'America/New_York')::date)        AS distinct_days,
  ROUND(SUM(si.est_lbs), 2)                                                    AS total_est_lbs,
  ROUND(
    SUM(si.est_lbs)
    / NULLIF(COUNT(DISTINCT (sr.scanned_at AT TIME ZONE 'America/New_York')::date), 0),
    2
  )                                                                            AS avg_est_lbs_per_day,
  MAX(sr.scanned_at)                                                           AS last_seen
FROM scan_items si
JOIN scan_records sr ON sr.id = si.scan_record_id
JOIN merchants     m  ON m.id = sr.merchant_id
JOIN categories    c  ON c.category_key = si.category_key
WHERE si.merchant_confirmed = TRUE
  AND sr.scanned_at >= NOW() - INTERVAL '90 days'
GROUP BY sr.merchant_id, m.business_name, si.category_key, c.label,
         EXTRACT(ISODOW FROM sr.scanned_at AT TIME ZONE 'America/New_York');

REVOKE ALL     ON merchant_surplus_patterns FROM anon, authenticated;
GRANT  SELECT  ON merchant_surplus_patterns TO service_role;

-- ─── 3. Dangling-scan index (disposition-hygiene sweep) ─────────────────────
-- The sweep flags scans captured but never declared onto a load and left in
-- 'pending' past a sane window (abandoned manifests — the dataset-rot case).
-- Declared items legitimately stay 'pending' until custody exists (Phase 4),
-- so they are NOT danglers: the predicate is disposition='pending' AND
-- load_id IS NULL. Partial index keyed on created_at makes the age scan cheap.
CREATE INDEX IF NOT EXISTS idx_scan_items_dangling
  ON scan_items (created_at)
  WHERE disposition = 'pending' AND load_id IS NULL;
