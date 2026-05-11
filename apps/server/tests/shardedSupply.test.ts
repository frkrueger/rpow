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
