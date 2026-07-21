-- 023_institutions.sql
-- Phase 2 (Match): the institution entity — the receiver side of the match.
-- New table; it SUPERSEDES the pre-pivot consumer_profiles.type='shelter'
-- notion, and does NOT mutate consumer_profiles (frozen consumer flow still
-- reads it). Institutions are OPS-INVITED: an ops person creates the row
-- (status='pending', user_id NULL) before the org ever logs in, so most
-- columns are nullable and there is no self-serve registration or backfill.
--
-- Only the receiving_windows JSONB shape is reused from consumer_profiles
-- (002_schema.sql:86) — [{day,start,end}] — which was the one right piece.
--
-- The no-login inbound-preview token (PHASE_2_PROMPT Task 1) is deliberately
-- NOT placed here: it lives on the allocations row in 024, because the preview
-- and its accept/decline are per-OFFER (institution + load + window), not
-- per-load. See the Task 1 report for the justification.
--
-- Idempotent (CREATE ... IF NOT EXISTS, DROP+CREATE trigger/policy, CREATE OR
-- REPLACE function) so a re-run in the SQL editor is safe. Depends on 001
-- (uuid-ossp + postgis) and 002 (update_updated_at()).

CREATE TABLE IF NOT EXISTS institutions (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_name             TEXT NOT NULL,
  ein                  TEXT,

  -- 501(c)(3) verification. Donation-lane offers are HARD-GATED on npo_verified
  -- in offer_load (024) — a donation to an unverified receiver breaks the Good
  -- Samaritan / IRC 170(e)(3) story. The verify action sets the trio together.
  npo_verified         BOOLEAN NOT NULL DEFAULT FALSE,
  npo_evidence_key     TEXT,                    -- private-bucket key: determination letter
  npo_verified_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  npo_verified_at      TIMESTAMPTZ,

  -- Authorized signer (donee-acknowledgment contact; notified on offer in Task 4)
  signer_name          TEXT,
  signer_email         TEXT,
  signer_phone         TEXT,

  -- Standing demand profile (drives ops match suggestions in Task 3)
  receiving_windows    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{day,start,end}]
  demand_category_keys TEXT[] NOT NULL DEFAULT '{}',        -- validated vs categories in the RPC (PG arrays can't FK)
  capacity_lbs         NUMERIC,                             -- nightly receiving capacity
  has_food_budget      BOOLEAN NOT NULL DEFAULT FALSE,
  dock_notes           TEXT,

  -- Location — mirrors the donor_location_sync pattern (002_schema.sql:118).
  -- Column named `location` for cross-table consistency (donor/consumer_profiles
  -- use `location`; courier_profiles uses `current_location`).
  address              TEXT,
  address_lat          FLOAT8,
  address_lng          FLOAT8,
  location             GEOGRAPHY(POINT,4326),

  metro_id             TEXT NOT NULL DEFAULT 'atl',
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','active','suspended')),

  -- Nullable: institutions are ops-managed before they ever log in. ON DELETE
  -- SET NULL is deliberate retention intent (cf. review I8) — deleting the auth
  -- user unlinks the login but keeps the org record and its IRS-facing history.
  user_id              UUID REFERENCES users(id) ON DELETE SET NULL,

  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Sync geo from lat/lng (mirror sync_donor_location, 002_schema.sql:119)
CREATE OR REPLACE FUNCTION sync_institution_location()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.address_lat IS NOT NULL AND NEW.address_lng IS NOT NULL THEN
    NEW.location = ST_SetSRID(ST_MakePoint(NEW.address_lng, NEW.address_lat), 4326)::geography;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS institution_location_sync ON institutions;
CREATE TRIGGER institution_location_sync
  BEFORE INSERT OR UPDATE OF address_lat, address_lng ON institutions
  FOR EACH ROW EXECUTE FUNCTION sync_institution_location();

DROP TRIGGER IF EXISTS institutions_updated_at ON institutions;
CREATE TRIGGER institutions_updated_at
  BEFORE UPDATE ON institutions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- One institution per logged-in user (partial: ops-managed rows have NULL user_id).
-- Also serves the RLS select_own lookup below.
CREATE UNIQUE INDEX IF NOT EXISTS idx_institutions_user_id
  ON institutions (user_id) WHERE user_id IS NOT NULL;

-- Ops console lists active institutions in a metro (Task 3 getInstitutions).
CREATE INDEX IF NOT EXISTS idx_institutions_metro_status
  ON institutions (metro_id, status);

ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;

-- An institution reads its own row (once user_id is linked); admins read/manage
-- all; every write goes through the service client / guarded RPCs. Rows with
-- user_id NULL (ops-managed, pending) are visible only to admins + service role,
-- since NULL = auth.uid() is never true. Mirrors the merchants posture (019).
DROP POLICY IF EXISTS "institutions_select_own" ON institutions;
CREATE POLICY "institutions_select_own" ON institutions
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "institutions_admin_all" ON institutions;
CREATE POLICY "institutions_admin_all" ON institutions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));
