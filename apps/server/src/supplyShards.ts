// Sharding constant for the minted_supply counter. Writes spread across
// SUPPLY_SHARD_COUNT rows in app_counters so concurrent mints/burns don't
// serialize on a single row lock. Reads SUM across all shards.
// See docs/superpowers/specs/2026-05-11-sharded-minted-supply-design.md.

export const SUPPLY_SHARD_COUNT = 128;

/** Returns a uniformly random shard index in [0, SUPPLY_SHARD_COUNT). */
export function pickSupplyShard(): number {
  return Math.floor(Math.random() * SUPPLY_SHARD_COUNT);
}
