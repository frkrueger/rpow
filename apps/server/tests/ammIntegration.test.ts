import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}
async function acceptTerms(ctx: any, email: string) {
  await ctx.pool.query(`UPDATE users SET amm_terms_accepted_at = now() WHERE email = $1`, [email]);
}
async function seedToken(pool: any, email: string, value: bigint) {
  await pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, server_sig)
     VALUES($1, $2, $3, 'VALID', $4)`,
    [randomUUID(), email, value.toString(), Buffer.from('00'.repeat(64), 'hex')],
  );
}
async function creditUsdc(pool: any, email: string, amount: bigint) {
  await pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  await pool.query(`UPDATE users SET usdc_base_units = usdc_base_units + $1::bigint WHERE email = $2`, [amount.toString(), email]);
}

async function getReserves(pool: any) {
  const r = (await pool.query(
    `SELECT rpow_reserve_base_units::text AS r, usdc_reserve_base_units::text AS u, total_lp_supply::text AS t FROM amm_pool WHERE id='main'`,
  )).rows[0];
  return { r: BigInt(r.r), u: BigInt(r.u), t: BigInt(r.t) };
}

const RPOW_DEC = 1_000_000_000n;
const USDC_DEC = 1_000_000n;

describe('AMM integration — seed → add → swap → remove', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('end-to-end flow maintains invariant', async () => {
    const ctx = await makeTestApp({
      ammAdminEmails: 'admin@x.com',
      ammAllowedEmails: 'admin@x.com,trader@x.com',
    });
    cleanup = ctx.cleanup;
    const adminCookie = await login(ctx, 'admin@x.com');
    const traderCookie = await login(ctx, 'trader@x.com');
    await acceptTerms(ctx, 'admin@x.com');
    await acceptTerms(ctx, 'trader@x.com');

    // Admin holds 11 RPOW + 110 USDC (10 + 100 for seed, 1 + 10 slack).
    await seedToken(ctx.pool, 'admin@x.com', 11n * RPOW_DEC);
    await creditUsdc(ctx.pool, 'admin@x.com', 110n * USDC_DEC);
    // Trader holds 2 RPOW + 20 USDC.
    await seedToken(ctx.pool, 'trader@x.com', 2n * RPOW_DEC);
    await creditUsdc(ctx.pool, 'trader@x.com', 20n * USDC_DEC);

    // 1. Seed pool: 10 RPOW + 100 USDC.
    const seedRes = await ctx.app.inject({
      method: 'POST', url: '/amm/seed',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: (10n * RPOW_DEC).toString(), usdc_base_units: (100n * USDC_DEC).toString() },
    });
    expect(seedRes.statusCode, `seed failed: ${seedRes.body}`).toBe(200);

    const r0 = await getReserves(ctx.pool);
    const k0 = r0.r * r0.u;
    expect(r0.r).toBe(10n * RPOW_DEC);
    expect(r0.u).toBe(100n * USDC_DEC);

    // 2. Trader adds 1 RPOW + 10 USDC liquidity.
    const addRes = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/add',
      headers: { cookie: traderCookie, 'content-type': 'application/json' },
      payload: {
        rpow_base_units: (1n * RPOW_DEC).toString(),
        usdc_base_units: (10n * USDC_DEC).toString(),
        min_lp_out: '0',
      },
    });
    expect(addRes.statusCode, `lp/add failed: ${addRes.body}`).toBe(200);
    const r1 = await getReserves(ctx.pool);
    const k1 = r1.r * r1.u;
    expect(k1).toBeGreaterThanOrEqual(k0);
    expect(r1.r).toBeGreaterThan(r0.r);
    expect(r1.u).toBeGreaterThan(r0.u);

    // 3. Trader buys with 1 USDC.
    const buyRes = await ctx.app.inject({
      method: 'POST', url: '/amm/buy',
      headers: { cookie: traderCookie, 'content-type': 'application/json' },
      payload: { usdc_base_units: USDC_DEC.toString(), min_rpow_out: '0' },
    });
    expect(buyRes.statusCode, `buy failed: ${buyRes.body}`).toBe(200);
    const rpowReceived = BigInt(buyRes.json().rpow_received);
    expect(rpowReceived).toBeGreaterThan(0n);
    const r2 = await getReserves(ctx.pool);
    const k2 = r2.r * r2.u;
    expect(k2).toBeGreaterThanOrEqual(k1);

    // 4. Trader sells the RPOW they just bought.
    const sellRes = await ctx.app.inject({
      method: 'POST', url: '/amm/sell',
      headers: { cookie: traderCookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: rpowReceived.toString(), min_usdc_out: '0' },
    });
    expect(sellRes.statusCode, `sell failed: ${sellRes.body}`).toBe(200);
    const usdcReceived = BigInt(sellRes.json().usdc_received);
    // Round-trip incurs ~2 × 0.3% fees, so caller gets back less than they put in.
    expect(usdcReceived).toBeLessThan(USDC_DEC);
    expect(usdcReceived).toBeGreaterThan(0n);
    const r3 = await getReserves(ctx.pool);
    const k3 = r3.r * r3.u;
    expect(k3).toBeGreaterThanOrEqual(k2);

    // 5. Trader removes all LP.
    const lpRow = (await ctx.pool.query(
      `SELECT lp_balance::text AS b FROM amm_lp_balances WHERE account_email='trader@x.com'`,
    )).rows[0];
    expect(lpRow, 'trader should have LP after add').toBeTruthy();
    const removeRes = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/remove',
      headers: { cookie: traderCookie, 'content-type': 'application/json' },
      payload: { lp_base_units: lpRow.b, min_rpow_out: '0', min_usdc_out: '0' },
    });
    expect(removeRes.statusCode, `lp/remove failed: ${removeRes.body}`).toBe(200);

    // Trader LP balance is gone (row deleted or zero).
    const lpAfter = (await ctx.pool.query(
      `SELECT lp_balance::text AS b FROM amm_lp_balances WHERE account_email='trader@x.com'`,
    )).rows[0];
    expect(lpAfter === undefined || lpAfter.b === '0').toBe(true);

    // Pool still has reserves (admin's LP still in the pool).
    const r4 = await getReserves(ctx.pool);
    expect(r4.r).toBeGreaterThan(0n);
    expect(r4.u).toBeGreaterThan(0n);
  });
});
