import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('migration 020_amm_pool', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('creates amm_pool with singleton constraint', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cols = await ctx.pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'amm_pool' AND table_schema = current_schema()
       ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((r: any) => r.column_name)).toEqual([
      'id',
      'rpow_reserve_base_units',
      'usdc_reserve_base_units',
      'total_lp_supply',
      'fee_bps',
      'seeded_at',
    ]);
  });

  it('amm_pool rejects id != main', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await expect(
      ctx.pool.query(
        `INSERT INTO amm_pool(id, rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply)
         VALUES ('other', 100, 100, 100)`,
      ),
    ).rejects.toThrow();
  });

  it('amm_pool rejects zero or negative reserves', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await expect(
      ctx.pool.query(
        `INSERT INTO amm_pool(rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply)
         VALUES (0, 100, 100)`,
      ),
    ).rejects.toThrow();
  });

  it('amm_lp_balances enforces lp_balance >= 0', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com')`);
    await expect(
      ctx.pool.query(
        `INSERT INTO amm_lp_balances(account_email, lp_balance) VALUES ('a@x.com', -1)`,
      ),
    ).rejects.toThrow();
  });

  it('amm_swaps direction CHECK rejects other values', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com')`);
    await expect(
      ctx.pool.query(
        `INSERT INTO amm_swaps(id, account_email, direction, rpow_delta_base_units, usdc_delta_base_units, fee_base_units, pool_rpow_after, pool_usdc_after, signature)
         VALUES (gen_random_uuid(), 'a@x.com', 'OTHER', 0, 0, 0, 1, 1, '\\x00')`,
      ),
    ).rejects.toThrow();
  });

  it('all four AMM tables exist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const tables = await ctx.pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN ('amm_pool','amm_lp_balances','amm_swaps','amm_lp_events')
       ORDER BY table_name`,
    );
    expect(tables.rows.map((r: any) => r.table_name)).toEqual([
      'amm_lp_balances',
      'amm_lp_events',
      'amm_pool',
      'amm_swaps',
    ]);
  });

  it('expected indexes exist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const idx = await ctx.pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
       AND indexname IN (
         'amm_swaps_account_idx',
         'amm_swaps_recent_idx',
         'amm_lp_events_account_idx'
       )
       ORDER BY indexname`,
    );
    expect(idx.rows.map((r: any) => r.indexname)).toEqual([
      'amm_lp_events_account_idx',
      'amm_swaps_account_idx',
      'amm_swaps_recent_idx',
    ]);
  });
});
