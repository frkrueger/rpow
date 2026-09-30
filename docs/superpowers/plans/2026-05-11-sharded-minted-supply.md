# Sharded `minted_supply` Counter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spread `minted_supply` writes across 16 shard rows so concurrent `/mint`, `/longshot`, `/gladiator`, `/trivia`, and `/amm` writes don't serialize on a single Postgres row lock — eliminating the multi-second queue that starves `/send` and times out `/mint` under load.

**Architecture:** Add a `shard SMALLINT` column to `app_counters`, change the PK to `(name, shard)`, seed 15 additional shard rows for `minted_supply` (total N=16). All read sites switch from `SELECT value` to `SELECT SUM(value)`. All write sites pick a random shard and add `AND shard = $N` to their UPDATE. The cap check becomes a subquery against the SUM. Spec at `docs/superpowers/specs/2026-05-11-sharded-minted-supply-design.md`.

**Tech Stack:** Postgres 17, Fastify 4, `pg` 8, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-11-sharded-minted-supply-design.md`

---

## File map

**New:**
- `apps/server/migrations/022_shard_minted_supply.sql` — composite PK + 15 seed rows.
- `apps/server/src/supplyShards.ts` — constant `SUPPLY_SHARD_COUNT = 16` + `pickSupplyShard()` helper.
- `apps/server/tests/supplyShards.test.ts` — unit tests for the helper.
- `apps/server/tests/shardedSupply.test.ts` — integration tests: writes spread across shards, reads aggregate correctly, concurrent writes don't lose data.

**Modified (read sites — change `SELECT value` to `SELECT SUM(value)`):**
- `apps/server/src/routes/mint.ts:111`
- `apps/server/src/routes/ledger.ts:33`
- `apps/server/src/routes/me.ts:79`
- `apps/server/src/routes/challenge.ts:25`

**Modified (write sites — add `AND shard = $N`, cap check via subquery):**
- `apps/server/src/routes/mint.ts:155` — increment with cap
- `apps/server/src/routes/longshot.ts:113` (increment) + `148` (decrement)
- `apps/server/src/routes/gladiator/flip.ts:140` (decrement) + `163`, `201` (increments)
- `apps/server/src/routes/gladiator/sessions.ts:130` (decrement) + `266` (increment)
- `apps/server/src/gladiator/sweeper.ts:65` — increment
- `apps/server/src/routes/trivia/matches.ts:236` — decrement
- `apps/server/src/routes/trivia/resolve.ts:157`, `199` — increments
- `apps/server/src/routes/trivia/sessions.ts:116` (decrement) + `237` (increment)
- `apps/server/src/routes/amm/seed.ts:71` — decrement
- `apps/server/src/routes/amm/swap.ts:220` (increment) + `248` (decrement)

**Untouched:**
- `apps/server/src/routes/claim.ts` — read-only on supply (already noted in code).
- The `long_shot_house_pnl_base_units` counter in `longshot.ts` — different row, not in scope.

---

## Task 1: Migration — composite PK + 15 seed shards

**Files:**
- Create: `apps/server/migrations/022_shard_minted_supply.sql`

- [ ] **Step 1: Write the migration**

Create `apps/server/migrations/022_shard_minted_supply.sql`:

```sql
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
```

- [ ] **Step 2: Verify migration applies cleanly under the test harness**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- authRequest 2>&1 | tail -10`

Expected: PASS. `makeTestApp()` calls `runMigrations()` which picks up `022_*.sql`. If the file has a syntax error, the harness fails in `beforeEach`.

- [ ] **Step 3: Commit**

```bash
git add apps/server/migrations/022_shard_minted_supply.sql
git commit -m "migration: shard minted_supply across 16 rows (composite PK)"
```

---

## Task 2: `supplyShards.ts` helper + unit tests

