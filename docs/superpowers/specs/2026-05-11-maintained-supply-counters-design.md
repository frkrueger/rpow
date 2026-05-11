# Maintained `circulating_supply` and `wrapped_supply` Counters — Design

**Date:** 2026-05-11
**Branch:** `feat/maintained-supply-counters`

## Problem

`/ledger` and `/me` compute supply aggregates by `SELECT SUM(value) FROM tokens WHERE state = 'VALID'` (and `'WRAPPED'`). The `tokens` table has ~30M rows and growing; each SUM scans 8M+ matching rows. Under heavy load, even with /ledger's 30s background warmup + inflight dedup, these queries take 30-60s each, consume DB pool connections, and starve `/send` (504 timeouts).

This bottleneck appeared immediately after today's `minted_supply` sharding work removed the row-lock contention — the slow `SUM(tokens)` queries became the new dominant pool consumer.

## Goal

Make `/ledger` and `/me`'s global supply reads O(1) by maintaining two new counters in `app_counters`:
- `circulating_supply_base_units` — sum of `value` across tokens with `state='VALID'`
- `wrapped_supply_base_units` — sum of `value` across tokens with `state='WRAPPED'`

Both counters use the existing 16-shard pattern (composite PK on `(name, shard)`) to avoid row-lock contention under concurrent writes — same shape as today's `minted_supply` work.

## Non-goals

