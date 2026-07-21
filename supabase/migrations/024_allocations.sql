-- 024_allocations.sql
-- Phase 2 (Match), Task 2. Three things, all guarded state transitions in the
-- house SECURITY DEFINER idiom (SET search_path='', fully-qualified public.*,
-- in-transaction audit_log write, REVOKE from PUBLIC/anon/authenticated):
--
--   1. allocations         — an offer of one load to one institution.
--   2. offer_load          — ops offers a declared load; donation lane is
--                            HARD-GATED on institution.npo_verified here (not
--                            just in the UI) — the Good Samaritan / 170(e)(3)
--                            compliance gate.
--   3. respond_to_offer    — institution accepts/declines the offer.
--   4. confirm_and_declare — folds confirmManifest's non-transactional
--                            write-then-declare_load into one atomic RPC
--                            (review I5 / tracked debt). It reuses declare_load
--                            internally, so the valuation-snapshot + load-create
--                            + audit logic lives in exactly one place.
--
-- The no-login inbound-preview token lives on allocations.public_view_token
-- (NOT on loads): the preview + its accept/decline are per-OFFER, so a
-- per-allocation token is unambiguous, cannot leak the manifest to a previously
-- declined institution on re-offer, and represents terminal states cleanly.
--
-- Idempotent; SQL-editor run is a PENDING USER action. Depends on 020
-- (loads/scan_items/declare_load, audit_log) and 023 (institutions).
--
-- FOLLOW-UP (not in this migration): a stale-offer sweep that flips
-- status='offered' past expires_at → 'expired' and frees its load back to
-- 'declared'. Until it exists, ops frees a stuck offer via withdrawOffer
-- (Task 3). respond_to_offer defensively raises OFFER_EXPIRED on a past-expiry
-- offer.

-- ─── ALLOCATIONS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS allocations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  load_id           UUID NOT NULL REFERENCES loads(id),
  institution_id    UUID NOT NULL REFERENCES institutions(id),
  lane              TEXT NOT NULL CHECK (lane IN ('donation','sale')),  -- copied from the load; a load's lane never mixes
  status            TEXT NOT NULL DEFAULT 'offered'
                    CHECK (status IN ('offered','accepted','declined','expired','withdrawn')),
  offered_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  offered_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at        TIMESTAMPTZ,
  decided_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  decline_reason    TEXT,
  expires_at        TIMESTAMPTZ NOT NULL,   -- offers auto-expire so a load can't sit un-actionable past its safety window
  -- No-login inbound-preview token (Task 4): unguessable, scoped to THIS offer.
  public_view_token UUID NOT NULL DEFAULT uuid_generate_v4() UNIQUE
);

-- At most one non-terminal (offered/accepted) allocation per load — the
-- double-offer guard; also the concurrency backstop behind offer_load's lock.
CREATE UNIQUE INDEX IF NOT EXISTS idx_allocations_one_active_per_load
  ON allocations (load_id) WHERE status IN ('offered','accepted');

CREATE INDEX IF NOT EXISTS idx_allocations_load        ON allocations (load_id);
CREATE INDEX IF NOT EXISTS idx_allocations_institution ON allocations (institution_id);

ALTER TABLE allocations ENABLE ROW LEVEL SECURITY;

-- Admins (ops console) manage all; an institution reads its own offers; every
-- write goes through the RPCs / service client. The no-login /inbound/[token]
-- view resolves via the service client (bypasses RLS) by token, so no anon
-- policy is needed. Mirrors the 019/020 posture.
DROP POLICY IF EXISTS "allocations_admin_all" ON allocations;
CREATE POLICY "allocations_admin_all" ON allocations
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

DROP POLICY IF EXISTS "allocations_select_institution" ON allocations;
CREATE POLICY "allocations_select_institution" ON allocations
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM institutions i
                 WHERE i.id = allocations.institution_id AND i.user_id = auth.uid()));

-- ─── RPC: offer a declared load to an institution ───────────────────────────
CREATE OR REPLACE FUNCTION offer_load(
  p_load_id        UUID,
  p_institution_id UUID,
  p_offered_by     UUID,
  p_expires_at     TIMESTAMPTZ
) RETURNS allocations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_load        public.loads;
  v_inst_status TEXT;
  v_inst_npo    BOOLEAN;
  v_alloc       public.allocations;