**Files:**
- Create: `apps/server/src/supplyShards.ts`
- Create: `apps/server/tests/supplyShards.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/supplyShards.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SUPPLY_SHARD_COUNT, pickSupplyShard } from '../src/supplyShards.js';

describe('supplyShards', () => {
  it('SUPPLY_SHARD_COUNT is 16', () => {
    expect(SUPPLY_SHARD_COUNT).toBe(16);
  });

  it('pickSupplyShard returns 0..15', () => {
    for (let i = 0; i < 1000; i++) {
      const s = pickSupplyShard();
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(16);
      expect(Number.isInteger(s)).toBe(true);
    }
  });

  it('pickSupplyShard distribution covers all 16 shards over 10k draws', () => {
    const hits = new Set<number>();
    for (let i = 0; i < 10_000; i++) hits.add(pickSupplyShard());
    expect(hits.size).toBe(16);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- supplyShards`

Expected: FAIL with import error (module doesn't exist).

- [ ] **Step 3: Implement the helper**

Create `apps/server/src/supplyShards.ts`:

```ts
// Sharding constant for the minted_supply counter. Writes spread across
// SUPPLY_SHARD_COUNT rows in app_counters so concurrent mints/burns don't
// serialize on a single row lock. Reads SUM across all shards.
// See docs/superpowers/specs/2026-05-11-sharded-minted-supply-design.md.

export const SUPPLY_SHARD_COUNT = 16;

/** Returns a uniformly random shard index in [0, SUPPLY_SHARD_COUNT). */
export function pickSupplyShard(): number {
  return Math.floor(Math.random() * SUPPLY_SHARD_COUNT);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- supplyShards`

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/supplyShards.ts apps/server/tests/supplyShards.test.ts
git commit -m "feat(supply): add SUPPLY_SHARD_COUNT + pickSupplyShard helper"
```

---

## Task 3: Read sites — `SELECT value` → `SELECT SUM(value)`

**Files:**
- Modify: `apps/server/src/routes/mint.ts:111`
- Modify: `apps/server/src/routes/ledger.ts:33`
- Modify: `apps/server/src/routes/me.ts:79`
- Modify: `apps/server/src/routes/challenge.ts:25`

All four sites currently read the single-row counter. After migration, the row is now 16 shards summing to the same value. The reads must aggregate.

- [ ] **Step 1: Update `apps/server/src/routes/ledger.ts`**

Find the line:
```ts
        `SELECT value::text FROM app_counters WHERE name='minted_supply'`,
```

Replace with:
```ts
        `SELECT COALESCE(SUM(value), 0)::text AS value FROM app_counters WHERE name='minted_supply'`,
```

Note the alias `AS value` so the returned row shape stays `{ value: string }` and existing destructuring works without changes.

- [ ] **Step 2: Update `apps/server/src/routes/me.ts`**

Find:
```ts
        `SELECT value::text AS value FROM app_counters WHERE name='minted_supply'`,
```

Replace with:
```ts
        `SELECT COALESCE(SUM(value), 0)::text AS value FROM app_counters WHERE name='minted_supply'`,
```

- [ ] **Step 3: Update `apps/server/src/routes/challenge.ts`**

Find:
```ts
          `SELECT value::text FROM app_counters WHERE name='minted_supply'`,
```

Replace with:
```ts
          `SELECT COALESCE(SUM(value), 0)::text AS value FROM app_counters WHERE name='minted_supply'`,
```

- [ ] **Step 4: Update `apps/server/src/routes/mint.ts`**

Find:
```ts
        `SELECT value::text FROM app_counters WHERE name='minted_supply'`,
```

Replace with:
```ts
        `SELECT COALESCE(SUM(value), 0)::text AS value FROM app_counters WHERE name='minted_supply'`,
```

- [ ] **Step 5: Run affected route tests to confirm reads still work**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- "tests/(ledger|challenge|me|mint)"`

Expected: PASS for ledger and challenge tests. **Pre-existing failures in `mint.test.ts` (2) and `me.test.ts` (1) are unrelated baseline drift** (schedule reward value mismatch and a stale login pattern — both predate this branch). Don't try to fix.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/ledger.ts apps/server/src/routes/me.ts apps/server/src/routes/challenge.ts apps/server/src/routes/mint.ts
git commit -m "perf(supply): aggregate read sites switch to SUM across shards"
```

---

## Task 4: Mint increment — write to a random shard with sum-cap-check

**Files:**
- Modify: `apps/server/src/routes/mint.ts` (the increment CTE around line 155)

The current pattern locks-then-updates a single row. After this change, the UPDATE filters by a random shard, and the cap check becomes a subquery summing all shards.

- [ ] **Step 1: Add the import + read the current block**

At the top of `apps/server/src/routes/mint.ts`, add:

```ts
import { pickSupplyShard } from '../supplyShards.js';
```

Find the existing block (current lines around 148-159):
```ts
      const mintResult = await c.query(
        `WITH inc AS (
           UPDATE app_counters SET value = value + $2::bigint
           WHERE name='minted_supply' AND value + $2::bigint <= $1::bigint
           RETURNING 1
         )
         INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
         SELECT $3, $4, $5::bigint, 'VALID', $6, $7 FROM inc
         RETURNING id`,
        [capBaseUnits.toString(), reward.toString(), tokenId, s.email, reward.toString(), issuedAt, sig],
      );
```

- [ ] **Step 2: Replace with the sharded version**

```ts
      const supplyShard = pickSupplyShard();
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
        [capBaseUnits.toString(), reward.toString(), tokenId, s.email, reward.toString(), issuedAt, sig, supplyShard],
      );
