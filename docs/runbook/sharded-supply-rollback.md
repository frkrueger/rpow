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
