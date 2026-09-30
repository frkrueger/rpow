-- 022_shard_minted_supply.sql
-- Spread minted_supply writes across N=16 shard rows to break single-row
-- lock contention. Reads SUM(value); writes target a random shard.
-- See docs/superpowers/specs/2026-05-11-sharded-minted-supply-design.md.

-- 1. Add the shard column. Default 0 so existing rows logically become shard 0.
ALTER TABLE app_counters ADD COLUMN IF NOT EXISTS shard SMALLINT NOT NULL DEFAULT 0;

-- 2. Move the PK from (name) to (name, shard). The composite PK accommodates
-- multiple rows per counter name (one per shard).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_counters_pkey') THEN
    ALTER TABLE app_counters DROP CONSTRAINT app_counters_pkey;
  END IF;
END$$;
ALTER TABLE app_counters ADD PRIMARY KEY (name, shard);

-- 3. Seed 15 sibling rows for minted_supply (shard 1..15, value=0). The
-- existing row keeps its current value at shard=0. SUM across all 16 shards
-- equals the original value. Idempotent via ON CONFLICT DO NOTHING.
INSERT INTO app_counters (name, value, shard)
SELECT 'minted_supply', 0, gs FROM generate_series(1, 15) AS gs
ON CONFLICT (name, shard) DO NOTHING;