```

Two changes: added `AND shard = $8` (targets the chosen shard) and replaced the cap check's left-hand side with a SUM subquery. The trailing parameter binding is `supplyShard`.

- [ ] **Step 3: Run mint tests**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- "tests/mint"`

Expected: same pre-existing 2 failures as before (schedule reward + login pattern). No NEW failures.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/mint.ts
git commit -m "perf(mint): increment a random minted_supply shard"
```

---

## Task 5: Longshot — increment (WIN) + decrement (LOSE)

**Files:**
- Modify: `apps/server/src/routes/longshot.ts:113` (WIN increment) and `148` (LOSE decrement)

- [ ] **Step 1: Add the import**

At the top of `apps/server/src/routes/longshot.ts`, add:

```ts
import { pickSupplyShard } from '../supplyShards.js';
```

- [ ] **Step 2: Replace the WIN-path increment (around line 111-115)**

Find:
```ts
          const supplyResult = await c.query(
            `UPDATE app_counters SET value = value + $1::bigint
             WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
            [payout.toString(), capBaseUnits.toString()],
          );
```

Replace with:
```ts
          const supplyShard = pickSupplyShard();
          const supplyResult = await c.query(
            `UPDATE app_counters SET value = value + $1::bigint
             WHERE name = 'minted_supply' AND shard = $3
               AND (SELECT COALESCE(SUM(value), 0) FROM app_counters WHERE name = 'minted_supply')
                   + $1::bigint <= $2::bigint`,
            [payout.toString(), capBaseUnits.toString(), supplyShard],
          );
```

- [ ] **Step 3: Replace the LOSE-path decrement (around line 146-149)**

Find:
```ts
          await c.query(
            `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
            [stake.toString()],
          );
```

Replace with:
```ts
          await c.query(
            `UPDATE app_counters SET value = value - $1::bigint
             WHERE name = 'minted_supply' AND shard = $2`,
            [stake.toString(), pickSupplyShard()],
          );
```

The decrement has no cap to check — just shard targeting.

- [ ] **Step 4: Run longshot tests**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- "tests/longshotRoutes"`

Expected: PASS (or same pre-existing failures only). No NEW failures.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/longshot.ts
git commit -m "perf(longshot): shard minted_supply writes on WIN/LOSE"
```

---

## Task 6: Gladiator — flip + sessions + sweeper

**Files:**
- Modify: `apps/server/src/routes/gladiator/flip.ts:140` (decrement), `163`, `201` (increments)
- Modify: `apps/server/src/routes/gladiator/sessions.ts:130` (decrement), `266` (increment)
- Modify: `apps/server/src/gladiator/sweeper.ts:65` (increment)

- [ ] **Step 1: Add imports**

In all three files, at the top, add:
```ts
import { pickSupplyShard } from '../../supplyShards.js';  // adjust depth: ../../ for routes/gladiator, ../ for gladiator/
```

Note: `gladiator/sweeper.ts` lives in `apps/server/src/gladiator/` (one level deeper than `routes/`), so the import path is `'../supplyShards.js'`.

`apps/server/src/routes/gladiator/flip.ts` lives in `apps/server/src/routes/gladiator/` (two levels deeper), so the import path is `'../../supplyShards.js'`.

`apps/server/src/routes/gladiator/sessions.ts` — same depth, same `'../../supplyShards.js'`.

- [ ] **Step 2: Edit `gladiator/flip.ts:140` (decrement, no cap)**

Find:
```ts
          `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
```

