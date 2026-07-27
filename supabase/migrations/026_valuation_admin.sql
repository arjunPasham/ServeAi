-- 026_valuation_admin.sql
-- Task A (real admin tooling — closes audit I4). Two things, both in the house
-- idiom established by 020/024/025:
--
--   1. insert_valuation  — a guarded SECURITY DEFINER RPC that APPENDS one new
--                          valuation_table row (never edits history — the
--                          "catalog only grows" ground rule; a price change is
--                          a new effective_from row, and declare_load already
--                          snapshots the latest effective row at declaration).
--                          The RPC body only INSERTs, so even the definer role
--                          cannot rewrite history through this path. Writes an
--                          in-transaction audit_log row; REVOKEd from
--                          PUBLIC/anon/authenticated (service/ops callable only,
--                          like declare_load). This replaces the dead
--                          usda_commodity_prices editor the admin page shipped
--                          (that table the live flow never reads — audit I4).
--
--   2. basis_per_lb_cents read restriction — the deferred audit minor
--                          ("basis_per_lb_cents (merchant cost data) is readable
--                          by any authed role"). valuation_table's SELECT policy
--                          is USING(true) TO authenticated, and Supabase's
--                          default grant hands `authenticated` table-wide SELECT,
--                          so any authed user can read the cost-basis column via
--                          PostgREST. We revoke that table-wide grant and re-grant
--                          SELECT on every column EXCEPT basis_per_lb_cents. The
--                          live valuation reads (getCategoriesWithValuations, the
--                          declare_load snapshot) all run under the service client
--                          / SECURITY DEFINER, which bypass column privileges, so
--                          they are unaffected; only a raw authenticated read
--                          loses the basis column. anon has no SELECT policy here,
--                          so RLS already blocks it — nothing to change for anon.
--
-- Idempotent (CREATE OR REPLACE; REVOKE/GRANT are no-ops when already applied).
-- SQL-editor run is a PENDING USER action. Depends on 018 (categories,
-- valuation_table) and 002 (audit_log).

-- ─── RPC: append a new valuation row (ops price change) ─────────────────────
-- effective_from defaults to NOW() via the table default: a v1 price change is
-- "effective now". The versioned table means the previous row is retained and
-- any load/receipt that already snapshotted it stays reproducible.
CREATE OR REPLACE FUNCTION insert_valuation(
  p_category_key       TEXT,
  p_fmv_per_lb_cents   INTEGER,
  p_basis_per_lb_cents INTEGER,
  p_created_by         UUID
) RETURNS valuation_table
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.valuation_table;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.categories WHERE category_key = p_category_key) THEN
    RAISE EXCEPTION 'UNKNOWN_CATEGORY' USING HINT = 'category_key not in categories';
  END IF;

  IF p_fmv_per_lb_cents IS NULL OR p_basis_per_lb_cents IS NULL
     OR p_fmv_per_lb_cents < 0 OR p_basis_per_lb_cents < 0 THEN
    RAISE EXCEPTION 'INVALID_VALUATION'
      USING HINT = 'fmv and basis must both be present and >= 0 (integer cents)';
  END IF;

  -- Append only — a new effective_from (table default NOW()) row. Never UPDATE.
  INSERT INTO public.valuation_table (category_key, fmv_per_lb_cents, basis_per_lb_cents, created_by)
  VALUES (p_category_key, p_fmv_per_lb_cents, p_basis_per_lb_cents, p_created_by)
  RETURNING * INTO v_row;

  -- Audit the price change: the cents values ARE the point of the record, and
  -- they are not PII (the 002 payload rule forbids addresses/names/contact).
  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('valuation', v_row.id, 'valuation_added', p_created_by, 'admin',
          jsonb_build_object('category_key', p_category_key,
                             'fmv_per_lb_cents', p_fmv_per_lb_cents,
                             'basis_per_lb_cents', p_basis_per_lb_cents,
                             'effective_from', v_row.effective_from));

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION insert_valuation(TEXT, INTEGER, INTEGER, UUID) FROM PUBLIC, anon, authenticated;

-- ─── Restrict basis_per_lb_cents from general authenticated reads ───────────
REVOKE SELECT ON public.valuation_table FROM authenticated;
GRANT SELECT (id, category_key, fmv_per_lb_cents, effective_from, created_by)
  ON public.valuation_table TO authenticated;
