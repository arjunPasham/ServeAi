-- 025_withdraw_offer.sql
-- Phase 2 (Match), Task 3 — closes the expired/ignored-offer stranding gap from
-- the Checkpoint-2 review with two guarded state-transition RPCs. Same house
-- idiom as offer_load/respond_to_offer (024): SECURITY DEFINER, SET search_path='',
-- fully-qualified public.*, in-transaction audit_log (IDs/enums only, no PII),
-- REVOKE from PUBLIC/anon/authenticated. Callable by the server/Inngest via the
-- service client (like declare_load). Idempotent; no new table. Depends on 024.

-- ─── RPC: manually withdraw an active offer (ops escape) ────────────────────
-- The manual way to unstick a load whose offer was ignored (or expired before
-- the sweep ran). Sets the allocation → 'withdrawn' and frees the load back to
-- 'declared' so it can be re-offered. Locks the allocation then the load.
CREATE OR REPLACE FUNCTION withdraw_offer(
  p_allocation_id UUID,
  p_actor         UUID
) RETURNS loads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_alloc public.allocations;
  v_load  public.loads;
BEGIN
  SELECT * INTO v_alloc FROM public.allocations WHERE id = p_allocation_id FOR UPDATE;
  IF NOT FOUND OR v_alloc.status NOT IN ('offered','accepted') THEN
    RAISE EXCEPTION 'OFFER_NOT_ACTIVE' USING HINT = 'only an active (offered/accepted) offer can be withdrawn';
  END IF;

  -- Lock the load before mutating it (offer_load also takes the load lock).
  PERFORM 1 FROM public.loads WHERE id = v_alloc.load_id FOR UPDATE;

  UPDATE public.allocations
    SET status = 'withdrawn', decided_at = NOW(), decided_by = p_actor
    WHERE id = p_allocation_id;

  UPDATE public.loads SET status = 'declared'
    WHERE id = v_alloc.load_id
    RETURNING * INTO v_load;

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('allocation', v_alloc.id, 'offer_withdrawn', p_actor, 'admin',
          jsonb_build_object('load_id', v_alloc.load_id, 'institution_id', v_alloc.institution_id,
                             'prior_status', v_alloc.status));

  RETURN v_load;
END;
$$;

REVOKE EXECUTE ON FUNCTION withdraw_offer(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- ─── RPC: sweep stale offers ────────────────────────────────────────────────
-- Flips every offer still 'offered' past its expires_at → 'expired' and frees
-- its load back to 'declared' (so an institution that simply ignores an offer
-- can't strand the load past its safety window). Called on a schedule by the
-- Inngest stale-offer sweep. FOR UPDATE SKIP LOCKED so the sweep never contends
-- with a concurrent respond_to_offer/withdraw_offer on the same row — a locked
-- offer is simply handled on the next run. Returns how many it expired.
CREATE OR REPLACE FUNCTION expire_stale_offers()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_alloc public.allocations;
  v_count INTEGER := 0;
BEGIN
  FOR v_alloc IN
    SELECT * FROM public.allocations
    WHERE status = 'offered' AND expires_at <= NOW()
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.allocations SET status = 'expired' WHERE id = v_alloc.id;
    -- Only free a load this offer still holds matched (defensive against a load
    -- that moved on independently).
    UPDATE public.loads SET status = 'declared'
      WHERE id = v_alloc.load_id AND status = 'matched';

    INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
    VALUES ('allocation', v_alloc.id, 'offer_expired', NULL, 'system',
            jsonb_build_object('load_id', v_alloc.load_id, 'institution_id', v_alloc.institution_id));

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION expire_stale_offers() FROM PUBLIC, anon, authenticated;
