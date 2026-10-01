-- 037_tokens_parent_idx.sql
-- DELETE FROM tokens has to prove no other row references the deleted id via
-- tokens.parent_token_id (self-referencing FK). The only index on that column
-- was tokens_minted_idx (WHERE parent_token_id IS NULL), which can't serve the
-- check, so every delete was a full sequential scan of tokens. At ~830M rows
-- that blows past the pool's 10s query_timeout: the wrap refund path (which
-- deletes the provisional change token) rolled back every time, leaving the
-- event PENDING and the user's source tokens LOCKED_FOR_BRIDGE.
--
-- Must be created CONCURRENTLY on production via psql BEFORE this migration
-- is deployed (same pattern as 021); `IF NOT EXISTS` then makes this a no-op
-- on prod and creates the index on dev/test.

CREATE INDEX IF NOT EXISTS tokens_parent_idx
  ON tokens(parent_token_id)
  WHERE parent_token_id IS NOT NULL;
