-- 025_more_minted_supply_shards.sql
-- Bump minted_supply shard count 16 → 128 to further reduce row-lock contention.
-- At ~100-200 concurrent miners, 16 shards yields ~6-12 contenders per shard,
-- producing 1-2s lock waits and /mint 504s. 128 shards drops this to <2 per
-- shard at current load. SUPPLY_SHARD_COUNT in supplyShards.ts must match.

INSERT INTO app_counters (name, value, shard)
SELECT 'minted_supply', 0, gs FROM generate_series(16, 127) AS gs
ON CONFLICT (name, shard) DO NOTHING;
