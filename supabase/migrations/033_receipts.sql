-- 033_receipts.sql
-- v3 donation receipt (Task 3), DONATION LANE ONLY. A slimmed Phase 5: a
-- donation receipt (market value + cost basis + the IRC 170(e)(3) enhanced
-- deduction) generated from the recipient's confirm. The sale lane gets NO
-- receipt — a discounted sale is recovered revenue, not a charitable gift.
--
-- Values are FROZEN AT ISSUE from the load_items valuation SNAPSHOTS (the ones
-- declare_load copied at declaration) — this RPC computes the totals from
-- load_items and NEVER re-reads valuation_table, so an IRS-facing figure stays
-- reproducible even after the price table changes.
--
-- IRC 170(e)(3) enhanced deduction, PER ITEM from the snapshot:
--   basis + 1/2 * max(0, fmv - basis), capped at 2 * basis
-- summed across the load. (The half-appreciation is ROUND-ed to the cent to
-- match the pure src/lib/receipt.ts used for the UI preview + unit tests.)
--
-- HARD GATES (all four, or it raises): lane='donation'; load delivered +
-- recipient-confirmed (deliveries.acknowledged_at set); donee institution
-- npo_verified; not already issued. p_template_approved is RECORDED on the row
-- (the receipt/valuation wording needs CPA/counsel sign-off before real use —
-- the action passes the feature flag; an un-approved receipt is a worksheet,
-- not a claimable document). House idiom: SECURITY DEFINER, search_path='',
-- qualified public.*, load lock, audit (money totals are not PII; signer name
-- is NOT audited), REVOKE. Idempotent; SQL-editor run is a PENDING USER action.
-- Depends on 031/032 (deliveries), 024 (allocations), 023 (institutions),
-- 020 (loads/load_items), 019 (merchants).

CREATE TABLE IF NOT EXISTS receipts (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  load_id                 UUID NOT NULL UNIQUE REFERENCES loads(id),
  merchant_id             UUID NOT NULL REFERENCES merchants(id),
  recipient_id            UUID NOT NULL REFERENCES institutions(id),
  issued_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signer_name             TEXT,                 -- donee acknowledgment signer (copied from the confirm)
  acknowledged_at         TIMESTAMPTZ,          -- when the recipient confirmed receipt
  -- Frozen totals (integer cents). Never re-derived from valuation_table.
  fmv_total_cents         INTEGER NOT NULL CHECK (fmv_total_cents >= 0),
  basis_total_cents       INTEGER NOT NULL CHECK (basis_total_cents >= 0),
  enhanced_deduction_cents INTEGER NOT NULL CHECK (enhanced_deduction_cents >= 0),
  method_version          TEXT NOT NULL,        -- e.g. '170e3-v1' — the calc/template version
  template_approved       BOOLEAN NOT NULL DEFAULT FALSE,  -- CPA/counsel sign-off gate
  pdf_key                 TEXT,                 -- private-bucket path; set after generation
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_receipts_merchant ON receipts (merchant_id, issued_at DESC);

ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;

-- Admin all; the merchant reads its own receipts; the recipient institution
-- reads its own (when it has an auth user). Writes via the RPC / service client.
DROP POLICY IF EXISTS "receipts_admin_all" ON receipts;
CREATE POLICY "receipts_admin_all" ON receipts
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

DROP POLICY IF EXISTS "receipts_select_merchant" ON receipts;
CREATE POLICY "receipts_select_merchant" ON receipts
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM merchants m WHERE m.id = receipts.merchant_id AND m.user_id = auth.uid()));

DROP POLICY IF EXISTS "receipts_select_recipient" ON receipts;
CREATE POLICY "receipts_select_recipient" ON receipts
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM institutions i WHERE i.id = receipts.recipient_id AND i.user_id = auth.uid()));

-- ─── RPC: issue a donation receipt (freeze totals from the snapshots) ───────
CREATE OR REPLACE FUNCTION issue_receipt(
  p_load_id           UUID,
  p_method_version    TEXT,
  p_template_approved BOOLEAN,
  p_actor             UUID
) RETURNS receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_load        public.loads;
  v_delivery    public.deliveries;
  v_recipient   UUID;
  v_npo         BOOLEAN;
  v_fmv         INTEGER;
  v_basis       INTEGER;
  v_enhanced    INTEGER;
  v_count       INTEGER;
  v_receipt     public.receipts;
