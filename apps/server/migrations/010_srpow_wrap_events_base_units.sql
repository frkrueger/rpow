-- 010_srpow_wrap_events_base_units.sql
-- Widen srpow_wrap_events.amount from INT (integer RPOW) to BIGINT (base units),
-- then scale existing rows by 10^9 to match the base-unit token denomination
-- introduced in migration 008. The CHECK (amount > 0) holds for bigints unchanged.

ALTER TABLE srpow_wrap_events ALTER COLUMN amount TYPE BIGINT;
UPDATE srpow_wrap_events SET amount = amount * 1000000000;
