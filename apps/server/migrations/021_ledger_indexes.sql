-- Speed up GET /ledger. The tokens table has grown into the tens of millions
-- of rows on prod and the aggregate sums (`SUM(value) WHERE state=...`) were
-- full sequential scans, busting nginx's upstream timeout.
--
-- Partial indexes covering `value` keyed by the two states the ledger reads
-- let the planner do (mostly) index-only scans. Heap fetches still happen
-- on rows whose visibility map bit isn't set yet — that resolves on the
-- next autovacuum.
--
-- These indexes were already created CONCURRENTLY on production via psql
-- before this migration landed; `IF NOT EXISTS` makes the migration idempotent
-- (it's a no-op on prod, creates them on dev/test).

CREATE INDEX IF NOT EXISTS tokens_valid_value_idx   ON tokens(value) WHERE state = 'VALID';
CREATE INDEX IF NOT EXISTS tokens_wrapped_value_idx ON tokens(value) WHERE state = 'WRAPPED';
