-- cleanup-dev-stripe-accounts.sql
-- REQUIRED when graduating from dev mode (no STRIPE_SECRET_KEY) to real
-- Stripe keys. Dev-mode Connect onboarding mints synthetic acct_dev_* ids and
-- flips payouts_enabled to true instantly; against real Stripe those accounts
-- can never receive a transfer, so every dev-onboarded donor/courier would
-- have transfers silently skipped forever.
--
-- Run in the Supabase SQL editor. Affected users simply re-onboard through
-- the normal Connect flow (Dashboard → "Set up payouts").
--
-- Defense in depth: canReceiveTransfers() in src/lib/stripe.ts also refuses
-- acct_dev_* ids outside dev mode, so skipping this script degrades to
-- audited skipped payouts rather than lost money — but run it anyway.

UPDATE donor_profiles
SET stripe_account_id = NULL,
    payouts_enabled   = FALSE
WHERE stripe_account_id LIKE 'acct_dev_%';

UPDATE courier_profiles
SET stripe_account_id = NULL,
    payouts_enabled   = FALSE
WHERE stripe_account_id LIKE 'acct_dev_%';