BEGIN
  SELECT * INTO v_load FROM public.loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LOAD_NOT_FOUND' USING HINT = 'no such load';
  END IF;
  IF v_load.lane <> 'donation' THEN
    RAISE EXCEPTION 'NOT_DONATION_LANE' USING HINT = 'only donation-lane loads get a receipt (sale = recovered revenue)';
  END IF;
  IF v_load.status NOT IN ('delivered','closed') THEN
    RAISE EXCEPTION 'NOT_DELIVERED' USING HINT = 'load must be delivered + recipient-confirmed to issue a receipt';
  END IF;

  SELECT * INTO v_delivery FROM public.deliveries WHERE load_id = p_load_id;
  IF NOT FOUND OR v_delivery.acknowledged_at IS NULL THEN
    RAISE EXCEPTION 'NOT_CONFIRMED' USING HINT = 'recipient has not confirmed receipt';
  END IF;

  SELECT institution_id INTO v_recipient FROM public.allocations WHERE id = v_delivery.allocation_id;
  SELECT npo_verified INTO v_npo FROM public.institutions WHERE id = v_recipient;
  IF v_npo IS NOT TRUE THEN
    RAISE EXCEPTION 'DONEE_NOT_VERIFIED' USING HINT = 'donee must be a verified 501(c)(3)';
  END IF;

  IF EXISTS (SELECT 1 FROM public.receipts WHERE load_id = p_load_id) THEN
    RAISE EXCEPTION 'ALREADY_ISSUED' USING HINT = 'a receipt already exists for this load';
  END IF;

  -- Freeze totals from the load_items SNAPSHOT (never valuation_table).
  -- 170(e)(3) per item: LEAST(basis + round(max(0,fmv-basis)/2), 2*basis).
  WITH items AS (
    SELECT ROUND(li.fmv_per_lb_cents  * li.est_lbs)::bigint AS fmv_c,
           ROUND(li.basis_per_lb_cents * li.est_lbs)::bigint AS basis_c
    FROM public.load_items li
    WHERE li.load_id = p_load_id
  )
  SELECT COUNT(*),
         COALESCE(SUM(fmv_c), 0),
         COALESCE(SUM(basis_c), 0),
         COALESCE(SUM(LEAST(basis_c + ROUND(GREATEST(fmv_c - basis_c, 0)::numeric / 2)::bigint, 2 * basis_c)), 0)
    INTO v_count, v_fmv, v_basis, v_enhanced
  FROM items;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'EMPTY_LOAD' USING HINT = 'load has no line items to value';
  END IF;

  INSERT INTO public.receipts (
    load_id, merchant_id, recipient_id, signer_name, acknowledged_at,
    fmv_total_cents, basis_total_cents, enhanced_deduction_cents, method_version, template_approved
  ) VALUES (
    p_load_id, v_load.merchant_id, v_recipient, v_delivery.signer_name, v_delivery.acknowledged_at,
    v_fmv, v_basis, v_enhanced, p_method_version, COALESCE(p_template_approved, FALSE)
  )
  RETURNING * INTO v_receipt;

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('receipt', v_receipt.id, 'receipt_issued', p_actor, 'admin',
          jsonb_build_object('load_id', p_load_id, 'recipient_id', v_recipient,
                             'fmv_total_cents', v_fmv, 'basis_total_cents', v_basis,
                             'enhanced_deduction_cents', v_enhanced,
                             'template_approved', COALESCE(p_template_approved, FALSE)));

  RETURN v_receipt;
END;
$$;

REVOKE EXECUTE ON FUNCTION issue_receipt(UUID, TEXT, BOOLEAN, UUID) FROM PUBLIC, anon, authenticated;

-- ─── RPC: attach the generated PDF key (post-generation) ────────────────────
-- The action generates the worksheet PDF from the frozen totals, uploads it to
-- the private bucket, then records the key here. Split from issue_receipt so the
-- totals freeze atomically before the (fallible, out-of-transaction) PDF step.
CREATE OR REPLACE FUNCTION set_receipt_pdf(
  p_receipt_id UUID,
  p_pdf_key    TEXT,
  p_actor      UUID
) RETURNS receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_receipt public.receipts;
BEGIN
  UPDATE public.receipts SET pdf_key = p_pdf_key WHERE id = p_receipt_id
  RETURNING * INTO v_receipt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECEIPT_NOT_FOUND' USING HINT = 'no such receipt';
  END IF;

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('receipt', p_receipt_id, 'receipt_pdf_attached', p_actor, 'admin',
          jsonb_build_object('has_pdf', p_pdf_key IS NOT NULL));

  RETURN v_receipt;
END;
$$;

REVOKE EXECUTE ON FUNCTION set_receipt_pdf(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
