# Sharded `minted_supply` Counter — Design

**Date:** 2026-05-11
**Goal:** eliminate row-level lock contention on `app_counters.minted_supply` so concurrent `/mint` calls don't serialize globally.

## Problem

Every `/mint` does `UPDATE app_counters SET value = value + $reward WHERE name='minted_supply' ...`. Postgres holds the row lock from the UPDATE until COMMIT — and only one transaction can hold a row lock at a time, so all mints serialize on this single row.

Observed at peak today: 143 active Postgres workers all queued on this UPDATE, exhausting the 144-connection pool, starving `/send` and other unrelated routes (504 timeouts from nginx).

Removing the explicit `SELECT … FOR UPDATE` (the previous "fix") helped briefly but the contention moved straight to the implicit row lock on the UPDATE itself — same bottleneck, different statement.

## Non-goals

- Per-account daily cap — that's keyed on a different row (`daily_mint_buckets(email, day_utc)`), naturally low-contention.
- Longshot / gladiator / trivia counter decrements — these also hit `minted_supply` but at far lower rates than `/mint`. Sharding helps them too as a side effect.
- Eliminating *all* lock contention everywhere — only the hot-path counter.

## Design

### Shard the counter into N rows

Add a `shard SMALLINT` column to `app_counters`. The existing `name` becomes `(name, shard)` as the composite primary key. The `minted_supply` row is replaced by N rows (`shard = 0..N-1`), each holding 1/N of the supply.

```sql
ALTER TABLE app_counters DROP CONSTRAINT app_counters_pkey;
ALTER TABLE app_counters ADD COLUMN shard SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE app_counters ADD PRIMARY KEY (name, shard);

-- Backfill: keep existing rows as shard=0, create N-1 empty siblings.
-- For minted_supply specifically, we choose N=16 (rationale below).
INSERT INTO app_counters (name, value, shard)
SELECT 'minted_supply', 0, gs
FROM generate_series(1, 15) AS gs;
```

### Write path: pick a random shard

Replace the current single-row UPDATE in `apps/server/src/routes/mint.ts`:

```ts
const shard = Math.floor(Math.random() * 16);
const mintResult = await c.query(
  `WITH inc AS (
     UPDATE app_counters SET value = value + $2::bigint
     WHERE name='minted_supply' AND shard = $8
       AND (SELECT COALESCE(SUM(value), 0) FROM app_counters WHERE name='minted_supply')
           + $2::bigint <= $1::bigint
     RETURNING 1
   )
   INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
   SELECT $3, $4, $5::bigint, 'VALID', $6, $7 FROM inc
   RETURNING id`,
  [capBaseUnits.toString(), reward.toString(), tokenId, s.email, reward.toString(), issuedAt, sig, shard],
);
```

The cap check uses `SUM(value)` across all 16 shards. The UPDATE only locks the chosen shard row. Concurrent mints picking different shards run in parallel.

**Why N=16:** rule of thumb is "shards ≥ peak concurrent writers / desired-queue-depth-per-shard." At peak we saw ~150 concurrent /mint calls. With N=16 and uniform random shard selection, average queue depth per shard is ~10 — manageable and well below the previous all-serialized state. N=32 is also fine; N=64 starts to hurt the read path (SUM cost).

Decrement sites (longshot LOSE, gladiator burn, trivia burn) likewise pick a random shard.

### Read path: SUM across shards

Every site that currently reads `value FROM app_counters WHERE name='minted_supply'` becomes:

```sql
SELECT COALESCE(SUM(value), 0)::text FROM app_counters WHERE name='minted_supply'
```

Read sites to update:
- `apps/server/src/routes/ledger.ts:33`
- `apps/server/src/routes/me.ts:73`
- `apps/server/src/routes/challenge.ts:25`
- `apps/server/src/routes/mint.ts:97` (the `mintedBaseUnits` read used for reward computation)

All read paths benefit from an index on `(name, shard)` which already exists as the PK.

### Cap check inside the increment UPDATE

The atomic cap check (`AND value + reward <= cap`) must now compare the *total* across shards, not the single shard's value. Use a subquery as shown above. This costs 16 row reads but no extra locking (`SELECT` doesn't take row locks on `app_counters` here).

Two concurrent mints to *different* shards both pass the cap subquery while supply is below cap; both UPDATE their shard; both succeed. Same correctness profile as the current single-row design at the cap.

