import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { persistTransfer, loadCursor, advanceCursor } from '../src/amm/usdc-indexer.js';

describe('indexer persistence', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('ATTRIBUTED: inserts deposit + bumps balance when sender pubkey matches a user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_pubkey) VALUES ('a@x.com', 'PK1')`);
    await persistTransfer(ctx.pool, {
      sig: 'SIG1', amount: 10000000n, authority: 'PK1', blockTime: new Date(),
    });
    const dep = await ctx.pool.query(`SELECT account_email FROM usdc_deposits WHERE solana_signature='SIG1'`);
    expect(dep.rows[0].account_email).toBe('a@x.com');
    const bal = await ctx.pool.query<{ usdc_base_units: string }>(
      `SELECT usdc_base_units::text FROM users WHERE email='a@x.com'`);
    expect(bal.rows[0].usdc_base_units).toBe('10000000');
    const un = await ctx.pool.query(`SELECT count(*)::int AS n FROM usdc_unattributed_deposits`);
    expect(un.rows[0].n).toBe(0);
  });

  it('UNATTRIBUTED: no user matches, lands in usdc_unattributed_deposits', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await persistTransfer(ctx.pool, {
      sig: 'SIG2', amount: 7n, authority: 'PK_UNKNOWN', blockTime: null,
    });
    const un = await ctx.pool.query(`SELECT amount_base_units::text AS a FROM usdc_unattributed_deposits WHERE solana_signature='SIG2'`);
    expect(un.rows[0].a).toBe('7');
    const dep = await ctx.pool.query(`SELECT count(*)::int AS n FROM usdc_deposits`);
    expect(dep.rows[0].n).toBe(0);
  });

  it('idempotent: replaying same sig does not double-credit', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_pubkey) VALUES ('a@x.com', 'PK1')`);
    await persistTransfer(ctx.pool, { sig: 'SIG3', amount: 100n, authority: 'PK1', blockTime: null });
    await persistTransfer(ctx.pool, { sig: 'SIG3', amount: 100n, authority: 'PK1', blockTime: null });
    const bal = await ctx.pool.query<{ usdc_base_units: string }>(
      `SELECT usdc_base_units::text FROM users WHERE email='a@x.com'`);
    expect(bal.rows[0].usdc_base_units).toBe('100');   // not 200
  });

  it('cursor: loadCursor returns null initially, advanceCursor sets it', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    expect(await loadCursor(ctx.pool)).toBeNull();
    await advanceCursor(ctx.pool, 'SIGZ');
    expect(await loadCursor(ctx.pool)).toBe('SIGZ');
  });
});
