-- 031_deliveries.sql
-- v3 Delivery-log (Task 1) — the records-only successor to the CUT Phase 3/4
-- (Routes/Custody). FoodLink owns no fleet and runs no delivery: a matched load
-- advances by RECORDING what the two businesses do. This migration adds ONE
-- table + three guarded state-transition RPCs. It does NOT route, dispatch,
-- broker couriers, track temperature, or take a commission — none of that
-- exists in v3.
--
-- House idiom (020/024/025/027/030): SECURITY DEFINER, SET search_path='',
-- fully-qualified public.*, row locks on the load, in-transaction audit_log
-- (IDs/enums only), REVOKE from PUBLIC/anon/authenticated. Idempotent;
-- SQL-editor run is a PENDING USER action. Depends on 020 (loads/scan_items),
-- 024 (allocations), 023 (institutions), 019 (merchants), 002 (audit_log).
--
-- window_blown is a permanent FLAG, never a block: v3 RECORDS a blown safety
-- window (picked up / delivered past the load's earliest_safety_expires_at); it
-- does not refuse the handoff. Enforcement is not FoodLink's job in this model.
--
-- Uber Direct is a selectable, LOGGED method only. "Merchant-connected dispatch
-- on the merchant's own Uber account" is a documented follow-up, NOT built here.

CREATE TABLE IF NOT EXISTS deliveries (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- One delivery record per load (a load has one accepted allocation and one
  -- handoff). allocation_id ties it to the recipient (institution) for RLS.
  load_id            UUID NOT NULL UNIQUE REFERENCES loads(id),
  allocation_id      UUID NOT NULL REFERENCES allocations(id),
  method             TEXT NOT NULL
                     CHECK (method IN ('merchant_delivery','pickup','uber_direct','local_courier','other')),
  responsible_party  TEXT NOT NULL CHECK (responsible_party IN ('donor','recipient')),
  scheduled_at       TIMESTAMPTZ,   -- when the method was set (load -> scheduled)
  picked_up_at       TIMESTAMPTZ,   -- stamped at mark_picked_up
  delivered_at       TIMESTAMPTZ,   -- stamped at mark_delivered
  window_blown       BOOLEAN NOT NULL DEFAULT FALSE,  -- permanent flag; never a block
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deliveries_allocation ON deliveries (allocation_id);

DROP TRIGGER IF EXISTS deliveries_updated_at ON deliveries;
CREATE TRIGGER deliveries_updated_at
  BEFORE UPDATE ON deliveries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;

-- Admins manage all; the load's merchant reads its own; the recipient
-- institution reads its own (when it has an auth user — the no-login token
-- path in Task 2 reads via the service client). Writes go through the RPCs /
-- service client only. Mirrors the 020/024 posture.
DROP POLICY IF EXISTS "deliveries_admin_all" ON deliveries;
CREATE POLICY "deliveries_admin_all" ON deliveries
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin'));

DROP POLICY IF EXISTS "deliveries_select_merchant" ON deliveries;
CREATE POLICY "deliveries_select_merchant" ON deliveries
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM loads l
                 JOIN merchants m ON m.id = l.merchant_id
                 WHERE l.id = deliveries.load_id AND m.user_id = auth.uid()));

DROP POLICY IF EXISTS "deliveries_select_recipient" ON deliveries;
CREATE POLICY "deliveries_select_recipient" ON deliveries
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM allocations a
                 JOIN institutions i ON i.id = a.institution_id
                 WHERE a.id = deliveries.allocation_id AND i.user_id = auth.uid()));

-- ─── RPC: set the delivery method (matched -> scheduled) ────────────────────
-- The merchant picks a method + who's responsible, creating the delivery record
-- and advancing the load. Requires an ACCEPTED allocation (the recipient agreed)
-- on a matched load owned by this merchant. Records the choice; brokers nothing.
CREATE OR REPLACE FUNCTION set_delivery_method(
  p_load_id           UUID,
  p_merchant_id       UUID,
  p_allocation_id     UUID,
  p_method            TEXT,
  p_responsible_party TEXT,
  p_notes             TEXT,
  p_actor             UUID
) RETURNS deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_load     public.loads;
  v_alloc    public.allocations;
  v_delivery public.deliveries;
