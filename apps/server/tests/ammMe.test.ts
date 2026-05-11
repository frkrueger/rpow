import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

describe('GET /amm/me', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/me' });
    expect(res.statusCode).toBe(401);
  });

  it('403 NOT_ALLOWED', async () => {
    const ctx = await makeTestApp({ ammAllowedEmails: 'alice@x.com' }); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/me', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('200 with zeros when pool unseeded and user has nothing', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe('a@x.com');
    expect(body.usdc_base_units).toBe('0');
    expect(body.lp_balance).toBe('0');
    expect(body.terms_accepted_at).toBeNull();
    expect(body.spot_price_usdc_per_rpow_e9).toBeNull();
    expect(body.your_pool_share_bps).toBeNull();
  });

  it('200 reflects terms acceptance + USDC credit', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await ctx.pool.query(`UPDATE users SET amm_terms_accepted_at = now(), usdc_base_units = 5000000 WHERE email = 'a@x.com'`);
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().usdc_base_units).toBe('5000000');
    expect(typeof res.json().terms_accepted_at).toBe('string');
  });

  it('200 with pool + LP balance + share bps', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    // Pool: 10 RPOW + 100 USDC, total_lp = 1e9.
    await ctx.pool.query(
      `INSERT INTO amm_pool(rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply) VALUES (10000000000, 100000000, 1000000000)`,
    );
    // Caller holds 250,000,000 LP = 25% of pool = 2500 bps.
    await ctx.pool.query(`INSERT INTO amm_lp_balances(account_email, lp_balance) VALUES ('a@x.com', 250000000)`);
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lp_balance).toBe('250000000');
    // spot price USDC per RPOW * 10^9 = 100e6 * 1e9 / 10e9 = 10e6
    expect(body.spot_price_usdc_per_rpow_e9).toBe('10000000');
    expect(body.your_pool_share_bps).toBe('2500');
  });
});
