import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

async function preSeedPool(pool: any, rpow: bigint, usdc: bigint, totalLp: bigint) {
  await pool.query(
    `INSERT INTO amm_pool(rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply)
     VALUES ($1, $2, $3)`,
    [rpow.toString(), usdc.toString(), totalLp.toString()],
  );
}

const RPOW_DECIMALS = 1_000_000_000n;
const USDC_DECIMALS = 1_000_000n;

describe('GET /amm/quote/buy', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/quote/buy?usdc=1000000' });
    expect(res.statusCode).toBe(401);
  });

  it('403 NOT_ALLOWED', async () => {
    const ctx = await makeTestApp({ ammAllowedEmails: 'alice@x.com' }); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/quote/buy?usdc=1000000', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('does NOT require terms (preview-friendly)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 1n * RPOW_DECIMALS, 100n * USDC_DECIMALS, 100n);
    const cookie = await login(ctx, 'a@x.com');
    // terms NOT accepted
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/quote/buy?usdc=1000', headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it('400 INVALID_AMOUNT when query param missing', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/quote/buy', headers: { cookie } });
    expect(res.statusCode).toBe(400);
  });

  it('400 INVALID_AMOUNT on usdc=0', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/quote/buy?usdc=0', headers: { cookie } });
    expect(res.statusCode).toBe(400);
  });

  it('503 POOL_NOT_SEEDED when no pool', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/quote/buy?usdc=1000', headers: { cookie } });
    expect(res.statusCode).toBe(503);
  });

  it('happy path returns reasonable quote', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 1n * RPOW_DECIMALS, 100n * USDC_DECIMALS, 10_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/quote/buy?usdc=1000000', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(BigInt(body.rpow_out)).toBeGreaterThan(0n);
    expect(BigInt(body.fee_base_units)).toBeGreaterThan(0n);
    expect(typeof body.price_impact_bps).toBe('string');
    expect(typeof body.spot_price_usdc_per_rpow_e9).toBe('string');
  });

  it('fee_bps=0 gives zero-fee output matching constant-product formula', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Seed pool with fee_bps=0 (zero fee).
    const R_rpow = 1n * RPOW_DECIMALS;      // 1 RPOW
    const R_usdc = 100n * USDC_DECIMALS;    // 100 USDC
    await ctx.pool.query(
      `INSERT INTO amm_pool(rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply, fee_bps)
       VALUES ($1, $2, $3, 0)`,
      [R_rpow.toString(), R_usdc.toString(), '10000000'],
    );
    const amountIn = 1n * USDC_DECIMALS; // 1 USDC in
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/amm/quote/buy?usdc=${amountIn}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // With fee_bps=0: feeNum=10000, feeDen=10000 → no fee deducted.
    // Expected output = R_rpow × amountIn / (R_usdc + amountIn), integer division.
    const expected = (R_rpow * amountIn) / (R_usdc + amountIn);
    expect(BigInt(body.rpow_out)).toBe(expected);
    // Fee should be zero.
    expect(BigInt(body.fee_base_units)).toBe(0n);
  });
});

describe('GET /amm/quote/sell', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('happy path returns reasonable quote', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 1n * RPOW_DECIMALS, 100n * USDC_DECIMALS, 10_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/quote/sell?rpow=10000000', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(BigInt(body.usdc_out)).toBeGreaterThan(0n);
    expect(typeof body.fee_base_units).toBe('string');
    expect(typeof body.spot_price_usdc_per_rpow_e9).toBe('string');
  });

  it('400 on non-positive rpow', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/quote/sell?rpow=0', headers: { cookie } });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /amm/swaps/recent', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('public — no auth required', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/swaps/recent' });
    expect(res.statusCode).toBe(200);
    expect(res.json().swaps).toEqual([]);
  });

  it('returns swaps with x_handle joined', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(
      `INSERT INTO users(email, x_handle, x_handle_verified_at) VALUES ('a@x.com', 'alice', now())`,
    );
    await ctx.pool.query(
      `INSERT INTO amm_swaps(id, account_email, direction, rpow_delta_base_units, usdc_delta_base_units, fee_base_units, pool_rpow_after, pool_usdc_after, signature)
       VALUES (gen_random_uuid(), 'a@x.com', 'BUY', 12345, -1000000, 3000, 999987655, 101000000, $1)`,
      [Buffer.from('00'.repeat(64), 'hex')],
    );
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/swaps/recent' });
    expect(res.statusCode).toBe(200);
    const swaps = res.json().swaps;
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toMatchObject({
      x_handle: 'alice',
      direction: 'BUY',
      rpow_delta_base_units: '12345',
      usdc_delta_base_units: '-1000000',
      fee_base_units: '3000',
    });
    expect(typeof swaps[0].created_at).toBe('string');
  });

  it('x_handle is null if user has no verified handle', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com')`);
    await ctx.pool.query(
      `INSERT INTO amm_swaps(id, account_email, direction, rpow_delta_base_units, usdc_delta_base_units, fee_base_units, pool_rpow_after, pool_usdc_after, signature)
       VALUES (gen_random_uuid(), 'a@x.com', 'BUY', 12345, -1000000, 3000, 1, 1, $1)`,
      [Buffer.from('00'.repeat(64), 'hex')],
    );
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/swaps/recent' });
    expect(res.statusCode).toBe(200);
    expect(res.json().swaps[0].x_handle).toBeNull();
  });

  it('ordered most-recent first, capped at 50', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com')`);
    // Insert 60 swaps with a synthetic time progression.
    for (let i = 0; i < 60; i++) {
      await ctx.pool.query(
        `INSERT INTO amm_swaps(id, account_email, direction, rpow_delta_base_units, usdc_delta_base_units, fee_base_units, pool_rpow_after, pool_usdc_after, signature, created_at)
         VALUES (gen_random_uuid(), 'a@x.com', 'BUY', $1, -1000, 3, 1, 1, $2, now() - interval '${60 - i} seconds')`,
        [i, Buffer.from('00'.repeat(64), 'hex')],
      );
    }
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/swaps/recent' });
    expect(res.statusCode).toBe(200);
    expect(res.json().swaps).toHaveLength(50);
    // First entry should be the most recent (i=59).
    expect(res.json().swaps[0].rpow_delta_base_units).toBe('59');
  });
});
