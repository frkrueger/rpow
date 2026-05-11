import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import { createHash } from 'node:crypto';
import { verifyLpEventPayload, type LpEventPayload } from '../src/signing.js';

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
    `INSERT INTO amm_pool(rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply) VALUES ($1, $2, $3)`,
    [rpow.toString(), usdc.toString(), totalLp.toString()],
  );
}

const RPOW_DEC = 1_000_000_000n;
const USDC_DEC = 1_000_000n;

describe('POST /amm/lp/add', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/add',
      headers: { 'content-type': 'application/json' },
      payload: { rpow_base_units: '1', usdc_base_units: '1', min_lp_out: '0' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 NOT_ALLOWED', async () => {
    const ctx = await makeTestApp({ ammAllowedEmails: 'alice@x.com' }); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/add',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: '1', usdc_base_units: '1', min_lp_out: '0' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('403 TERMS_NOT_ACCEPTED', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/add',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: '1', usdc_base_units: '1', min_lp_out: '0' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('TERMS_NOT_ACCEPTED');
  });

  it('503 POOL_NOT_SEEDED', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/add',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: '1', usdc_base_units: '1', min_lp_out: '0' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('400 BAD_REQUEST on invalid body', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    await preSeedPool(ctx.pool, 1n * RPOW_DEC, 100n * USDC_DEC, 10_000_000n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/add',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { rpow_base_units: 'foo', usdc_base_units: '1', min_lp_out: '0' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('happy path: proportional inputs fully consumed, LP minted, audit signed', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Pool: 10 RPOW (10_000_000_000) + 100 USDC (100_000_000). total_lp = isqrt(10_000_000_000 * 100_000_000) = isqrt(10^18) = 10^9.
    await preSeedPool(ctx.pool, 10n * RPOW_DEC, 100n * USDC_DEC, 1_000_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    // Provide 1 RPOW + 10 USDC (matches ratio exactly).
    await seedToken(ctx.pool, 'a@x.com', 1n * RPOW_DEC);
    await creditUsdc(ctx.pool, 'a@x.com', 10n * USDC_DEC);

    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/add',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        rpow_base_units: (1n * RPOW_DEC).toString(),
        usdc_base_units: (10n * USDC_DEC).toString(),
        min_lp_out: '0',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // lp_minted = min(1e9 * 1e9 / 1e10, 10e6 * 1e9 / 1e8) = min(1e8, 1e8) = 1e8.
    expect(BigInt(body.lp_minted)).toBe(100_000_000n);
    expect(body.rpow_used).toBe((1n * RPOW_DEC).toString());
    expect(body.usdc_used).toBe((10n * USDC_DEC).toString());
    expect(body.rpow_refunded).toBe('0');
    expect(body.usdc_refunded).toBe('0');

    // Pool reserves grew.
    const pool = (await ctx.pool.query(`SELECT rpow_reserve_base_units::text AS r, usdc_reserve_base_units::text AS u, total_lp_supply::text AS t FROM amm_pool WHERE id='main'`)).rows[0];
    expect(pool.r).toBe((11n * RPOW_DEC).toString());
    expect(pool.u).toBe((110n * USDC_DEC).toString());
    expect(BigInt(pool.t)).toBe(1_100_000_000n);

    // User LP balance.
    const lp = (await ctx.pool.query(`SELECT lp_balance::text AS b FROM amm_lp_balances WHERE account_email='a@x.com'`)).rows[0];
    expect(lp.b).toBe('100000000');

    // User USDC balance debited.
    const u = (await ctx.pool.query(`SELECT usdc_base_units::text AS u FROM users WHERE email='a@x.com'`)).rows[0];
    expect(u.u).toBe('0');

    // User RPOW burned.
    const tok = (await ctx.pool.query(`SELECT COALESCE(SUM(value), 0)::text AS n FROM tokens WHERE owner_email='a@x.com' AND state='VALID'`)).rows[0];
    expect(tok.n).toBe('0');

    // Audit row + signature.
    const ev = (await ctx.pool.query(`SELECT id, type, rpow_delta_base_units::text AS rd, usdc_delta_base_units::text AS ud, lp_delta_base_units::text AS ld, pool_rpow_after::text AS pra, pool_usdc_after::text AS pua, total_lp_after::text AS tla, signature, created_at FROM amm_lp_events WHERE account_email='a@x.com'`)).rows[0];
    expect(ev.type).toBe('ADD');
    expect(ev.rd).toBe((-RPOW_DEC).toString());
    expect(ev.ud).toBe((-10n * USDC_DEC).toString());
    expect(ev.ld).toBe('100000000');

    const payload: LpEventPayload = {
      id: ev.id,
      account_email_hash: createHash('sha256').update('a@x.com').digest('hex'),
      type: 'ADD',
      rpow_delta_base_units: BigInt(ev.rd),
      usdc_delta_base_units: BigInt(ev.ud),
      lp_delta_base_units: BigInt(ev.ld),
      pool_rpow_after: BigInt(ev.pra),
      pool_usdc_after: BigInt(ev.pua),
      total_lp_after: BigInt(ev.tla),
      created_at: ev.created_at.toISOString(),
    };
    expect(verifyLpEventPayload(payload, ev.signature, ctx.app.config.signingPublicKeyHex)).toBe(true);
  });

  it('imbalanced inputs: USDC excess refunded', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 10n * RPOW_DEC, 100n * USDC_DEC, 1_000_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    // Provide 1 RPOW + 20 USDC (USDC is 2x the proportion).
    await seedToken(ctx.pool, 'a@x.com', 1n * RPOW_DEC);
    await creditUsdc(ctx.pool, 'a@x.com', 20n * USDC_DEC);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/add',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        rpow_base_units: (1n * RPOW_DEC).toString(),
        usdc_base_units: (20n * USDC_DEC).toString(),
        min_lp_out: '0',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Only 1 RPOW + 10 USDC used; 10 USDC refunded.
    expect(body.rpow_used).toBe((1n * RPOW_DEC).toString());
    expect(body.usdc_used).toBe((10n * USDC_DEC).toString());
    expect(body.rpow_refunded).toBe('0');
    expect(body.usdc_refunded).toBe((10n * USDC_DEC).toString());

    // User USDC balance: started 20 USDC, used 10, leaves 10.
    const u = (await ctx.pool.query(`SELECT usdc_base_units::text AS u FROM users WHERE email='a@x.com'`)).rows[0];
    expect(u.u).toBe((10n * USDC_DEC).toString());
  });

  it('400 SLIPPAGE_EXCEEDED when min_lp_out too high', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 10n * RPOW_DEC, 100n * USDC_DEC, 1_000_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    await seedToken(ctx.pool, 'a@x.com', 1n * RPOW_DEC);
    await creditUsdc(ctx.pool, 'a@x.com', 10n * USDC_DEC);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/add',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        rpow_base_units: (1n * RPOW_DEC).toString(),
        usdc_base_units: (10n * USDC_DEC).toString(),
        min_lp_out: '999999999999999999',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('SLIPPAGE_EXCEEDED');
  });

  it('400 INSUFFICIENT_USDC', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 10n * RPOW_DEC, 100n * USDC_DEC, 1_000_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    await seedToken(ctx.pool, 'a@x.com', 1n * RPOW_DEC);
    // 0 USDC
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/add',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        rpow_base_units: (1n * RPOW_DEC).toString(),
        usdc_base_units: (10n * USDC_DEC).toString(),
        min_lp_out: '0',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INSUFFICIENT_USDC');
  });

  it('409 INSUFFICIENT_BALANCE', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 10n * RPOW_DEC, 100n * USDC_DEC, 1_000_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    await creditUsdc(ctx.pool, 'a@x.com', 10n * USDC_DEC);
    // No RPOW.
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/add',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        rpow_base_units: (1n * RPOW_DEC).toString(),
        usdc_base_units: (10n * USDC_DEC).toString(),
        min_lp_out: '0',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });
});
