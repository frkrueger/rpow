-- 023_supply_counter_trigger.sql
-- Maintain circulating_supply_base_units and wrapped_supply_base_units
-- counters via a Postgres trigger on `tokens`. Eliminates the 30M-row
-- SUM(tokens WHERE state=X) hot path in /ledger.
--
-- See docs/superpowers/specs/2026-05-11-maintained-supply-counters-design.md.

-- 1. Lock tokens table so the SUM backfill is consistent. SHARE blocks
--    writes (INSERT/UPDATE) but allows concurrent reads. Brief window:
--    on prod (~30M rows) the SUM should complete in 30-90s.
LOCK TABLE tokens IN SHARE MODE;

-- 2. Seed the counter rows. Shard 0 carries the backfill amount.
INSERT INTO app_counters (name, value, shard)
SELECT 'circulating_supply_base_units', COALESCE(SUM(value), 0), 0
FROM tokens WHERE state = 'VALID'
ON CONFLICT (name, shard) DO NOTHING;

INSERT INTO app_counters (name, value, shard)
SELECT 'wrapped_supply_base_units', COALESCE(SUM(value), 0), 0
FROM tokens WHERE state = 'WRAPPED'
ON CONFLICT (name, shard) DO NOTHING;

-- Sibling shards 1..15 at value=0 for both counters.
INSERT INTO app_counters (name, value, shard)
SELECT 'circulating_supply_base_units', 0, gs FROM generate_series(1, 15) AS gs
ON CONFLICT (name, shard) DO NOTHING;

INSERT INTO app_counters (name, value, shard)
SELECT 'wrapped_supply_base_units', 0, gs FROM generate_series(1, 15) AS gs
ON CONFLICT (name, shard) DO NOTHING;

-- 3. Trigger function: adjust counters on every token write.
CREATE OR REPLACE FUNCTION adjust_supply_counters() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  s SMALLINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state = 'VALID' THEN
      s := floor(random() * 16)::SMALLINT;
      UPDATE app_counters SET value = value + NEW.value
        WHERE name = 'circulating_supply_base_units' AND shard = s;
    ELSIF NEW.state = 'WRAPPED' THEN
      s := floor(random() * 16)::SMALLINT;
      UPDATE app_counters SET value = value + NEW.value
        WHERE name = 'wrapped_supply_base_units' AND shard = s;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.state IS DISTINCT FROM NEW.state THEN
    -- Subtract OLD.value from old state's counter
    IF OLD.state = 'VALID' THEN
      s := floor(random() * 16)::SMALLINT;
      UPDATE app_counters SET value = value - OLD.value
        WHERE name = 'circulating_supply_base_units' AND shard = s;
    ELSIF OLD.state = 'WRAPPED' THEN
      s := floor(random() * 16)::SMALLINT;
      UPDATE app_counters SET value = value - OLD.value
        WHERE name = 'wrapped_supply_base_units' AND shard = s;
    END IF;
    -- Add NEW.value to new state's counter
    IF NEW.state = 'VALID' THEN
      s := floor(random() * 16)::SMALLINT;
      UPDATE app_counters SET value = value + NEW.value
        WHERE name = 'circulating_supply_base_units' AND shard = s;
    ELSIF NEW.state = 'WRAPPED' THEN
      s := floor(random() * 16)::SMALLINT;
      UPDATE app_counters SET value = value + NEW.value
        WHERE name = 'wrapped_supply_base_units' AND shard = s;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

-- 4. Bind the trigger.
DROP TRIGGER IF EXISTS tokens_adjust_supply ON tokens;
CREATE TRIGGER tokens_adjust_supply
  AFTER INSERT OR UPDATE ON tokens
  FOR EACH ROW
  EXECUTE FUNCTION adjust_supply_counters();
