# Maintained Supply Counters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the `SELECT SUM(value) FROM tokens WHERE state='X'` bottleneck by maintaining `circulating_supply_base_units` and `wrapped_supply_base_units` counters in `app_counters` via Postgres triggers.

**Architecture:** A single `AFTER INSERT OR UPDATE` trigger on `tokens` adjusts two new sharded counters automatically based on state transitions. Application code unchanged. Read sites in `/ledger` switch from `SUM(tokens)` to `SUM(app_counters)`. Backfill is atomic via a brief `LOCK TABLE tokens IN SHARE MODE` during the migration.

**Tech Stack:** Postgres 17 PL/pgSQL triggers, Fastify 4, `pg` 8, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-11-maintained-supply-counters-design.md`

---

## File map

**New:**
- `apps/server/migrations/023_supply_counter_trigger.sql` — counter rows, trigger function, trigger binding, backfill (all in one migration, in a single transaction).
- `apps/server/tests/supplyCountersTrigger.test.ts` — exercises state transitions + concurrency.

**Modified:**
- `apps/server/src/routes/ledger.ts` — swap 2 read queries.

**Untouched:**
- All token-write sites (mint, send, claim, longshot, gladiator, trivia, amm, srpow). The trigger handles them.

---

## Task 1: Migration — counter rows + trigger + atomic backfill

**Files:**
- Create: `apps/server/migrations/023_supply_counter_trigger.sql`

- [ ] **Step 1: Write the migration**

Create `apps/server/migrations/023_supply_counter_trigger.sql`:

```sql
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
```

- [ ] **Step 2: Verify migration applies cleanly**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- authRequest 2>&1 | tail -10`

Expected: PASS. The migration runner picks up `023_*.sql`.

- [ ] **Step 3: Commit**

```bash
git add apps/server/migrations/023_supply_counter_trigger.sql
git commit -m "migration: maintained circulating + wrapped supply counters via trigger"
```

---

## Task 2: `/ledger` reads switch to the maintained counters

**Files:**
- Modify: `apps/server/src/routes/ledger.ts`

- [ ] **Step 1: Update the two read queries**

In `apps/server/src/routes/ledger.ts` (around lines 23-28), find:

```ts
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM tokens WHERE state='VALID'`,
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM tokens WHERE state='WRAPPED'`,
      ),
```

Replace with:

```ts
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM app_counters WHERE name='circulating_supply_base_units'`,
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM app_counters WHERE name='wrapped_supply_base_units'`,
      ),
```

The destructuring on the result and downstream usage stays unchanged (the alias `AS n` is identical).

- [ ] **Step 2: Run ledger tests**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- ledger 2>&1 | tail -10`

Expected: pass/fail counts match the baseline (2 failed | 1 passed). The remaining 2 failures are pre-existing schedule-reward drift (out of scope).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/routes/ledger.ts
git commit -m "perf(ledger): read maintained supply counters instead of SUM(tokens)"
```

---

## Task 3: Integration test — trigger correctness across all transitions

**Files:**
- Create: `apps/server/tests/supplyCountersTrigger.test.ts`

This is a behavior test of the trigger itself. Covers each transition that touches the counters.

- [ ] **Step 1: Write the test**

Create `apps/server/tests/supplyCountersTrigger.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';

async function totalCirculating(pool: any): Promise<bigint> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COALESCE(SUM(value), 0)::text AS n FROM app_counters WHERE name = 'circulating_supply_base_units'`,
  );
  return BigInt(rows[0].n);
}

