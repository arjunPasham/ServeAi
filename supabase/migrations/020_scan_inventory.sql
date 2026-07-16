-- 020_scan_inventory.sql
-- Phase 1 (pivot): itemized scan capture + declared loads.
-- Schema decisions locked here on purpose (cheap now, expensive later — see
-- analysis/03-transition-plan.md):
--   * scan_items.disposition exists from day one (prediction dataset = scan → outcome)
--   * AI originals (ai_*) kept immutable beside merchant-confirmed values
--   * load_items snapshots fmv/basis per lb at declaration (documents must be
--     reproducible; the valuation_table row can change later)
--   * qty_at_pickup / qty_accepted / qty_rejected exist now, filled in Phase 4

-- Loads first (scan_items.load_id references it)
CREATE TABLE IF NOT EXISTS loads (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id                 UUID NOT NULL REFERENCES merchants(id),
  window_date                 DATE NOT NULL,
  lane                        TEXT NOT NULL DEFAULT 'donation'
                              CHECK (lane IN ('donation','sale')),
  status                      TEXT NOT NULL DEFAULT 'declared'
                              CHECK (status IN ('declared','matched','scheduled',
                                                'picked_up','delivered','closed','canceled')),
  earliest_safety_expires_at  TIMESTAMPTZ,
  declared_by                 UUID REFERENCES users(id),
  created_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scan_records (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id        UUID NOT NULL REFERENCES merchants(id),
  scanned_by         UUID NOT NULL REFERENCES users(id),
  photo_key          TEXT,
  scanned_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model_id           TEXT NOT NULL,
  overall_confidence NUMERIC(4,3) NOT NULL,
  needs_review       BOOLEAN NOT NULL DEFAULT FALSE,
  notes              TEXT,
  raw_response       JSONB NOT NULL    -- full model output, kept for future re-parse
);

CREATE TABLE IF NOT EXISTS scan_items (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scan_record_id        UUID NOT NULL REFERENCES scan_records(id),
  -- merchant-confirmed values (start as AI values, edited at confirm time)
  category_key          TEXT NOT NULL REFERENCES categories(category_key),
  food_name             TEXT NOT NULL,
  est_lbs               NUMERIC(8,2) NOT NULL CHECK (est_lbs > 0),
  -- immutable AI originals (fraud/QA delta + model-eval dataset)
  ai_category_key       TEXT REFERENCES categories(category_key),
  ai_food_name          TEXT NOT NULL,
  ai_est_lbs            NUMERIC(8,2),
  ai_confidence         NUMERIC(4,3) NOT NULL,
  qty_value             NUMERIC(10,2),
  qty_unit              TEXT,
  est_servings          NUMERIC(8,1),
  merchant_confirmed    BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_at          TIMESTAMPTZ,
  temperature_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  prepared_at           TIMESTAMPTZ,
  safety_expires_at     TIMESTAMPTZ,
  disposition           TEXT NOT NULL DEFAULT 'pending'
                        CHECK (disposition IN ('pending','donated','sold',
                                               'rejected_returned','not_shipped','disposed')),
  disposition_at        TIMESTAMPTZ,
  load_id               UUID REFERENCES loads(id),
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS load_items (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  load_id            UUID NOT NULL REFERENCES loads(id),
  scan_item_id       UUID NOT NULL UNIQUE REFERENCES scan_items(id),
  est_lbs            NUMERIC(8,2) NOT NULL,
  -- valuation snapshot at declaration — never re-read from valuation_table
  fmv_per_lb_cents   INTEGER NOT NULL,
  basis_per_lb_cents INTEGER NOT NULL,
  -- Phase 4 fills these at pickup / receiving
  qty_at_pickup      NUMERIC(8,2),
  qty_accepted       NUMERIC(8,2),
  qty_rejected       NUMERIC(8,2),
  reject_reason      TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scan_records_merchant ON scan_records (merchant_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_items_record     ON scan_items (scan_record_id);
CREATE INDEX IF NOT EXISTS idx_scan_items_pending    ON scan_items (disposition) WHERE disposition = 'pending';
CREATE INDEX IF NOT EXISTS idx_scan_items_load       ON scan_items (load_id) WHERE load_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_loads_merchant_date   ON loads (merchant_id, window_date DESC);
CREATE INDEX IF NOT EXISTS idx_load_items_load       ON load_items (load_id);

-- RLS: merchants read their own rows via the merchants join; admins read all;
-- ALL writes are service-role only (server actions), matching 012's philosophy.
ALTER TABLE scan_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE loads        ENABLE ROW LEVEL SECURITY;
ALTER TABLE load_items   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scan_records_select_own" ON scan_records;
CREATE POLICY "scan_records_select_own" ON scan_records
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM merchants m
                 WHERE m.id = scan_records.merchant_id AND m.user_id = auth.uid()));

DROP POLICY IF EXISTS "scan_items_select_own" ON scan_items;
CREATE POLICY "scan_items_select_own" ON scan_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM scan_records sr
                 JOIN merchants m ON m.id = sr.merchant_id
                 WHERE sr.id = scan_items.scan_record_id AND m.user_id = auth.uid()));