Replace with:
```ts
          `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply' AND shard = $2`,
```

Update the parameter array of that query to append `pickSupplyShard()` as the new `$2` argument. (The original passed only one parameter; now passes two.)

- [ ] **Step 3: Edit `gladiator/flip.ts:163` (increment with cap)**

Find:
```ts
             WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
```

Replace the surrounding query so the WHERE clause becomes:
```ts
             WHERE name = 'minted_supply' AND shard = $3
               AND (SELECT COALESCE(SUM(value), 0) FROM app_counters WHERE name = 'minted_supply')
                   + $1::bigint <= $2::bigint`,
```

Append `pickSupplyShard()` as the new `$3` argument in the parameter array.

- [ ] **Step 4: Edit `gladiator/flip.ts:201` (increment with cap)**

Same pattern as Step 3 — the second increment at line ~201 has the same shape. Make the same edit.

- [ ] **Step 5: Edit `gladiator/sessions.ts:130` (decrement, no cap)**

Same pattern as Step 2.

- [ ] **Step 6: Edit `gladiator/sessions.ts:266` (increment with cap)**

Same pattern as Step 3.

- [ ] **Step 7: Edit `gladiator/sweeper.ts:65` (increment with cap)**

Same pattern as Step 3.

- [ ] **Step 8: Run gladiator tests**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- "tests/gladiator"`

Expected: PASS or same pre-existing failures. No NEW failures.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/routes/gladiator/ apps/server/src/gladiator/
git commit -m "perf(gladiator): shard minted_supply writes (flip/sessions/sweeper)"
```

---

## Task 7: Trivia — matches + resolve + sessions

**Files:**
- Modify: `apps/server/src/routes/trivia/matches.ts:236` (decrement)
- Modify: `apps/server/src/routes/trivia/sessions.ts:116` (decrement), `237` (increment)
- Modify: `apps/server/src/trivia/resolve.ts:157`, `199` (increments)

- [ ] **Step 1: Add imports**

`apps/server/src/routes/trivia/matches.ts` and `apps/server/src/routes/trivia/sessions.ts` are at `apps/server/src/routes/trivia/`, so:
```ts
import { pickSupplyShard } from '../../supplyShards.js';
```

`apps/server/src/trivia/resolve.ts` is at `apps/server/src/trivia/`, so:
```ts
import { pickSupplyShard } from '../supplyShards.js';
```

- [ ] **Step 2: Edit `trivia/matches.ts:236` (decrement)**

Find:
```ts
          `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
```

Replace with:
```ts
          `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply' AND shard = $2`,
```

Append `pickSupplyShard()` to the parameter array as `$2`.

- [ ] **Step 3: Edit `trivia/sessions.ts:116` (decrement)**

Same pattern as Step 2.

- [ ] **Step 4: Edit `trivia/sessions.ts:237` (increment with cap)**

Find the WHERE in the existing increment:
```ts
             WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
```

Replace with:
```ts
             WHERE name = 'minted_supply' AND shard = $3
               AND (SELECT COALESCE(SUM(value), 0) FROM app_counters WHERE name = 'minted_supply')
                   + $1::bigint <= $2::bigint`,
```

Append `pickSupplyShard()` to the parameter array as `$3`.

- [ ] **Step 5: Edit `trivia/resolve.ts:157` (increment with cap)**

Same pattern as Step 4.

- [ ] **Step 6: Edit `trivia/resolve.ts:199` (increment with cap)**

