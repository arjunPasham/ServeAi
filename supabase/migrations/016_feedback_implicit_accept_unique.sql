-- 016_feedback_implicit_accept_unique.sql
-- Race-proof implicit-accept recording (dispute-window Inngest function).
-- The check-then-insert pattern can double-insert under concurrent retries;
-- DB-level uniqueness closes that hole regardless of application behavior.
-- The writer treats a 23505 unique violation on insert as success.

-- Dedupe first so index creation cannot fail on already-poisoned data
-- (keeps the earliest row per order).
DELETE FROM feedback_events a
USING feedback_events b
WHERE a.outcome = 'implicit_accept'
  AND b.outcome = 'implicit_accept'
  AND a.order_id = b.order_id
  AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_feedback_implicit_accept_per_order
  ON feedback_events (order_id)
  WHERE outcome = 'implicit_accept';
