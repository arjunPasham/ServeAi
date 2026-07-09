-- 015_fix_auth_trigger.sql
-- P0 fix: registration was broken because handle_new_auth_user silently no-oped.
--
-- Root cause: the function is SECURITY DEFINER but never pinned search_path.
-- SECURITY DEFINER switches the executing ROLE, not the session search_path.
-- Supabase Auth (GoTrue) connects as supabase_auth_admin, whose search_path is
-- "auth", so the unqualified `INSERT INTO users` resolved to auth.users — where
-- the freshly inserted row's id always conflicts — and ON CONFLICT DO NOTHING
-- swallowed it. Result: auth.users row created, public.users mirror row never
-- created, no error anywhere.
--
-- Fix: pin an empty search_path and fully qualify every reference
-- (per Supabase's own handle_new_user reference implementation).

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, email, role)
  VALUES (NEW.id, NEW.email, 'consumer')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Recreate the trigger so this migration also repairs a database where the
-- trigger itself is missing (idempotent either way).
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- Backfill mirror rows for auth users created while the trigger was broken.
-- (email is NOT NULL in public.users, so phone-only auth users are skipped.)
INSERT INTO public.users (id, email, role)
SELECT au.id, au.email, 'consumer'
FROM auth.users au
LEFT JOIN public.users pu ON pu.id = au.id
WHERE pu.id IS NULL
  AND au.email IS NOT NULL
ON CONFLICT (id) DO NOTHING;
