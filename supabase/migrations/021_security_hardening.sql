-- 021_security_hardening.sql
-- Task 0.5 (pre-Phase-2 hardening): I4/I8 follow-ups that are safe, additive,
-- and idempotent. No function-body recreation and no live-policy rewrites
-- here — those are tracked separately (see report), not in this file.
--
-- Numbering note: this migration claims 021, so Phase 2's planned
-- `institutions` (021) and `allocations` (022) migrations shift to 022 and
-- 023 respectively. PHASE_2_PROMPT.md is intentionally left unedited —
-- the Phase 2 builder renumbers when it gets there.

-- ─── I8: make user-deletion / retention intent explicit ────────────────────
-- 020_scan_inventory.sql leaves merchants/scan_records/scan_items/loads FKs
-- at the default ON DELETE NO ACTION. That is by design, not an oversight:
-- these rows are IRS-relevant (170(e)(3) valuation basis) and must survive
-- deletion of the auth user who created them. Deleting an auth user who has
-- scans/loads on file today aborts with a raw FK error — intended behavior,
-- now documented at the table level rather than silent.
COMMENT ON TABLE loads IS
  'Retention: FK to merchants/users is ON DELETE NO ACTION by design — merchant '
  'scan/load records are IRS-relevant (170(e)(3) valuation basis) and must '
  'survive auth-user deletion. Deleting an auth user with scans requires an '
  'explicit anonymize/archive path (Phase 2+), not a cascade.';

COMMENT ON TABLE scan_records IS
  'Retention: FK to merchants/users is ON DELETE NO ACTION by design — merchant '
  'scan/load records are IRS-relevant (170(e)(3) valuation basis) and must '
  'survive auth-user deletion. Deleting an auth user with scans requires an '
  'explicit anonymize/archive path (Phase 2+), not a cascade.';

COMMENT ON TABLE scan_items IS
  'Retention: FK to merchants/users is ON DELETE NO ACTION by design — merchant '
  'scan/load records are IRS-relevant (170(e)(3) valuation basis) and must '
  'survive auth-user deletion. Deleting an auth user with scans requires an '
  'explicit anonymize/archive path (Phase 2+), not a cascade.';

COMMENT ON TABLE load_items IS
  'Retention: FK to merchants/users is ON DELETE NO ACTION by design — merchant '
  'scan/load records are IRS-relevant (170(e)(3) valuation basis) and must '
  'survive auth-user deletion. Deleting an auth user with scans requires an '
  'explicit anonymize/archive path (Phase 2+), not a cascade.';

-- ─── Align the loads index with the actual dashboard query sort ───────────
-- src/actions/manifest.ts:getMerchantDashboard orders by created_at DESC
-- filtered on merchant_id, but 020 only indexed (merchant_id, window_date
-- DESC). Add the matching composite index; leave idx_loads_merchant_date in
-- place (still used by any window_date-ordered reads).
CREATE INDEX IF NOT EXISTS idx_loads_merchant_created
  ON loads (merchant_id, created_at DESC);
