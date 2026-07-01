-- 001_extensions.sql
-- Enable required PostgreSQL extensions
-- Run this first — other migrations depend on uuid_generate_v4() and PostGIS types

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- pg_cron requires Supabase Pro plan and must be enabled via:
-- Dashboard → Database → Extensions → pg_cron → Enable
-- Then uncomment:
-- CREATE EXTENSION IF NOT EXISTS "pg_cron";
