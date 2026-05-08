-- 008_base_units.sql
-- Switch token + counter values from "integer RPOW" to "base units" where
-- 10^9 base units = 1 RPOW. Existing rows multiply by 10^9.

-- Widen tokens.value from INT to BIGINT, then scale.
ALTER TABLE tokens ALTER COLUMN value TYPE BIGINT;
UPDATE tokens SET value = value * 1000000000;

-- Widen app_counters.value to BIGINT, then scale all rows in place.
-- (We use a generic widening + scaling because app_counters may grow more
-- counter rows in future; only minted_supply is RPOW-denominated today.)
ALTER TABLE app_counters ALTER COLUMN value TYPE BIGINT;
UPDATE app_counters SET value = value * 1000000000;
