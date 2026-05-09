-- 011_wrap_change_tokens.sql
-- SRPOW wrap previously required exact-sum: the user could only wrap an
-- amount that some subset of their tokens summed to exactly. With
-- heterogeneous denominations (1-RPOW grandfathered tokens + 0.001 RPOW
-- mining rewards + …) that's almost always impossible.
--
-- New model: lock a token subset whose sum >= target, mint `target`
-- SRPOW on Solana, and issue a *change* token for (sum - target) back to
-- the user. Both source tokens and change token are linked to the same
-- srpow_wrap_events row via wrap_event_id; `is_change` distinguishes them
-- so confirm/refund know which to wrap vs which to release/discard.
--
-- Lifecycle:
--   Phase 1 (lock): source tokens LOCKED_FOR_BRIDGE; change token inserted
--                   LOCKED_FOR_BRIDGE with is_change=true.
--   Phase 2 confirmed: source -> WRAPPED; change -> VALID.
--   Phase 2 refund:    source -> VALID (wrap_event_id cleared);
--                      change row is DELETEd (it was never user-visible).

ALTER TABLE tokens ADD COLUMN is_change BOOLEAN NOT NULL DEFAULT FALSE;

-- Quick lookup: "all change tokens linked to a given wrap event".
CREATE INDEX tokens_wrap_change_idx
  ON tokens(wrap_event_id)
  WHERE wrap_event_id IS NOT NULL AND is_change = TRUE;
