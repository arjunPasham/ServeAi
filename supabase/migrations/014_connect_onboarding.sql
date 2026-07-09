-- 014_connect_onboarding.sql
-- Track Stripe Connect Express onboarding state (TRD Step 3/10, decision #2: Express)
-- Note: donor_profiles never got a stripe_account_id column (only courier_profiles
-- did, in 002_schema.sql) — added here since Connect onboarding needs it for donors too.
ALTER TABLE donor_profiles   ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
ALTER TABLE donor_profiles   ADD COLUMN IF NOT EXISTS payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE courier_profiles ADD COLUMN IF NOT EXISTS payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_donor_profiles_stripe_account   ON donor_profiles (stripe_account_id)   WHERE stripe_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_courier_profiles_stripe_account ON courier_profiles (stripe_account_id) WHERE stripe_account_id IS NOT NULL;