Same pattern as Step 4.

- [ ] **Step 7: Run trivia tests**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- "tests/trivia"`

Expected: PASS or same pre-existing failures. No NEW failures.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/routes/trivia/ apps/server/src/trivia/
git commit -m "perf(trivia): shard minted_supply writes (matches/sessions/resolve)"
```

---

## Task 8: AMM — seed + swap

**Files:**
- Modify: `apps/server/src/routes/amm/seed.ts:71` (decrement)
- Modify: `apps/server/src/routes/amm/swap.ts:220` (increment), `248` (decrement)

- [ ] **Step 1: Add imports**

Both files at `apps/server/src/routes/amm/` — depth 2:
```ts
import { pickSupplyShard } from '../../supplyShards.js';
```

- [ ] **Step 2: Edit `amm/seed.ts:71` (decrement)**

Find:
```ts
          `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
```

Replace with:
```ts
          `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply' AND shard = $2`,
```

Append `pickSupplyShard()` to the parameter array as `$2`.

- [ ] **Step 3: Edit `amm/swap.ts:220` (increment with cap)**

Find:
```ts
           WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
```

Replace with:
```ts
           WHERE name = 'minted_supply' AND shard = $3
             AND (SELECT COALESCE(SUM(value), 0) FROM app_counters WHERE name = 'minted_supply')
                 + $1::bigint <= $2::bigint`,
```

Append `pickSupplyShard()` to the parameter array as `$3`.

- [ ] **Step 4: Edit `amm/swap.ts:248` (decrement)**

Same pattern as Step 2.

- [ ] **Step 5: Run AMM tests**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- "tests/amm"`

Expected: PASS or same pre-existing failures. No NEW failures.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/amm/
git commit -m "perf(amm): shard minted_supply writes (seed/swap)"
```

---

## Task 9: Integration test — concurrent writes are correct + spread

**Files:**
- Create: `apps/server/tests/shardedSupply.test.ts`

This test directly exercises the sharded counter: writes 100 concurrent increments and 100 concurrent decrements, asserts the SUM equals the expected delta and that all 16 shards received at least one write (probabilistic — very high).

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/shardedSupply.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { pickSupplyShard, SUPPLY_SHARD_COUNT } from '../src/supplyShards.js';

