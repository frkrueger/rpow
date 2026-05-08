-- 009_pending_transfers_base_units.sql
-- After 008 widened tokens.value + app_counters.value to bigint base units,
-- pending_transfers.amount and transfers.amount must follow the same
-- convention to keep cap math consistent. Existing rows were created with
-- integer-RPOW amounts; multiply by 10^9.
ALTER TABLE pending_transfers ALTER COLUMN amount TYPE BIGINT;
UPDATE pending_transfers SET amount = amount * 1000000000;

ALTER TABLE transfers ALTER COLUMN amount TYPE BIGINT;
UPDATE transfers SET amount = amount * 1000000000;
