import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('migration 028 — AMM slice 5 schema', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('adds users.solana_pubkey TEXT UNIQUE NULL', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const r = await ctx.pool.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name='users' AND column_name='solana_pubkey'`,
    );
    expect(r.rows[0]).toEqual({ data_type: 'text', is_nullable: 'YES' });

    // Inserting two distinct emails with same pubkey violates UNIQUE.
    await ctx.pool.query(`INSERT INTO users(email, solana_pubkey) VALUES ('a@x','PK1')`);
    await expect(
      ctx.pool.query(`INSERT INTO users(email, solana_pubkey) VALUES ('b@x','PK1')`),
    ).rejects.toThrow(/unique/i);
  });

  it('creates usdc_deposits with UNIQUE solana_signature and account FK', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x')`);
    await ctx.pool.query(`
      INSERT INTO usdc_deposits(account_email, amount_base_units, solana_signature, sender_pubkey)
      VALUES ('a@x', 100, 'SIG1', 'PK1')
    `);
    await expect(ctx.pool.query(`
      INSERT INTO usdc_deposits(account_email, amount_base_units, solana_signature, sender_pubkey)
      VALUES ('a@x', 200, 'SIG1', 'PK1')
    `)).rejects.toThrow(/unique/i);
  });

  it('creates usdc_unattributed_deposits with UNIQUE solana_signature', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`
      INSERT INTO usdc_unattributed_deposits(amount_base_units, solana_signature, sender_pubkey)
      VALUES (100, 'SIG2', 'PK1')
    `);
    await expect(ctx.pool.query(`
      INSERT INTO usdc_unattributed_deposits(amount_base_units, solana_signature, sender_pubkey)
      VALUES (200, 'SIG2', 'PK1')
    `)).rejects.toThrow(/unique/i);
  });

  it('seeds amm_indexer_state row for the usdc_deposits key', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const r = await ctx.pool.query(`SELECT key, last_signature FROM amm_indexer_state WHERE key='usdc_deposits'`);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].last_signature).toBeNull();
  });
});