describe('sharded minted_supply', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('migration seeds SUPPLY_SHARD_COUNT rows for minted_supply', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { rows } = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app_counters WHERE name='minted_supply'`,
    );
    expect(rows[0].n).toBe(SUPPLY_SHARD_COUNT);
  });

  it('initial SUM across all shards equals the seeded total (0 in tests)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { rows } = await ctx.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS total FROM app_counters WHERE name='minted_supply'`,
    );
    expect(rows[0].total).toBe('0');
  });

  it('100 concurrent shard-targeted increments produce correct SUM', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const delta = 1000n;
    const writes = Array.from({ length: 100 }, () => {
      const shard = pickSupplyShard();
      return ctx.pool.query(
        `UPDATE app_counters SET value = value + $1::bigint WHERE name='minted_supply' AND shard = $2`,
        [delta.toString(), shard],
      );
    });
    await Promise.all(writes);

    const { rows } = await ctx.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS total FROM app_counters WHERE name='minted_supply'`,
    );
    expect(rows[0].total).toBe((100n * delta).toString());
  });

  it('100 concurrent writes spread across all 16 shards (probabilistic)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const writes = Array.from({ length: 200 }, () => {
      const shard = pickSupplyShard();
      return ctx.pool.query(
        `UPDATE app_counters SET value = value + 1 WHERE name='minted_supply' AND shard = $1`,
        [shard],
      );
    });
    await Promise.all(writes);

    const { rows } = await ctx.pool.query<{ shard: number; value: string }>(
      `SELECT shard, value::text FROM app_counters WHERE name='minted_supply' ORDER BY shard`,
    );
    expect(rows).toHaveLength(SUPPLY_SHARD_COUNT);
    // With 200 draws across 16 buckets, probability of any bucket being empty
    // is (15/16)^200 ≈ 2.4e-6. Effectively zero flake risk.
    const nonEmpty = rows.filter(r => r.value !== '0').length;
    expect(nonEmpty).toBe(SUPPLY_SHARD_COUNT);
  });

  it('sum-cap-check correctly rejects increment that would exceed total cap', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Set total supply to 100 (across some shards), cap = 110, attempt +20 → must reject.
    await ctx.pool.query(`UPDATE app_counters SET value = 60 WHERE name='minted_supply' AND shard = 0`);
    await ctx.pool.query(`UPDATE app_counters SET value = 40 WHERE name='minted_supply' AND shard = 5`);

    const shard = pickSupplyShard();
    const res = await ctx.pool.query(
      `UPDATE app_counters SET value = value + 20
       WHERE name='minted_supply' AND shard = $1
         AND (SELECT COALESCE(SUM(value), 0) FROM app_counters WHERE name='minted_supply') + 20 <= 110`,
      [shard],
    );
    expect(res.rowCount).toBe(0);

    const { rows } = await ctx.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS total FROM app_counters WHERE name='minted_supply'`,
    );
    expect(rows[0].total).toBe('100');
  });

  it('sum-cap-check correctly accepts increment that stays under total cap', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`UPDATE app_counters SET value = 50 WHERE name='minted_supply' AND shard = 0`);

    const shard = pickSupplyShard();
    const res = await ctx.pool.query(
      `UPDATE app_counters SET value = value + 30
       WHERE name='minted_supply' AND shard = $1
         AND (SELECT COALESCE(SUM(value), 0) FROM app_counters WHERE name='minted_supply') + 30 <= 100`,
      [shard],
    );
    expect(res.rowCount).toBe(1);

    const { rows } = await ctx.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS total FROM app_counters WHERE name='minted_supply'`,
    );
    expect(rows[0].total).toBe('80');
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- shardedSupply`

Expected: PASS for all 6 tests.

- [ ] **Step 3: Commit**

```bash
git add apps/server/tests/shardedSupply.test.ts
git commit -m "test: sharded minted_supply correctness under concurrency"
```

---

## Task 10: Operator runbook + deploy notes

**Files:**
- Create: `docs/runbook/sharded-supply-rollback.md`

This is the rollback procedure if the sharded code needs to be reverted. Data has been distributed across 16 shards; reverting requires aggregating back into shard=0 first or reads will be wrong.

- [ ] **Step 1: Write the runbook**

Create `docs/runbook/sharded-supply-rollback.md`:

```markdown
# Sharded minted_supply — Rollback Runbook

If the sharded-counter code needs to be reverted, the data must be aggregated back into shard=0 first. Otherwise the rolled-back code (which reads `value` from shard=0 only) will see only 1/16 of the supply.

## Rollback procedure

1. **Stop both server processes.** This prevents writes during the aggregation.
   ```bash
   sudo systemctl stop rpow-server.service rpow-auth.service
   ```

2. **Aggregate all shards into shard=0.**
   ```bash
   sudo -u postgres psql rpow <<'SQL'
   BEGIN;
   UPDATE app_counters
   SET value = (SELECT SUM(value) FROM app_counters WHERE name='minted_supply')
   WHERE name='minted_supply' AND shard = 0;
   DELETE FROM app_counters WHERE name='minted_supply' AND shard > 0;
   COMMIT;
   SQL
   ```

3. **Verify the aggregate matches the pre-rollback total:**
   ```bash
   sudo -u postgres psql rpow -c "SELECT shard, value FROM app_counters WHERE name='minted_supply'"
   ```
   Expect a single row with `shard=0` and the cumulative `value`.

4. **Deploy the previous (non-sharded) code.**
   ```bash
   sudo -u rpow bash -c "cd /opt/rpow/repo && git checkout <previous-sha> && npm run build --workspace @rpow/server"
   ```
   The non-sharded code reads `WHERE name='minted_supply'` which now matches the single shard=0 row — correct.

5. **Optional: drop the shard column** (only if confident the rollback is permanent). The composite PK can stay; the migration is idempotent on re-apply.

6. **Restart services.**
   ```bash
   sudo systemctl start rpow-auth.service rpow-server.service
   ```

## When to roll back

- Mint rate drops noticeably after deploy (we expect the opposite — load drops).
- Reconciliation shows supply differs from `SUM(value::bigint) FROM tokens WHERE state IN ('VALID', 'WRAPPED')` by more than the historical drift baseline.
- Any single shard's value goes very negative (one shard receiving a hot stream of decrements while increments distribute to others). This is a sign that the random shard pick on decrement is bunching — investigate but not necessarily a rollback trigger; SUM is still correct.

## Verification post-deploy (no rollback)

Within 10 minutes of deploy, run:
```bash
sudo -u postgres psql rpow -c "SELECT shard, value FROM app_counters WHERE name='minted_supply' ORDER BY shard"
```
Expect 16 rows. Initially most non-zero traffic lands on shard=0 (the seed) and the others have value=0. After ~1000 mints across shards, all 16 should have non-zero values, roughly equal.

Then check Postgres lock waits:
```bash
sudo -u postgres psql rpow -c "SELECT count(*) FROM pg_stat_activity WHERE state='active' AND query LIKE '%minted_supply%'"
```
Should be at most a handful (< 20), not the 130+ that triggered this work.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbook/sharded-supply-rollback.md
git commit -m "docs(runbook): sharded minted_supply rollback procedure"
```

