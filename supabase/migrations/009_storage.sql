-- 009_storage.sql
-- Create listing-photos bucket as private per TRD §2.16 SH-3
-- Unauthenticated GET to storage object URL must return 403.
INSERT INTO storage.buckets (id, name, public)
VALUES ('listing-photos', 'listing-photos', false)
ON CONFLICT (id) DO UPDATE SET public = false;