BEGIN
  -- Lock the load: two ops offering the same load serialize here; the loser
  -- then trips the active-allocation check below (or the unique index).
  SELECT * INTO v_load FROM public.loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LOAD_NOT_OFFERABLE' USING HINT = 'load not found';
  END IF;
  IF v_load.status NOT IN ('declared','matched') THEN
    RAISE EXCEPTION 'LOAD_NOT_OFFERABLE' USING HINT = 'load must be declared (or matched) to offer';
  END IF;

  IF EXISTS (SELECT 1 FROM public.allocations
             WHERE load_id = p_load_id AND status IN ('offered','accepted')) THEN
    RAISE EXCEPTION 'ALREADY_ALLOCATED' USING HINT = 'load already has an active allocation';
  END IF;

  -- Institution must be active; the DONATION lane additionally requires an
  -- npo_verified receiver (compliance gate, not a nicety).
  SELECT status, npo_verified INTO v_inst_status, v_inst_npo
  FROM public.institutions WHERE id = p_institution_id;
  IF NOT FOUND OR v_inst_status <> 'active' THEN
    RAISE EXCEPTION 'INSTITUTION_NOT_ELIGIBLE' USING HINT = 'institution not found or not active';
  END IF;
  IF v_load.lane = 'donation' AND v_inst_npo IS NOT TRUE THEN
    RAISE EXCEPTION 'INSTITUTION_NOT_ELIGIBLE'
      USING HINT = 'donation lane requires an npo_verified institution';
  END IF;

  INSERT INTO public.allocations (load_id, institution_id, lane, status, offered_at, offered_by, expires_at)
  VALUES (p_load_id, p_institution_id, v_load.lane, 'offered', NOW(), p_offered_by, p_expires_at)
  RETURNING * INTO v_alloc;

  UPDATE public.loads SET status = 'matched' WHERE id = p_load_id;

  -- Audit payload carries IDs/enums only — never signer/org PII (002 rule).
  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('allocation', v_alloc.id, 'load_offered', p_offered_by, 'admin',
          jsonb_build_object('load_id', p_load_id, 'institution_id', p_institution_id,
                             'lane', v_load.lane, 'expires_at', p_expires_at));

  RETURN v_alloc;
END;
$$;

