import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  await ctx.pool.query(`UPDATE users SET amm_terms_accepted_at = now() WHERE email=$1`, [email]);
  return `${SESSION_COOKIE}=${signSession({ email }, 'x'.repeat(32), 3600)}`;
}

describe('POST /amm/wallet/unlink', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('clears solana_pubkey, returns the prior value', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await ctx.pool.query(`UPDATE users SET solana_pubkey='PK1' WHERE email='a@x.com'`);
    const res = await ctx.app.inject({ method: 'POST', url: '/amm/wallet/unlink', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unlinked_pubkey: 'PK1' });
    const after = await ctx.pool.query(`SELECT solana_pubkey FROM users WHERE email='a@x.com'`);
    expect(after.rows[0].solana_pubkey).toBeNull();
  });

  it('noop when no pubkey was linked', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({ method: 'POST', url: '/amm/wallet/unlink', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unlinked_pubkey: null });
  });

  it('does not delete deposit history', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await ctx.pool.query(`UPDATE users SET solana_pubkey='PK1' WHERE email='a@x.com'`);
    await ctx.pool.query(`
      INSERT INTO usdc_deposits(account_email, amount_base_units, solana_signature, sender_pubkey)
      VALUES ('a@x.com', 100, 'SIG1', 'PK1')
    `);
    await ctx.app.inject({ method: 'POST', url: '/amm/wallet/unlink', headers: { cookie } });
    const r = await ctx.pool.query(`SELECT COUNT(*)::int AS n FROM usdc_deposits WHERE account_email='a@x.com'`);
    expect(r.rows[0].n).toBe(1);
  });
});
