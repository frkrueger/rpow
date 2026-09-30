-- 026_bump_supply_counter_trigger_shards.sql
-- The trigger from migration 023 still shards circulating_supply_base_units
-- and wrapped_supply_base_units across only 16 rows. Under heavy /mint load
-- the trigger UPDATE on those counters becomes the new lock-contention
-- hotspot — visible as 'idle in transaction' pool saturation and /challenge
-- 504s while /mint itself responds fine after migration 025.
--
-- Bumps both maintained counters to 128 shards and updates the trigger
-- function to pick across all 128.

-- 1. Add shards 16..127 for both counters (idempotent).
INSERT INTO app_counters (name, value, shard)
SELECT 'circulating_supply_base_units', 0, gs FROM generate_series(16, 127) AS gs
ON CONFLICT (name, shard) DO NOTHING;

INSERT INTO app_counters (name, value, shard)
SELECT 'wrapped_supply_base_units', 0, gs FROM generate_series(16, 127) AS gs
ON CONFLICT (name, shard) DO NOTHING;

-- 2. Replace trigger function with 128-way sharding. CREATE OR REPLACE is
--    atomic and existing transactions in flight finish on the old function.
CREATE OR REPLACE FUNCTION adjust_supply_counters() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  s SMALLINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state = 'VALID' THEN
      s := floor(random() * 128)::SMALLINT;
      UPDATE app_counters SET value = value + NEW.value
        WHERE name = 'circulating_supply_base_units' AND shard = s;
    ELSIF NEW.state = 'WRAPPED' THEN
      s := floor(random() * 128)::SMALLINT;
      UPDATE app_counters SET value = value + NEW.value
        WHERE name = 'wrapped_supply_base_units' AND shard = s;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.state IS DISTINCT FROM NEW.state THEN
    IF OLD.state = 'VALID' THEN
      s := floor(random() * 128)::SMALLINT;
      UPDATE app_counters SET value = value - OLD.value
        WHERE name = 'circulating_supply_base_units' AND shard = s;
    ELSIF OLD.state = 'WRAPPED' THEN
      s := floor(random() * 128)::SMALLINT;
      UPDATE app_counters SET value = value - OLD.value
        WHERE name = 'wrapped_supply_base_units' AND shard = s;
    END IF;
    IF NEW.state = 'VALID' THEN
      s := floor(random() * 128)::SMALLINT;
      UPDATE app_counters SET value = value + NEW.value
        WHERE name = 'circulating_supply_base_units' AND shard = s;
    ELSIF NEW.state = 'WRAPPED' THEN
      s := floor(random() * 128)::SMALLINT;
      UPDATE app_counters SET value = value + NEW.value
        WHERE name = 'wrapped_supply_base_units' AND shard = s;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;
