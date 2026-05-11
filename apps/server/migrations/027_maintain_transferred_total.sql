-- 027_maintain_transferred_total.sql
-- Maintain total_transferred_base_units in app_counters (sharded 128 ways)
-- via a trigger on transfers. Eliminates the full-table SUM(transfers) hot
-- path in /ledger that became slow as the transfers table grew.
--
-- Same pattern as migration 023 (circulating/wrapped via tokens trigger),
-- and migrations 025/026 (128 shards). Transfers are append-only, so the
-- trigger only handles INSERT.

-- Wrap the entire migration in a transaction so LOCK TABLE works under
-- `psql -f` (autocommit mode). Without BEGIN/COMMIT, LOCK TABLE errors
-- and an INSERT can sneak in between the SUM backfill and the trigger
-- creation, leaving the counter under-counted.
BEGIN;

-- 1. Lock transfers briefly so backfill is consistent. SHARE blocks
--    INSERT/UPDATE; reads still work. /send INSERTs queue for ~100ms.
LOCK TABLE transfers IN SHARE MODE;

-- 2. Trigger function — increment a random shard on INSERT.
CREATE OR REPLACE FUNCTION adjust_transferred_total() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  s SMALLINT;
BEGIN
  s := floor(random() * 128)::SMALLINT;
  UPDATE app_counters SET value = value + NEW.amount
    WHERE name = 'total_transferred_base_units' AND shard = s;
  RETURN NEW;
END;
$$;

-- 3. Drop existing trigger (idempotent re-runs) so it doesn't fire during
--    the resync below.
DROP TRIGGER IF EXISTS transfers_adjust_total ON transfers;

-- 4. Resync: wipe any pre-existing rows and seed shard 0 with the true
--    SUM. Idempotent — safe to re-run.
DELETE FROM app_counters WHERE name='total_transferred_base_units';
INSERT INTO app_counters (name, value, shard)
  SELECT 'total_transferred_base_units', COALESCE(SUM(amount), 0), 0 FROM transfers;
INSERT INTO app_counters (name, value, shard)
  SELECT 'total_transferred_base_units', 0, gs FROM generate_series(1, 127) AS gs;

-- 5. Bind the trigger.
CREATE TRIGGER transfers_adjust_total
  AFTER INSERT ON transfers
  FOR EACH ROW
  EXECUTE FUNCTION adjust_transferred_total();

COMMIT;