async function totalWrapped(pool: any): Promise<bigint> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COALESCE(SUM(value), 0)::text AS n FROM app_counters WHERE name = 'wrapped_supply_base_units'`,
  );
  return BigInt(rows[0].n);
}

async function insertToken(pool: any, owner: string, value: bigint, state: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO users(email) VALUES($1) ON CONFLICT DO NOTHING`, [owner]);
  await pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, server_sig) VALUES($1, $2, $3, $4, '\\x00')`,
    [id, owner, value.toString(), state],
  );
  return id;
}

describe('tokens_adjust_supply trigger', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('INSERT VALID increments circulating', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    expect(await totalCirculating(ctx.pool)).toBe(0n);
    await insertToken(ctx.pool, 'a@x.com', 100n, 'VALID');
    expect(await totalCirculating(ctx.pool)).toBe(100n);
    expect(await totalWrapped(ctx.pool)).toBe(0n);
  });

  it('INSERT WRAPPED increments wrapped, not circulating', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await insertToken(ctx.pool, 'a@x.com', 50n, 'WRAPPED');
    expect(await totalCirculating(ctx.pool)).toBe(0n);
    expect(await totalWrapped(ctx.pool)).toBe(50n);
  });

  it('INSERT INVALIDATED affects neither counter', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await insertToken(ctx.pool, 'a@x.com', 999n, 'INVALIDATED');
    expect(await totalCirculating(ctx.pool)).toBe(0n);
    expect(await totalWrapped(ctx.pool)).toBe(0n);
  });

  it('VALID → INVALIDATED decrements circulating', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const id = await insertToken(ctx.pool, 'a@x.com', 100n, 'VALID');
    expect(await totalCirculating(ctx.pool)).toBe(100n);
    await ctx.pool.query(`UPDATE tokens SET state='INVALIDATED' WHERE id=$1`, [id]);
    expect(await totalCirculating(ctx.pool)).toBe(0n);
  });

  it('VALID → LOCKED_FOR_BRIDGE → WRAPPED moves value from circulating to wrapped', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const id = await insertToken(ctx.pool, 'a@x.com', 200n, 'VALID');
    expect(await totalCirculating(ctx.pool)).toBe(200n);
    await ctx.pool.query(`UPDATE tokens SET state='LOCKED_FOR_BRIDGE' WHERE id=$1`, [id]);
    expect(await totalCirculating(ctx.pool)).toBe(0n);
    expect(await totalWrapped(ctx.pool)).toBe(0n);
    await ctx.pool.query(`UPDATE tokens SET state='WRAPPED' WHERE id=$1`, [id]);
    expect(await totalCirculating(ctx.pool)).toBe(0n);
    expect(await totalWrapped(ctx.pool)).toBe(200n);
  });

  it('LOCKED_FOR_BRIDGE → VALID (refund path) restores circulating', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const id = await insertToken(ctx.pool, 'a@x.com', 75n, 'VALID');
    await ctx.pool.query(`UPDATE tokens SET state='LOCKED_FOR_BRIDGE' WHERE id=$1`, [id]);
    expect(await totalCirculating(ctx.pool)).toBe(0n);
    await ctx.pool.query(`UPDATE tokens SET state='VALID' WHERE id=$1`, [id]);
    expect(await totalCirculating(ctx.pool)).toBe(75n);
  });

  it('WRAPPED → VALID (unwrap) moves value back to circulating', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const id = await insertToken(ctx.pool, 'a@x.com', 300n, 'WRAPPED');
    expect(await totalWrapped(ctx.pool)).toBe(300n);
    await ctx.pool.query(`UPDATE tokens SET state='VALID' WHERE id=$1`, [id]);
    expect(await totalWrapped(ctx.pool)).toBe(0n);
    expect(await totalCirculating(ctx.pool)).toBe(300n);
  });

  it('UPDATE without state change does not affect counters', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const id = await insertToken(ctx.pool, 'a@x.com', 100n, 'VALID');
    expect(await totalCirculating(ctx.pool)).toBe(100n);
    // Touch invalidated_at without changing state
    await ctx.pool.query(`UPDATE tokens SET invalidated_at = now() WHERE id=$1`, [id]);
    expect(await totalCirculating(ctx.pool)).toBe(100n);
  });

  it('100 concurrent INSERT VALIDs produce correct SUM', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES('concurrent@x.com')`);
    const writes = Array.from({ length: 100 }, () =>
      ctx.pool.query(
        `INSERT INTO tokens(id, owner_email, value, state, server_sig) VALUES($1, 'concurrent@x.com', 7, 'VALID', '\\x00')`,
        [randomUUID()],
      ),
    );
    await Promise.all(writes);
    expect(await totalCirculating(ctx.pool)).toBe(700n);
  });

  it('counter SUM matches the actual tokens table state at all times', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Mix of operations
    const a = await insertToken(ctx.pool, 'a@x.com', 100n, 'VALID');
    const b = await insertToken(ctx.pool, 'b@x.com', 200n, 'VALID');
    await insertToken(ctx.pool, 'c@x.com', 300n, 'WRAPPED');
    await ctx.pool.query(`UPDATE tokens SET state='INVALIDATED' WHERE id=$1`, [a]);
    await ctx.pool.query(`UPDATE tokens SET state='LOCKED_FOR_BRIDGE' WHERE id=$1`, [b]);

    // Counter values
    const cCirc = await totalCirculating(ctx.pool);
    const cWrap = await totalWrapped(ctx.pool);
    // Actual table state
    const { rows: actualValid } = await ctx.pool.query<{ n: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS n FROM tokens WHERE state='VALID'`,
    );
    const { rows: actualWrap } = await ctx.pool.query<{ n: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS n FROM tokens WHERE state='WRAPPED'`,
    );
    expect(cCirc.toString()).toBe(actualValid[0].n);
    expect(cWrap.toString()).toBe(actualWrap[0].n);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- supplyCountersTrigger 2>&1 | tail -5`

Expected: 10/10 passing.

- [ ] **Step 3: Commit**

```bash
git add apps/server/tests/supplyCountersTrigger.test.ts
git commit -m "test: supply counter trigger covers all state transitions"
```

---

## Task 4: Full build + targeted test verification

**Files:** none new

- [ ] **Step 1: Build**

Run: `npm run build --workspace @rpow/shared && npm run build --workspace @rpow/server 2>&1 | tail -5`

Expected: no NEW TypeScript errors. (Pre-existing `@rpow/solana-bridge` errors are out of scope.)

- [ ] **Step 2: Targeted test run**

Run: `TEST_DATABASE_URL="postgres://test:test@localhost:5433/rpow_test" npm test --workspace @rpow/server -- "tests/(supplyCountersTrigger|ledger|mint|longshotRoutes|gladiator|trivia|amm|shardedSupply|supplyShards)" 2>&1 | grep -E "Test Files|Tests " | tail -3`

Expected: new trigger tests pass (10/10). Existing tests' pass/fail counts unchanged from the post-sharding baseline. The trigger should be transparent to all the route tests because they use direct INSERT INTO tokens in their seeds, which the trigger handles correctly.

- [ ] **Step 3: No commit (verification only)**

This task records evidence; nothing to commit.

---

## Deploy notes

After merging to `main`:

1. **Migration applies automatically** at server startup. The `LOCK TABLE tokens IN SHARE MODE` will briefly block token writes (~30-90s for the SUM scans on prod's ~30M-row tokens table). Some in-flight `/mint`, `/send`, `/longshot/spin`, etc. requests will hang and then either complete after lock release or fail with the existing 3s `statement_timeout`.

2. **Run migration during a quieter window** — e.g., off-peak. Even at peak, the disruption is bounded to ~90s.

3. **Verify counters match tokens table immediately after deploy:**
   ```bash
   sudo -u postgres psql rpow -c "
   SELECT
     (SELECT SUM(value) FROM app_counters WHERE name='circulating_supply_base_units') AS counter_circ,
     (SELECT SUM(value) FROM tokens WHERE state='VALID') AS actual_circ,
     (SELECT SUM(value) FROM app_counters WHERE name='wrapped_supply_base_units') AS counter_wrap,
     (SELECT SUM(value) FROM tokens WHERE state='WRAPPED') AS actual_wrap;"
   ```
   The counter and actual columns should be exactly equal. If not, run the reconciliation block in the spec.

4. **Watch the active query mix.** `SELECT ... FROM tokens WHERE state='X'` should drop from 20+ to 0 (only the per-user `WHERE owner_email AND state='X'` queries remain, and those are fast).

5. **Watch `/send` latency.** With the SUMs gone from the pool, /send should stop seeing 504s.

## Rollback

If correctness drift emerges:

1. `DROP TRIGGER tokens_adjust_supply ON tokens;` (Postgres, one statement).
2. Revert the `/ledger` commit (one git revert).
3. `/ledger` returns to scanning `tokens` table — slow but correct.
4. Counter rows can stay (harmless).

If the trigger should stay but drift is suspected, run the reconciliation block from the spec.

## Out of scope (deferred)

- Per-user balance materialization
- `transfers` table aggregate optimization
- HLL/probabilistic counters