- Per-user balance reads (`/me`'s `WHERE owner_email=$1 AND state='VALID'`) — these already use the `(owner_email, state)` index and are fast. Out of scope.
- The `transfers` table aggregate (`/ledger`'s `total_transferred_base_units`) — separate problem, lower priority.
- Eliminating `tokens` table reads entirely — only the global supply SUMs.

## Design

### Approach: Postgres triggers

Application code that creates or state-changes tokens lives in ~29 sites across 14 files (mint, send, claim, longshot, gladiator/3, trivia/3, amm/3, srpow, srpow-reconcile, longshot/burn). Updating each site individually is brittle: any new token-touching code path can silently break the counter.

**Use a Postgres `AFTER INSERT OR UPDATE` trigger on `tokens`** that adjusts the counters automatically based on the old/new row state. Application code requires zero changes. The trigger runs in the same transaction as the token write — atomic, no race window.

### Counter rows

Same shape as `minted_supply` (migration 022): composite PK `(name, shard)`, 16 shards per counter.

```sql
-- Seed 16 shards for each counter; shard=0 carries the backfill.
INSERT INTO app_counters (name, value, shard)
VALUES ('circulating_supply_base_units', 0, 0), ('wrapped_supply_base_units', 0, 0);
INSERT INTO app_counters (name, value, shard)
SELECT 'circulating_supply_base_units', 0, gs FROM generate_series(1, 15) AS gs;
INSERT INTO app_counters (name, value, shard)
SELECT 'wrapped_supply_base_units', 0, gs FROM generate_series(1, 15) AS gs;
```

### Trigger function

```sql
CREATE OR REPLACE FUNCTION adjust_supply_counters() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  shard SMALLINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state = 'VALID' THEN
      shard := floor(random() * 16)::SMALLINT;
      UPDATE app_counters SET value = value + NEW.value
        WHERE name = 'circulating_supply_base_units' AND shard = shard;
    ELSIF NEW.state = 'WRAPPED' THEN
      shard := floor(random() * 16)::SMALLINT;
      UPDATE app_counters SET value = value + NEW.value
        WHERE name = 'wrapped_supply_base_units' AND shard = shard;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.state IS DISTINCT FROM NEW.state THEN
    -- Remove value from the old state's counter
    IF OLD.state = 'VALID' THEN
      shard := floor(random() * 16)::SMALLINT;
      UPDATE app_counters SET value = value - OLD.value
        WHERE name = 'circulating_supply_base_units' AND shard = shard;
    ELSIF OLD.state = 'WRAPPED' THEN
      shard := floor(random() * 16)::SMALLINT;
      UPDATE app_counters SET value = value - OLD.value
        WHERE name = 'wrapped_supply_base_units' AND shard = shard;
    END IF;
    -- Add value to the new state's counter
    IF NEW.state = 'VALID' THEN
      shard := floor(random() * 16)::SMALLINT;
      UPDATE app_counters SET value = value + NEW.value
        WHERE name = 'circulating_supply_base_units' AND shard = shard;
    ELSIF NEW.state = 'WRAPPED' THEN
      shard := floor(random() * 16)::SMALLINT;
      UPDATE app_counters SET value = value + NEW.value
        WHERE name = 'wrapped_supply_base_units' AND shard = shard;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tokens_adjust_supply
  AFTER INSERT OR UPDATE ON tokens
  FOR EACH ROW
  EXECUTE FUNCTION adjust_supply_counters();
```

Notes:
- Intermediate states (`INVALIDATED`, `LOCKED_FOR_BRIDGE`) are not tracked. Tokens transitioning into those just disappear from the counter; transitioning out adds back to whichever final state.
- Each branch picks an independent random shard, so increment and decrement may target different shards — that's fine, SUM is invariant.
- The trigger is `AFTER`, not `BEFORE`, so it sees the final row values.

### Backfill — atomic snapshot via lock

Migration runs in a transaction that:
1. Locks `tokens` in `SHARE MODE` (blocks INSERTs/UPDATEs from other transactions, allows reads).
2. Computes `SUM(value) WHERE state='VALID'` → seed `circulating_supply_base_units` shard=0.
3. Computes `SUM(value) WHERE state='WRAPPED'` → seed `wrapped_supply_base_units` shard=0.
4. Seeds shards 1..15 at value=0 for both counters.
5. Creates the trigger.
6. COMMITs — lock released, trigger now active.

During the lock (estimated 30-90 seconds for the SUM scans on ~30M rows), token writes block. Some requests will hit the existing 3s `statement_timeout` on `/mint` and return `503 MINT_BUSY` (already implemented as a stopgap from this morning's work). `/send` and other write paths will hang until the lock releases.

**Deployment timing:** run during a quieter window. Even at peak (~100 mints/sec), 60s of blocked writes means ~6000 retried mints — within current system tolerance.

### Read sites — switch to the new counters

Replace these queries:
- `apps/server/src/routes/ledger.ts:24` — `SELECT SUM(value) FROM tokens WHERE state='VALID'` → `SELECT SUM(value) FROM app_counters WHERE name='circulating_supply_base_units'`
- `apps/server/src/routes/ledger.ts:27` — `SELECT SUM(value) FROM tokens WHERE state='WRAPPED'` → `SELECT SUM(value) FROM app_counters WHERE name='wrapped_supply_base_units'`

That's it — `/me`'s per-user reads stay unchanged (they're indexed and fast).

### Correctness

**Invariant:** `SUM(value) FROM app_counters WHERE name='circulating_supply_base_units' = SUM(value) FROM tokens WHERE state='VALID'`.

The trigger maintains this for every transition that touches `state`. The only way to break it is to insert/update tokens **bypassing the trigger** — which Postgres doesn't allow under normal SQL.

Edge cases handled:
- **Direct UPDATE of `value` without state change** — would drift the counter. Currently no code path does this (verified by grep: no `UPDATE tokens SET value`). If added later, the developer must also handle the counter. The trigger does not protect against this; document it.
- **DELETE of tokens** — would drift the counter. Currently no code path DELETEs from `tokens` (audit log preserved). Same caveat.
- **`state='LOCKED_FOR_BRIDGE'` intermediate** — wrap path goes VALID → LOCKED_FOR_BRIDGE → WRAPPED (or back to VALID on refund). Trigger correctly: subtracts from circulating on VALID→LOCKED transition, then adds to wrapped on LOCKED→WRAPPED, OR adds back to circulating on LOCKED→VALID. Net result matches the actual end state.
- **Migration-time race:** the lock ensures no writes during the SUM. After lock release, every subsequent write goes through the trigger. No drift.

### Reconciliation script

Out-of-band script for ops verification:

```sql
SELECT
  (SELECT SUM(value) FROM app_counters WHERE name='circulating_supply_base_units') AS counter_circulating,
  (SELECT SUM(value) FROM tokens WHERE state='VALID') AS actual_circulating,
  (SELECT SUM(value) FROM app_counters WHERE name='wrapped_supply_base_units') AS counter_wrapped,
  (SELECT SUM(value) FROM tokens WHERE state='WRAPPED') AS actual_wrapped;
```

Should be exact equality at all times. Run weekly (or on suspicion of drift).

## Rollback

If a discrepancy emerges (e.g., a code path bypasses the trigger), rolling back is the same shape as today's sharded-counter rollback:

1. Drop the trigger: `DROP TRIGGER tokens_adjust_supply ON tokens;`
2. Revert the `/ledger` read changes (one commit revert).
3. Old code reads `SUM(tokens)` as before — works, but slow.
4. Counter rows can stay (harmless).

If drift is suspected but the trigger is to remain, run a one-shot reconciliation:

```sql
BEGIN;
LOCK TABLE tokens IN SHARE MODE;
UPDATE app_counters SET value = (SELECT SUM(value) FROM tokens WHERE state='VALID')
  WHERE name='circulating_supply_base_units' AND shard=0;
DELETE FROM app_counters WHERE name='circulating_supply_base_units' AND shard > 0;
INSERT INTO app_counters (name, value, shard)
  SELECT 'circulating_supply_base_units', 0, gs FROM generate_series(1, 15) AS gs;
-- Same for wrapped_supply_base_units
COMMIT;
```

## Out of scope

- Per-user balance materialization (would require triggers per (owner_email, state) which is high-cardinality).
- Cross-region replication of counters (single Postgres instance for now).
- Statistical/eventually-consistent counters (HLL etc.) — not warranted at this scale.

## Files to create / modify

**New:**
- `apps/server/migrations/023_supply_counter_trigger.sql` — counter rows + trigger function + trigger.

**Modified:**
- `apps/server/src/routes/ledger.ts` — switch 2 read queries to the new counters.

**No other code changes.** The trigger does the heavy lifting.

## Verification

- Migration applies cleanly under `makeTestApp()`.
- A new test `apps/server/tests/supplyCountersTrigger.test.ts` exercises:
  - INSERT VALID → circulating += value
  - INSERT WRAPPED → wrapped += value
  - UPDATE VALID → INVALIDATED → circulating -= value
  - UPDATE VALID → LOCKED_FOR_BRIDGE → WRAPPED → circulating -= value, wrapped += value
  - UPDATE LOCKED_FOR_BRIDGE → VALID (refund path) → circulating += value
  - End-state SUMs match the expected values across 100 concurrent inserts.
- After deploy: run the reconciliation script. Counter should equal SUM(tokens).
- After 1 hour: re-run reconciliation. Drift should be 0.

## Estimated effort

- Migration + trigger: 1 hour
- /ledger read updates: 15 minutes
- Tests: 1 hour
- Deploy + verification: 30 minutes (incl. ~60s of degraded writes during the migration lock)
- **Total: ~3 hours**