---

## Task 11: Build + full test suite verification

**Files:** none new

- [ ] **Step 1: Full server build**

Run: `npm run build --workspace @rpow/shared && npm run build --workspace @rpow/server 2>&1 | tail -15`

Expected: no NEW TypeScript errors. Pre-existing errors from `@rpow/solana-bridge` not finding modules are out of scope and predate this work.

- [ ] **Step 2: Full server test suite**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server 2>&1 | grep -E "Test Files|Tests " | tail -3`

Expected: no NEW failures. The pre-existing baseline of failing tests (schedule reward drift, mineN nonce_prefix, EXACT_SUM_REQUIRED, authVerify Set-Cookie, etc.) should be unchanged from before this work started.

- [ ] **Step 3: Targeted test for everything new + everything sharded**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- "tests/(supplyShards|shardedSupply|longshotRoutes|gladiator|trivia|amm)" 2>&1 | grep -E "Test Files|Tests " | tail -3`

Expected: the new sharded tests pass; the integration tests for routes that now use sharded writes pass (with the same pre-existing baseline failure set).

- [ ] **Step 4: No commit (verification step only)**

This task records evidence; nothing to commit.

---

## Deploy notes

After merging to `main`:

1. **Schema migration applies automatically** at server startup via `runMigrations`. Both `rpow-server.service` and `rpow-auth.service` run the migration on boot; whichever starts first applies it, the other sees `schema_migrations` already has the row.

2. **Restart order:** restart `rpow-auth.service` first (it's the auth worker that handles `/me`, `/send`, etc. — lighter load). Then `rpow-server.service` (the mining cluster). This way, the user-facing routes get the new code first; the heavy mining workers cut over second.

3. **Within 30 seconds of restart**, run the verification queries from `docs/runbook/sharded-supply-rollback.md` to confirm the 16 shards exist and writes are spreading.

4. **Within 5 minutes**, the pg_locks-on-minted_supply count should drop from the current 130+ to under 20.

5. **The mint statement_timeout stopgap from `9d76dc8`** stays in place — it's now belt-and-suspenders for any unexpected contention. It can be removed in a later cleanup PR once the sharded counter is proven stable for a week.

## Out of scope (deferred)

- `mint_reward_for(supply, cap)` PL/pgSQL function to eliminate halving-boundary drift entirely (spec mentions this; not needed for the perf fix).
- Sharding any other counter (`long_shot_house_pnl_base_units`, etc.) — none are hot enough to need it.
- Removing the 3s `statement_timeout` from `/mint` — defer until the sharded counter has run cleanly in prod for at least a week.
- Read-path counter caching — the SUM across 16 indexed rows is fast (microseconds); not worth additional caching layers.