BEGIN
  SELECT * INTO v_load FROM public.loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND OR v_load.merchant_id <> p_merchant_id THEN
    RAISE EXCEPTION 'LOAD_NOT_FOUND' USING HINT = 'no such load for this merchant';
  END IF;
  IF v_load.status <> 'matched' THEN
    RAISE EXCEPTION 'LOAD_NOT_SCHEDULABLE' USING HINT = 'load must be matched to schedule a delivery';
  END IF;

  -- The recipient must have ACCEPTED — a load can sit 'matched' on a still-open
  -- offer, which is not yet a committed handoff.
  SELECT * INTO v_alloc FROM public.allocations WHERE id = p_allocation_id;
  IF NOT FOUND OR v_alloc.load_id <> p_load_id OR v_alloc.status <> 'accepted' THEN
    RAISE EXCEPTION 'OFFER_NOT_ACCEPTED' USING HINT = 'allocation must be an accepted offer on this load';
  END IF;

  IF EXISTS (SELECT 1 FROM public.deliveries WHERE load_id = p_load_id) THEN
    RAISE EXCEPTION 'ALREADY_SCHEDULED' USING HINT = 'this load already has a delivery record';
  END IF;

  INSERT INTO public.deliveries (load_id, allocation_id, method, responsible_party, scheduled_at, notes)
  VALUES (p_load_id, p_allocation_id, p_method, p_responsible_party, NOW(), p_notes)
  RETURNING * INTO v_delivery;

  UPDATE public.loads SET status = 'scheduled' WHERE id = p_load_id;

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('load', p_load_id, 'delivery_scheduled', p_actor, 'merchant',
          jsonb_build_object('allocation_id', p_allocation_id, 'method', p_method,
                             'responsible_party', p_responsible_party));

  RETURN v_delivery;
END;
$$;

REVOKE EXECUTE ON FUNCTION set_delivery_method(UUID, UUID, UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;

-- ─── RPC: mark picked up (scheduled -> picked_up) ───────────────────────────
-- Stamps picked_up_at and RECORDS window_blown if the food left past its
-- earliest safety window. Never blocks — the flag is permanent.
CREATE OR REPLACE FUNCTION mark_picked_up(
  p_load_id     UUID,
  p_merchant_id UUID,
  p_actor       UUID
) RETURNS deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_load     public.loads;
  v_delivery public.deliveries;
  v_blown    BOOLEAN;
BEGIN
  SELECT * INTO v_load FROM public.loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND OR v_load.merchant_id <> p_merchant_id THEN
    RAISE EXCEPTION 'LOAD_NOT_FOUND' USING HINT = 'no such load for this merchant';
  END IF;
  IF v_load.status <> 'scheduled' THEN
    RAISE EXCEPTION 'LOAD_NOT_PICKUPABLE' USING HINT = 'load must be scheduled to mark picked up';
  END IF;

  v_blown := v_load.earliest_safety_expires_at IS NOT NULL
             AND NOW() > v_load.earliest_safety_expires_at;

  UPDATE public.deliveries
    SET picked_up_at = NOW(), window_blown = window_blown OR v_blown
    WHERE load_id = p_load_id
    RETURNING * INTO v_delivery;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_DELIVERY' USING HINT = 'no delivery record — set the method first';
  END IF;

  UPDATE public.loads SET status = 'picked_up' WHERE id = p_load_id;

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('load', p_load_id, 'delivery_picked_up', p_actor, 'merchant',
          jsonb_build_object('window_blown', v_delivery.window_blown));

  RETURN v_delivery;
END;
$$;

REVOKE EXECUTE ON FUNCTION mark_picked_up(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;

-- ─── RPC: mark delivered (scheduled|picked_up -> delivered) ─────────────────
-- Stamps delivered_at. Callable from 'scheduled' too (some methods — e.g. a
-- recipient pickup — have no distinct pickup event). Re-evaluates window_blown
-- (OR only — never unset) so a late handoff is recorded regardless of path.
-- p_actor is nullable: the recipient may confirm via the no-login token path
-- (Task 2), like respond_to_offer(p_actor=null).
CREATE OR REPLACE FUNCTION mark_delivered(
  p_load_id UUID,
  p_actor   UUID
) RETURNS deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_load     public.loads;
  v_delivery public.deliveries;
  v_blown    BOOLEAN;
BEGIN
  SELECT * INTO v_load FROM public.loads WHERE id = p_load_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LOAD_NOT_FOUND' USING HINT = 'no such load';
  END IF;
  IF v_load.status NOT IN ('scheduled','picked_up') THEN
    RAISE EXCEPTION 'LOAD_NOT_DELIVERABLE' USING HINT = 'load must be scheduled or picked up to mark delivered';
  END IF;

  v_blown := v_load.earliest_safety_expires_at IS NOT NULL
             AND NOW() > v_load.earliest_safety_expires_at;

  UPDATE public.deliveries
    SET delivered_at = NOW(), window_blown = window_blown OR v_blown
    WHERE load_id = p_load_id
    RETURNING * INTO v_delivery;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_DELIVERY' USING HINT = 'no delivery record — set the method first';
  END IF;

  UPDATE public.loads SET status = 'delivered' WHERE id = p_load_id;

  INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor_id, actor_role, payload)
  VALUES ('load', p_load_id, 'delivery_delivered', p_actor, 'recipient',
          jsonb_build_object('window_blown', v_delivery.window_blown));

  RETURN v_delivery;
END;
$$;

REVOKE EXECUTE ON FUNCTION mark_delivered(UUID, UUID) FROM PUBLIC, anon, authenticated;