DROP POLICY IF EXISTS "loads_select_own" ON loads;
CREATE POLICY "loads_select_own" ON loads
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM merchants m
                 WHERE m.id = loads.merchant_id AND m.user_id = auth.uid()));

DROP POLICY IF EXISTS "load_items_select_own" ON load_items;
CREATE POLICY "load_items_select_own" ON load_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM loads l
                 JOIN merchants m ON m.id = l.merchant_id
                 WHERE l.id = load_items.load_id AND m.user_id = auth.uid()));

-- ─── RPC: declare a load from confirmed scan items ──────────────────────────
-- Atomic: lock items → validate → create load → snapshot valuations →
-- link items → audit. Any failure rolls the whole thing back.
CREATE OR REPLACE FUNCTION declare_load(
  p_merchant_id   UUID,
  p_declared_by   UUID,
  p_window_date   DATE,
  p_scan_item_ids UUID[]
) RETURNS loads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_load       public.loads;
  v_requested  INTEGER;
  v_eligible   INTEGER;
  v_earliest   TIMESTAMPTZ;
  v_snapshots  INTEGER;
BEGIN
  v_requested := COALESCE(array_length(p_scan_item_ids, 1), 0);
  IF v_requested = 0 THEN
    RAISE EXCEPTION 'EMPTY_LOAD' USING HINT = 'A load needs at least one scan item';
  END IF;

  -- Lock the rows first (FOR UPDATE cannot be combined with aggregates).
  PERFORM 1 FROM public.scan_items si
  WHERE si.id = ANY(p_scan_item_ids)
  FOR UPDATE;

  -- Eligibility: belongs to this merchant, confirmed, not already on a load.
  SELECT COUNT(*), MIN(si.safety_expires_at)
    INTO v_eligible, v_earliest
  FROM public.scan_items si
  JOIN public.scan_records sr ON sr.id = si.scan_record_id
  WHERE si.id = ANY(p_scan_item_ids)
    AND sr.merchant_id = p_merchant_id
    AND si.merchant_confirmed = TRUE
    AND si.load_id IS NULL
    AND si.disposition = 'pending';

  IF v_eligible IS DISTINCT FROM v_requested THEN
    RAISE EXCEPTION 'ITEMS_NOT_DECLARABLE'
      USING HINT = 'Every item must belong to this merchant, be confirmed, and not already be on a load';
  END IF;

  INSERT INTO public.loads (merchant_id, window_date, earliest_safety_expires_at, declared_by)
  VALUES (p_merchant_id, p_window_date, v_earliest, p_declared_by)
  RETURNING * INTO v_load;

  -- Valuation snapshot: latest effective row per category, at declaration time.
  INSERT INTO public.load_items (load_id, scan_item_id, est_lbs, fmv_per_lb_cents, basis_per_lb_cents)
  SELECT v_load.id, si.id, si.est_lbs, vt.fmv_per_lb_cents, vt.basis_per_lb_cents
  FROM public.scan_items si
  JOIN LATERAL (
    SELECT fmv_per_lb_cents, basis_per_lb_cents
    FROM public.valuation_table
    WHERE category_key = si.category_key AND effective_from <= NOW()
    ORDER BY effective_from DESC
    LIMIT 1
  ) vt ON TRUE
  WHERE si.id = ANY(p_scan_item_ids);

  SELECT COUNT(*) INTO v_snapshots FROM public.load_items WHERE load_id = v_load.id;
  IF v_snapshots IS DISTINCT FROM v_requested THEN
    RAISE EXCEPTION 'VALUATION_MISSING'
      USING HINT = 'No current valuation_table row for at least one item category';
  END IF;

  UPDATE public.scan_items SET load_id = v_load.id WHERE id = ANY(p_scan_item_ids);

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('load', v_load.id, 'load_declared', p_declared_by, 'merchant',
          jsonb_build_object(
            'merchant_id', p_merchant_id,
            'window_date', p_window_date,
            'item_count', v_requested,
            'earliest_safety_expires_at', v_earliest));

  RETURN v_load;
END;
$$;

REVOKE EXECUTE ON FUNCTION declare_load(UUID, UUID, DATE, UUID[]) FROM PUBLIC, anon, authenticated;
