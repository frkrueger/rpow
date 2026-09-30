import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import { verifySwapPayload, type SwapPayload } from '../src/signing.js';
import { createHash } from 'node:crypto';

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

async function preSeedPool(pool: any, rpow: bigint, usdc: bigint, totalLp: bigint) {
  await pool.query(
    `INSERT INTO amm_pool(rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply)
     VALUES ($1, $2, $3)`,
    [rpow.toString(), usdc.toString(), totalLp.toString()],
  );
}

const RPOW_DECIMALS = 1_000_000_000n;
const USDC_DECIMALS = 1_000_000n;

describe('POST /amm/buy', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/buy',
      headers: { 'content-type': 'application/json' },
      payload: { usdc_base_units: '1000000', min_rpow_out: '0' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 NOT_ALLOWED if not in AMM_ALLOWED_EMAILS', async () => {
    const ctx = await makeTestApp({ ammAllowedEmails: 'alice@x.com' }); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/buy',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { usdc_base_units: '1000000', min_rpow_out: '0' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_ALLOWED');
  });

  it('403 TERMS_NOT_ACCEPTED when terms not accepted', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/buy',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { usdc_base_units: '1000000', min_rpow_out: '0' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('TERMS_NOT_ACCEPTED');
  });

  it('503 POOL_NOT_SEEDED when pool has no row', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/buy',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { usdc_base_units: '1000000', min_rpow_out: '0' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('POOL_NOT_SEEDED');
  });

  it('happy path: USDC debited, RPOW minted, reserves updated, invariant holds', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Use a 1:100 RPOW:USDC pool so buying 1 USDC yields ~0.01 RPOW — well under mintMaxSupply=21.
    await preSeedPool(ctx.pool, 1n * RPOW_DECIMALS, 100n * USDC_DECIMALS, 10_000_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    await creditUsdc(ctx.pool, 'a@x.com', 1n * USDC_DECIMALS); // 1 USDC

    const oldPool = (await ctx.pool.query(`SELECT rpow_reserve_base_units::text AS r, usdc_reserve_base_units::text AS u FROM amm_pool WHERE id='main'`)).rows[0];
    const oldK = BigInt(oldPool.r) * BigInt(oldPool.u);

    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/buy',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { usdc_base_units: USDC_DECIMALS.toString(), min_rpow_out: '0' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(BigInt(body.rpow_received)).toBeGreaterThan(0n);
    expect(typeof body.swap_id).toBe('string');
    expect(typeof body.signature_hex).toBe('string');

    // User: USDC = 0, RPOW token of value = rpow_received exists.
    const u = (await ctx.pool.query(`SELECT usdc_base_units::text AS u FROM users WHERE email='a@x.com'`)).rows[0];
    expect(u.u).toBe('0');
    const tokens = (await ctx.pool.query(`SELECT COALESCE(SUM(value), 0)::text AS n FROM tokens WHERE owner_email='a@x.com' AND state='VALID'`)).rows[0];
    expect(tokens.n).toBe(body.rpow_received);

    // Reserves updated.
    const newPool = (await ctx.pool.query(`SELECT rpow_reserve_base_units::text AS r, usdc_reserve_base_units::text AS u FROM amm_pool WHERE id='main'`)).rows[0];
    expect(BigInt(newPool.u)).toBe(BigInt(oldPool.u) + USDC_DECIMALS);
    expect(BigInt(newPool.r)).toBe(BigInt(oldPool.r) - BigInt(body.rpow_received));

    // Invariant: new k ≥ old k.
    const newK = BigInt(newPool.r) * BigInt(newPool.u);
    expect(newK).toBeGreaterThanOrEqual(oldK);

    // Audit row exists + signature verifies.
    const swap = (await ctx.pool.query(`SELECT id, direction, rpow_delta_base_units::text AS rpow_delta, usdc_delta_base_units::text AS usdc_delta, fee_base_units::text AS fee, pool_rpow_after::text AS pra, pool_usdc_after::text AS pua, signature, created_at FROM amm_swaps WHERE id = $1`, [body.swap_id])).rows[0];
    expect(swap.direction).toBe('BUY');
    expect(swap.rpow_delta).toBe(body.rpow_received);
    expect(swap.usdc_delta).toBe((-USDC_DECIMALS).toString());

    const payload: SwapPayload = {
      id: swap.id,
      account_email_hash: createHash('sha256').update('a@x.com').digest('hex'),
      direction: 'BUY',
      rpow_delta_base_units: BigInt(swap.rpow_delta),
      usdc_delta_base_units: BigInt(swap.usdc_delta),
      fee_base_units: BigInt(swap.fee),
      pool_rpow_after: BigInt(swap.pra),
      pool_usdc_after: BigInt(swap.pua),
      created_at: swap.created_at.toISOString(),
    };
    expect(verifySwapPayload(payload, swap.signature, ctx.app.config.signingPublicKeyHex)).toBe(true);
  });

  it('400 SLIPPAGE_EXCEEDED when min_rpow_out is too high', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 1n * RPOW_DECIMALS, 100n * USDC_DECIMALS, 10_000_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    await creditUsdc(ctx.pool, 'a@x.com', USDC_DECIMALS);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/buy',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { usdc_base_units: USDC_DECIMALS.toString(), min_rpow_out: (1000n * RPOW_DECIMALS).toString() }, // impossibly high
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('SLIPPAGE_EXCEEDED');
  });

  it('400 INSUFFICIENT_USDC when caller has too little USDC', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 1n * RPOW_DECIMALS, 100n * USDC_DECIMALS, 10_000_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    // 0 USDC credited.
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/buy',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { usdc_base_units: USDC_DECIMALS.toString(), min_rpow_out: '0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INSUFFICIENT_USDC');
  });
});

