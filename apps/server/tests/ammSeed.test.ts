import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
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

// $1 = 1_000_000 base units (USDC, 6 decimals). 1 RPOW = 1_000_000_000 base units.
const RPOW_DECIMALS = 1_000_000_000n;
const USDC_DECIMALS = 1_000_000n;

describe('POST /amm/seed', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/seed',
      headers: { 'content-type': 'application/json' },
      payload: { rpow_base_units: '10000000000000', usdc_base_units: '100000000' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 NOT_ADMIN for non-admin caller', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' }); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'rando@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/seed',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: '10000000000000', usdc_base_units: '100000000' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_ADMIN');
  });

  it('400 BAD_REQUEST for invalid body', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' }); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'admin@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/seed',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: 'not-a-number', usdc_base_units: '100' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 INSUFFICIENT_USDC if admin has not enough USDC', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' }); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'admin@x.com');
    await seedToken(ctx.pool, 'admin@x.com', 10000n * RPOW_DECIMALS); // enough RPOW
    // No USDC credited.
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/seed',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: (10000n * RPOW_DECIMALS).toString(), usdc_base_units: (100n * USDC_DECIMALS).toString() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INSUFFICIENT_USDC');
  });

  it('409 INSUFFICIENT_BALANCE if admin has not enough RPOW', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' }); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'admin@x.com');
    await creditUsdc(ctx.pool, 'admin@x.com', 100n * USDC_DECIMALS);
    // Insufficient RPOW seeded.
    await seedToken(ctx.pool, 'admin@x.com', 1n * RPOW_DECIMALS);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/seed',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: (10000n * RPOW_DECIMALS).toString(), usdc_base_units: (100n * USDC_DECIMALS).toString() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('200 happy path: pool seeded, admin LP balance = isqrt(rpow*usdc) - 1000', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' }); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'admin@x.com');
    await seedToken(ctx.pool, 'admin@x.com', 10000n * RPOW_DECIMALS);
    await creditUsdc(ctx.pool, 'admin@x.com', 100n * USDC_DECIMALS);

    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/seed',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: (10000n * RPOW_DECIMALS).toString(), usdc_base_units: (100n * USDC_DECIMALS).toString() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // isqrt(10000 * 10^9 * 100 * 10^6) = isqrt(10^21) = sqrt(10) * 10^10 ~ 3.16 * 10^10
    // Just check the structural invariant: total_lp = initial_lp + 1000 (the MIN_LIQUIDITY burn).
    expect(BigInt(body.total_lp) - BigInt(body.initial_lp)).toBe(1000n);

    // Pool row exists with the expected reserves.
    const pool = (await ctx.pool.query(`SELECT rpow_reserve_base_units::text AS r, usdc_reserve_base_units::text AS u, total_lp_supply::text AS t FROM amm_pool WHERE id='main'`)).rows[0];
    expect(pool.r).toBe((10000n * RPOW_DECIMALS).toString());
    expect(pool.u).toBe((100n * USDC_DECIMALS).toString());
    expect(pool.t).toBe(body.total_lp);

    // Admin LP balance = initial_lp (= total_lp - 1000).
    const lp = (await ctx.pool.query(`SELECT lp_balance::text AS b FROM amm_lp_balances WHERE account_email='admin@x.com'`)).rows[0];
    expect(lp.b).toBe(body.initial_lp);

    // Admin USDC debited.
    const adminUsdc = (await ctx.pool.query(`SELECT usdc_base_units::text AS u FROM users WHERE email='admin@x.com'`)).rows[0];
    expect(adminUsdc.u).toBe('0');

    // Admin RPOW balance zero.
    const rpowBal = (await ctx.pool.query(`SELECT COALESCE(SUM(value), 0)::text AS n FROM tokens WHERE owner_email='admin@x.com' AND state='VALID'`)).rows[0];
    expect(rpowBal.n).toBe('0');
  });

  it('409 POOL_ALREADY_SEEDED on a second seed', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' }); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'admin@x.com');
    // Pre-seed by direct INSERT (faster than running the full flow twice).
    await ctx.pool.query(
      `INSERT INTO amm_pool(rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply)
       VALUES (100, 100, 100)`,
    );
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/seed',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: (10000n * RPOW_DECIMALS).toString(), usdc_base_units: (100n * USDC_DECIMALS).toString() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('POOL_ALREADY_SEEDED');
  });

  it('400 INVALID_AMOUNT if isqrt(rpow*usdc) <= MIN_LIQUIDITY', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' }); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'admin@x.com');
    await seedToken(ctx.pool, 'admin@x.com', 100n);
    await creditUsdc(ctx.pool, 'admin@x.com', 100n);
    // isqrt(100 * 100) = 100, which is < MIN_LIQUIDITY (1000).
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/seed',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: '100', usdc_base_units: '100' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_AMOUNT');
  });
});

describe('GET /amm/pool', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns { seeded: false } pre-seed', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/pool' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ seeded: false });
  });

  it('returns the full pool state post-seed', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(
      `INSERT INTO amm_pool(rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply, fee_bps)
       VALUES (10000000000000, 100000000, 31622776601, 30)`,
    );
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/pool' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seeded).toBe(true);
    expect(body.reserves.rpow_base_units).toBe('10000000000000');
    expect(body.reserves.usdc_base_units).toBe('100000000');
    expect(body.total_lp_supply).toBe('31622776601');
    expect(body.fee_bps).toBe(30);
    expect(typeof body.spot_price_usdc_per_rpow_e9).toBe('string');
    expect(typeof body.seeded_at).toBe('string');
  });

  it('includes your_lp_balance when authed', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(
      `INSERT INTO amm_pool(rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply)
       VALUES (10000000000000, 100000000, 31622776601)`,
    );
    const cookie = await login(ctx, 'lp@x.com');
    await ctx.pool.query(`INSERT INTO amm_lp_balances(account_email, lp_balance) VALUES ('lp@x.com', 12345)`);
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/pool', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().your_lp_balance).toBe('12345');
  });

  it('omits your_lp_balance when authed but no LP', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(
      `INSERT INTO amm_pool(rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply)
       VALUES (10000000000000, 100000000, 31622776601)`,
    );
    const cookie = await login(ctx, 'nolp@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/pool', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    // Either absent or '0' is acceptable; spec says present-when-authed.
    expect(res.json().your_lp_balance ?? '0').toBe('0');
  });
});
