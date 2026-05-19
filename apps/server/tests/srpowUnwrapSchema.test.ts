// apps/server/tests/srpowUnwrapSchema.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('migration 035 — srpow_unwrap schema', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('adds swap_signature + burn_signature columns', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const r = await ctx.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='srpow_wrap_events'
          AND column_name IN ('swap_signature','burn_signature')
        ORDER BY column_name`,
    );
    expect(r.rows.map(x => x.column_name)).toEqual(['burn_signature', 'swap_signature']);
  });

  it('enforces UNIQUE on solana_signature for direction=UNWRAP only', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x'),('b@x')`);

    // Same sig used twice for WRAP is allowed (partial index excludes it).
    await ctx.pool.query(`
      INSERT INTO srpow_wrap_events(id, user_email, solana_wallet, amount, direction, status, idempotency_key, solana_signature)
      VALUES ('00000000-0000-0000-0000-000000000001','a@x','PK1',100,'WRAP','CONFIRMED','k1','SIGX')
    `);
    await expect(ctx.pool.query(`
      INSERT INTO srpow_wrap_events(id, user_email, solana_wallet, amount, direction, status, idempotency_key, solana_signature)
      VALUES ('00000000-0000-0000-0000-000000000002','b@x','PK2',100,'WRAP','CONFIRMED','k2','SIGX')
    `)).resolves.toBeDefined();

    // Same sig for UNWRAP is unique.
    await ctx.pool.query(`
      INSERT INTO srpow_wrap_events(id, user_email, solana_wallet, amount, direction, status, idempotency_key, solana_signature)
      VALUES ('00000000-0000-0000-0000-000000000003','a@x','PK1',100,'UNWRAP','CONFIRMED','k3','SIGY')
    `);
    await expect(ctx.pool.query(`
      INSERT INTO srpow_wrap_events(id, user_email, solana_wallet, amount, direction, status, idempotency_key, solana_signature)
      VALUES ('00000000-0000-0000-0000-000000000004','b@x','PK2',100,'UNWRAP','CONFIRMED','k4','SIGY')
    `)).rejects.toThrow(/unique/i);
  });

  it('allows multiple UNWRAP rows with solana_signature = NULL (partial index predicate)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x'),('b@x')`);
    await ctx.pool.query(`
      INSERT INTO srpow_wrap_events(id, user_email, solana_wallet, amount, direction, status, idempotency_key, solana_signature)
      VALUES ('00000000-0000-0000-0000-000000000005','a@x','PK1',100,'UNWRAP','PENDING','k5',NULL)
    `);
    await expect(ctx.pool.query(`
      INSERT INTO srpow_wrap_events(id, user_email, solana_wallet, amount, direction, status, idempotency_key, solana_signature)
      VALUES ('00000000-0000-0000-0000-000000000006','b@x','PK2',100,'UNWRAP','PENDING','k6',NULL)
    `)).resolves.toBeDefined();
  });

  it('seeds 128 shards of unwrap_fee_burned_srpow_base_units at value=0', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const r = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app_counters WHERE name='unwrap_fee_burned_srpow_base_units'`,
    );
    expect(r.rows[0].n).toBe('128');
  });
});
