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
