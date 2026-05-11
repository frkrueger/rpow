import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import { verifyLpEventPayload, type LpEventPayload } from '../src/signing.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}
async function acceptTerms(ctx: any, email: string) {
  await ctx.pool.query(`UPDATE users SET amm_terms_accepted_at = now() WHERE email = $1`, [email]);
}
async function preSeedPool(pool: any, rpow: bigint, usdc: bigint, totalLp: bigint) {
  await pool.query(
    `INSERT INTO amm_pool(rpow_reserve_base_units, usdc_reserve_base_units, total_lp_supply) VALUES ($1, $2, $3)`,
    [rpow.toString(), usdc.toString(), totalLp.toString()],
  );
}
async function preSeedLp(pool: any, email: string, lp: bigint) {
  await pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  await pool.query(
    `INSERT INTO amm_lp_balances(account_email, lp_balance) VALUES ($1, $2) ON CONFLICT (account_email) DO UPDATE SET lp_balance = $2`,
    [email, lp.toString()],
  );
}

const RPOW_DEC = 1_000_000_000n;
const USDC_DEC = 1_000_000n;

describe('POST /amm/lp/remove', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/remove',
      headers: { 'content-type': 'application/json' },
      payload: { lp_base_units: '1', min_rpow_out: '0', min_usdc_out: '0' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 NOT_ALLOWED', async () => {
    const ctx = await makeTestApp({ ammAllowedEmails: 'alice@x.com' }); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/remove',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { lp_base_units: '1', min_rpow_out: '0', min_usdc_out: '0' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('403 TERMS_NOT_ACCEPTED', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/remove',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { lp_base_units: '1', min_rpow_out: '0', min_usdc_out: '0' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('TERMS_NOT_ACCEPTED');
  });

  it('503 POOL_NOT_SEEDED', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/remove',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { lp_base_units: '1', min_rpow_out: '0', min_usdc_out: '0' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('400 BAD_REQUEST on invalid body', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    await preSeedPool(ctx.pool, 10n * RPOW_DEC, 100n * USDC_DEC, 1_000_000_000n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/remove',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { lp_base_units: 'foo', min_rpow_out: '0', min_usdc_out: '0' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('409 INSUFFICIENT_LP when caller has no LP', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 10n * RPOW_DEC, 100n * USDC_DEC, 1_000_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/remove',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { lp_base_units: '1', min_rpow_out: '0', min_usdc_out: '0' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INSUFFICIENT_LP');
  });

  it('happy path: LP burned pro-rata, RPOW + USDC credited, signed', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Pool: 10 RPOW + 100 USDC, total_lp = 1e9. User holds 1e8 LP (10% of pool).
    await preSeedPool(ctx.pool, 10n * RPOW_DEC, 100n * USDC_DEC, 1_000_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    await preSeedLp(ctx.pool, 'a@x.com', 100_000_000n);

    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/remove',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        lp_base_units: '100000000',
        min_rpow_out: '0',
        min_usdc_out: '0',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 10% of reserves: 1 RPOW + 10 USDC.
    expect(body.rpow_received).toBe((1n * RPOW_DEC).toString());
    expect(body.usdc_received).toBe((10n * USDC_DEC).toString());

    // Pool reserves shrunk; total_lp -= 1e8.
    const pool = (await ctx.pool.query(`SELECT rpow_reserve_base_units::text AS r, usdc_reserve_base_units::text AS u, total_lp_supply::text AS t FROM amm_pool WHERE id='main'`)).rows[0];
    expect(pool.r).toBe((9n * RPOW_DEC).toString());
    expect(pool.u).toBe((90n * USDC_DEC).toString());
    expect(pool.t).toBe('900000000');

    // User LP balance is now 0; row may be deleted or balance=0.
    const lpRes = (await ctx.pool.query(`SELECT lp_balance::text AS b FROM amm_lp_balances WHERE account_email='a@x.com'`)).rows[0];
    expect(lpRes === undefined || lpRes.b === '0').toBe(true);

    // User got minted RPOW + credited USDC.
    const tok = (await ctx.pool.query(`SELECT COALESCE(SUM(value), 0)::text AS n FROM tokens WHERE owner_email='a@x.com' AND state='VALID'`)).rows[0];
    expect(tok.n).toBe((1n * RPOW_DEC).toString());
    const u = (await ctx.pool.query(`SELECT usdc_base_units::text AS u FROM users WHERE email='a@x.com'`)).rows[0];
    expect(u.u).toBe((10n * USDC_DEC).toString());

    // Audit + signature.
    const ev = (await ctx.pool.query(`SELECT id, type, rpow_delta_base_units::text AS rd, usdc_delta_base_units::text AS ud, lp_delta_base_units::text AS ld, pool_rpow_after::text AS pra, pool_usdc_after::text AS pua, total_lp_after::text AS tla, signature, created_at FROM amm_lp_events WHERE account_email='a@x.com'`)).rows[0];
    expect(ev.type).toBe('REMOVE');
    expect(ev.rd).toBe((1n * RPOW_DEC).toString());
    expect(ev.ud).toBe((10n * USDC_DEC).toString());
    expect(ev.ld).toBe('-100000000');
    const payload: LpEventPayload = {
      id: ev.id,
      account_email_hash: createHash('sha256').update('a@x.com').digest('hex'),
      type: 'REMOVE',
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

  it('400 SLIPPAGE_EXCEEDED when min_rpow_out too high', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 10n * RPOW_DEC, 100n * USDC_DEC, 1_000_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    await preSeedLp(ctx.pool, 'a@x.com', 100_000_000n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/remove',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { lp_base_units: '100000000', min_rpow_out: '999999999999999999', min_usdc_out: '0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('SLIPPAGE_EXCEEDED');
  });

  it('400 SLIPPAGE_EXCEEDED when min_usdc_out too high', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 10n * RPOW_DEC, 100n * USDC_DEC, 1_000_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    await preSeedLp(ctx.pool, 'a@x.com', 100_000_000n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/remove',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { lp_base_units: '100000000', min_rpow_out: '0', min_usdc_out: '999999999999999999' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('SLIPPAGE_EXCEEDED');
  });

  it('partial remove leaves balance > 0', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await preSeedPool(ctx.pool, 10n * RPOW_DEC, 100n * USDC_DEC, 1_000_000_000n);
    const cookie = await login(ctx, 'a@x.com');
    await acceptTerms(ctx, 'a@x.com');
    await preSeedLp(ctx.pool, 'a@x.com', 100_000_000n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/lp/remove',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { lp_base_units: '50000000', min_rpow_out: '0', min_usdc_out: '0' },
    });
    expect(res.statusCode).toBe(200);
    const lp = (await ctx.pool.query(`SELECT lp_balance::text AS b FROM amm_lp_balances WHERE account_email='a@x.com'`)).rows[0];
    expect(lp.b).toBe('50000000');
  });
});