REVOKE EXECUTE ON FUNCTION offer_load(UUID, UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- ─── RPC: institution accepts or declines an offer ──────────────────────────
CREATE OR REPLACE FUNCTION respond_to_offer(
  p_allocation_id  UUID,
  p_decision       TEXT,
  p_actor          UUID,
  p_decline_reason TEXT
) RETURNS allocations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_alloc public.allocations;
BEGIN
  IF p_decision NOT IN ('accepted','declined') THEN
    RAISE EXCEPTION 'INVALID_DECISION' USING HINT = 'decision must be accepted or declined';
  END IF;

  SELECT * INTO v_alloc FROM public.allocations WHERE id = p_allocation_id FOR UPDATE;
  IF NOT FOUND OR v_alloc.status <> 'offered' THEN
    RAISE EXCEPTION 'OFFER_NOT_PENDING' USING HINT = 'allocation is not an open offer';
  END IF;
  IF v_alloc.expires_at <= NOW() THEN
    RAISE EXCEPTION 'OFFER_EXPIRED' USING HINT = 'offer expired';
  END IF;

  IF p_decision = 'accepted' THEN
    -- Load stays 'matched'; Phase 3 route scheduling moves it to 'scheduled'.
    UPDATE public.allocations
      SET status = 'accepted', decided_at = NOW(), decided_by = p_actor
      WHERE id = p_allocation_id
      RETURNING * INTO v_alloc;
  ELSE
    UPDATE public.allocations
      SET status = 'declined', decided_at = NOW(), decided_by = p_actor, decline_reason = p_decline_reason
      WHERE id = p_allocation_id
      RETURNING * INTO v_alloc;
    -- Free the load to be re-offered.
    UPDATE public.loads SET status = 'declared' WHERE id = v_alloc.load_id;
  END IF;

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('allocation', v_alloc.id, 'offer_' || p_decision, p_actor, 'institution',
          jsonb_build_object('load_id', v_alloc.load_id, 'institution_id', v_alloc.institution_id,
                             'decision', p_decision));

  RETURN v_alloc;
END;
$$;

REVOKE EXECUTE ON FUNCTION respond_to_offer(UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ─── RPC: confirm a manifest and declare its load, atomically ───────────────
-- Consolidates confirmManifest's write-then-declare (was: update confirmed
-- items → insert manual items → close removed items not_shipped → declare_load,
-- across separate PostgREST calls) into ONE transaction (review I5). The
-- server action computes per-item temperature_sensitive + safety_expires_at
-- (via the tested computeSafetyExpiry in safety-window.ts, reading categories)
-- and passes them in p_items; this RPC persists them atomically and reuses
-- declare_load for the valuation snapshot + load creation + audit row.
--
-- p_items element: { scan_item_id: uuid|null, food_name, category_key, est_lbs,
--                    temperature_sensitive: bool, prepared_at: ts|null,
--                    safety_expires_at: ts|null }
CREATE OR REPLACE FUNCTION confirm_and_declare(
  p_merchant_id    UUID,
  p_declared_by    UUID,
  p_scan_record_id UUID,
  p_window_date    DATE,
  p_items          JSONB
) RETURNS loads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item         JSONB;
  v_scan_item_id UUID;
  v_new_id       UUID;
  v_tcs          BOOLEAN;
  v_confirmed    UUID[] := '{}';
  v_load         public.loads;
BEGIN
  -- Ownership: the scan record must belong to this merchant.
  PERFORM 1 FROM public.scan_records
  WHERE id = p_scan_record_id AND merchant_id = p_merchant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SCAN_NOT_FOUND' USING HINT = 'scan record not found for this merchant';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.categories WHERE category_key = v_item->>'category_key') THEN
      RAISE EXCEPTION 'UNKNOWN_CATEGORY' USING HINT = 'category_key not in categories';
    END IF;

    v_tcs          := (v_item->>'temperature_sensitive')::boolean;
    v_scan_item_id := NULLIF(v_item->>'scan_item_id', '')::uuid;

    IF v_scan_item_id IS NOT NULL THEN
      -- Must be an eligible (pending, unlinked) item of THIS scan record. The
      -- extra predicates also guard a concurrent confirm (double submit).
      UPDATE public.scan_items SET
        food_name             = v_item->>'food_name',
        category_key          = v_item->>'category_key',
        est_lbs               = (v_item->>'est_lbs')::numeric,
        temperature_sensitive = v_tcs,
        prepared_at           = CASE WHEN v_tcs THEN NULLIF(v_item->>'prepared_at', '')::timestamptz ELSE NULL END,
        safety_expires_at     = NULLIF(v_item->>'safety_expires_at', '')::timestamptz,
        merchant_confirmed    = TRUE,
        confirmed_at          = NOW()
      WHERE id = v_scan_item_id
        AND scan_record_id = p_scan_record_id
        AND load_id IS NULL
        AND disposition = 'pending';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'ITEM_NOT_IN_SCAN' USING HINT = 'scan_item not eligible for this scan record';
      END IF;
      v_confirmed := array_append(v_confirmed, v_scan_item_id);
    ELSE
      -- Merchant-added item the AI missed — ai_* fields record that origin.
      INSERT INTO public.scan_items (
        scan_record_id, category_key, food_name, est_lbs,
        ai_food_name, ai_confidence,
        temperature_sensitive, prepared_at, safety_expires_at,
        merchant_confirmed, confirmed_at
      ) VALUES (
        p_scan_record_id, v_item->>'category_key', v_item->>'food_name', (v_item->>'est_lbs')::numeric,
        '(added manually)', 0,
        v_tcs,
        CASE WHEN v_tcs THEN NULLIF(v_item->>'prepared_at', '')::timestamptz ELSE NULL END,
        NULLIF(v_item->>'safety_expires_at', '')::timestamptz,
        TRUE, NOW()
      )
      RETURNING id INTO v_new_id;
      v_confirmed := array_append(v_confirmed, v_new_id);
    END IF;
  END LOOP;

  -- Items the merchant removed from the manifest: closed out not_shipped so the
  -- disposition dataset never dangles. (If v_confirmed is empty, this targets
  -- all pending items, but declare_load then raises EMPTY_LOAD and the whole
  -- transaction — including this close-out — rolls back.)
  UPDATE public.scan_items SET disposition = 'not_shipped', disposition_at = NOW()
  WHERE scan_record_id = p_scan_record_id
    AND load_id IS NULL
    AND disposition = 'pending'
    AND NOT (id = ANY (v_confirmed));

  -- Declare the load in the SAME transaction — reuse the audited RPC (valuation
  -- snapshot + load create + link + audit row). callable here because this
  -- function runs as its definer, which retains EXECUTE despite the REVOKE.
  v_load := public.declare_load(p_merchant_id, p_declared_by, p_window_date, v_confirmed);

  RETURN v_load;
END;
$$;

REVOKE EXECUTE ON FUNCTION confirm_and_declare(UUID, UUID, UUID, DATE, JSONB) FROM PUBLIC, anon, authenticated;
