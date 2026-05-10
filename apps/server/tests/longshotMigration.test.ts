import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('migration 013: long_shot', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('creates long_shot_bets table', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { rows } = await ctx.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'long_shot_bets'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('seeds long_shot_house_pnl_base_units counter at 0', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { rows } = await ctx.pool.query<{ value: string }>(
      `SELECT value::text FROM app_counters WHERE name = 'long_shot_house_pnl_base_units'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('0');
  });

  it('enforces odds_choice CHECK constraint', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES('a@b.com')`);
    const insertWithBadOdds = () => ctx.pool.query(
      `INSERT INTO long_shot_bets(id, account_email, stake_base_units, odds_choice,
         win_probability, payout_multiple, outcome, net_user_change_base_units,
         total_minted_delta_base_units, random_value_hex, signature)
       VALUES('00000000-0000-0000-0000-000000000001', 'a@b.com', 100, '5:1',
         0.5, 5, 'WIN', 500, 500, 'abcd', '\\x00')`,
    );
    await expect(insertWithBadOdds()).rejects.toThrow();
  });
});