describe('POST /amm/sell', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('happy path: RPOW burned, USDC credited, reserves updated, invariant holds', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 10000n * RPOW_DECIMALS, 100n * USDC_DECIMALS, 31_622_776_601n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    await seedToken(ctx.pool, 'a@x.com', 100n * RPOW_DECIMALS);

    const oldPool = (await ctx.pool.query(`SELECT rpow_reserve_base_units::text AS r, usdc_reserve_base_units::text AS u FROM amm_pool WHERE id='main'`)).rows[0];
    const oldK = BigInt(oldPool.r) * BigInt(oldPool.u);

    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/sell',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: (100n * RPOW_DECIMALS).toString(), min_usdc_out: '0' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(BigInt(body.usdc_received)).toBeGreaterThan(0n);

    // User: RPOW burned, USDC credited.
    const tokens = (await ctx.pool.query(`SELECT COALESCE(SUM(value), 0)::text AS n FROM tokens WHERE owner_email='a@x.com' AND state='VALID'`)).rows[0];
    expect(tokens.n).toBe('0');
    const u = (await ctx.pool.query(`SELECT usdc_base_units::text AS u FROM users WHERE email='a@x.com'`)).rows[0];
    expect(u.u).toBe(body.usdc_received);

    // Reserves: RPOW grew by FULL amountIn, USDC shrank by output.
    const newPool = (await ctx.pool.query(`SELECT rpow_reserve_base_units::text AS r, usdc_reserve_base_units::text AS u FROM amm_pool WHERE id='main'`)).rows[0];
    expect(BigInt(newPool.r)).toBe(BigInt(oldPool.r) + 100n * RPOW_DECIMALS);
    expect(BigInt(newPool.u)).toBe(BigInt(oldPool.u) - BigInt(body.usdc_received));

    const newK = BigInt(newPool.r) * BigInt(newPool.u);
    expect(newK).toBeGreaterThanOrEqual(oldK);
  });

  it('400 SLIPPAGE_EXCEEDED when min_usdc_out is too high', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 10000n * RPOW_DECIMALS, 100n * USDC_DECIMALS, 31_622_776_601n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    await seedToken(ctx.pool, 'a@x.com', 100n * RPOW_DECIMALS);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/sell',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: (100n * RPOW_DECIMALS).toString(), min_usdc_out: (1000n * USDC_DECIMALS).toString() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('SLIPPAGE_EXCEEDED');
  });

  it('409 INSUFFICIENT_BALANCE for SELL with no RPOW', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 10000n * RPOW_DECIMALS, 100n * USDC_DECIMALS, 31_622_776_601n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    // no RPOW
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/sell',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: (100n * RPOW_DECIMALS).toString(), min_usdc_out: '0' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });
});
