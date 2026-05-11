import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('migration 019_amm_user_columns', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('adds usdc_base_units (BIGINT, default 0) and amm_terms_accepted_at (nullable timestamptz)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'users'
         AND table_schema = current_schema()
         AND column_name IN ('usdc_base_units', 'amm_terms_accepted_at')
       ORDER BY column_name`,
    );
    const byName = Object.fromEntries(res.rows.map(r => [r.column_name, r]));
    expect(byName.usdc_base_units.data_type).toBe('bigint');
    expect(byName.usdc_base_units.is_nullable).toBe('NO');
    expect(byName.usdc_base_units.column_default).toBe('0');
    expect(byName.amm_terms_accepted_at.data_type).toBe('timestamp with time zone');
    expect(byName.amm_terms_accepted_at.is_nullable).toBe('YES');
  });

  it('rejects negative usdc_base_units via CHECK', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com')`);
    await expect(
      ctx.pool.query(`UPDATE users SET usdc_base_units = -1 WHERE email = 'a@x.com'`),
    ).rejects.toThrow();
  });

  it('default 0 for new user rows', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com')`);
    const r = await ctx.pool.query<{ usdc_base_units: string; amm_terms_accepted_at: Date | null }>(
      `SELECT usdc_base_units::text AS usdc_base_units, amm_terms_accepted_at FROM users WHERE email = 'a@x.com'`,
    );
    expect(r.rows[0].usdc_base_units).toBe('0');
    expect(r.rows[0].amm_terms_accepted_at).toBeNull();
  });
});