At the exact cap boundary, the same race exists today: two concurrent mints both pass the cap check, both increment, one ends up "over cap" by one reward. The current design has this. Our sharded design has the same. Bounded over-mint: ≤ N × reward at the cap (≤ 16 × 0.01 = 0.16 RPOW total). Negligible.

### Halving-boundary drift

The reward is computed from `mintedBaseUnits = SUM(value)` read outside any lock (status quo after the earlier `FOR UPDATE` removal). Concurrent mints across a halving boundary can both read the pre-halving supply and both mint at the old rate. This is the same drift we accept today — bounded to ~0.05 RPOW total across the chain's life. Sharding does not change this.

### Operator queries (off-hot-path)

Out-of-band readers (admin scripts, the stats page) all use the same SUM pattern. No special handling needed.

### Migration is online-safe

The migration runs on a live DB: ALTER TABLE adds a column with DEFAULT 0, then the INSERT seeds 15 sibling rows. No long lock. After migration:

1. Old code reading `value FROM app_counters WHERE name='minted_supply'` would see only shard=0 (which has the old aggregate value initially) — **correct during the transition**.
2. New code reading `SUM(value)` matches reality.
3. New code writing to random shards spreads contention.

Deploy sequence:
1. Apply migration (idempotent: skip if `shard` column exists).
2. Wait one connection-recycle cycle so all workers see the new schema.
3. Roll the new code (one worker at a time via systemd or full cluster restart).

Rollback: revert to old code; reads via single-row work fine because shard=0 holds the cumulative-at-migration-time value. Writes still land on shard=0 only. Same correctness, lost contention reduction. Migration revert (DROP COLUMN shard, restore PK) is also straightforward.

## Verification

1. **Unit:** existing schedule + mint tests should keep passing with no logic changes. Add one test that issues 100 concurrent mints with the new sharded code and asserts the final total minted matches the sum of expected rewards.

2. **Load test on staging:** ab/wrk against `/mint` at 200 concurrent requests. Compare timing: pre-shard median latency vs post-shard. Expect a >5× drop in p99 latency for /mint and **near-zero impact on /send latency** (the actual user-visible bug).

3. **Postgres lock observation:** during the load test, query `pg_locks` and confirm no single shard has >~10 waiters at any time.

4. **Reconciliation script:** after deploy, run `SELECT name, shard, value FROM app_counters WHERE name='minted_supply' ORDER BY shard`. All 16 shards should grow roughly evenly over time (the random distribution converges).

## Files to create/modify

**New:**
- `apps/server/migrations/016_shard_app_counters.sql` (or whatever the next number is at PR time)

**Modified:**
- `apps/server/src/routes/mint.ts` — pick random shard, update UPDATE to filter by shard, change read to SUM.
- `apps/server/src/routes/ledger.ts` — change read to SUM.
- `apps/server/src/routes/me.ts` — change read to SUM.
- `apps/server/src/routes/challenge.ts` — change read to SUM.
- `apps/server/src/routes/longshot.ts` (decrement sites) — pick random shard.
- `apps/server/src/routes/gladiator/flip.ts` + `sessions.ts` — pick random shard on decrement.
- `apps/server/src/routes/trivia/matches.ts` + `sessions.ts` — pick random shard on decrement.
- `apps/server/src/gladiator/sweeper.ts` — if it touches the counter, same shard pattern.

**Tests:**
- `apps/server/tests/shardedSupply.test.ts` — new: covers random-shard write distribution + SUM correctness + cap enforcement under concurrency.

## Out of scope (deferred)

- **Postgres `mint_reward_for(supply, cap)` PL/pgSQL function** for fully atomic reward-at-supply calculation. Would close the halving-boundary drift entirely but is a larger change; not needed for this perf fix.
- **Counter caching at the Node process level.** Could reduce read load further but adds complexity and the read path isn't the bottleneck.
- **Postgres logical replication / read replicas** for stats queries. Different problem.

## Estimated effort

- Migration + write/read site updates: ~3 hours
- Tests: ~1.5 hours
- Staging load test + deploy: ~1 hour
- Total: half a day

The stopgap (`perf(mint): 3s statement_timeout + 503 MINT_BUSY on contention`, commit 9d76dc8) keeps the site running while this is implemented and reviewed.
