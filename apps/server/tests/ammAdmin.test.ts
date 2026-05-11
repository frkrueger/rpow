import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

describe('POST /amm/admin/credit-usdc', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/credit-usdc',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'a@x.com', amount_base_units: '1000000' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 NOT_ADMIN when caller is not in AMM_ADMIN_EMAILS', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'rando@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/credit-usdc',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { email: 'a@x.com', amount_base_units: '1000000' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_ADMIN');
  });

  it('403 NOT_ADMIN even when AMM_ADMIN_EMAILS is "*" (wildcard intentionally rejected)', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: '*' });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'anyone@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/credit-usdc',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { email: 'a@x.com', amount_base_units: '1000000' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('400 BAD_REQUEST on invalid body', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'admin@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/credit-usdc',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { email: 'not-an-email', amount_base_units: '0' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('200 credits USDC and auto-creates the target user row', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'admin@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/credit-usdc',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { email: 'newuser@x.com', amount_base_units: '500000000' }, // 500 USDC
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      email: 'newuser@x.com',
      new_balance_base_units: '500000000',
    });
    const r = await ctx.pool.query<{ n: string }>(
      `SELECT usdc_base_units::text AS n FROM users WHERE email = 'newuser@x.com'`,
    );
    expect(r.rows[0].n).toBe('500000000');
  });

  it('200 accumulates on repeat credits', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'admin@x.com');
    await ctx.app.inject({
      method: 'POST', url: '/amm/admin/credit-usdc',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { email: 'a@x.com', amount_base_units: '1000000' },
    });
    const r2 = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/credit-usdc',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { email: 'a@x.com', amount_base_units: '2000000' },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().new_balance_base_units).toBe('3000000');
  });

  it('lowercases the target email', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com' });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'admin@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/credit-usdc',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { email: 'MixedCase@X.com', amount_base_units: '1000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('mixedcase@x.com');
  });

  it('409 USDC_POOL_CAP_EXCEEDED when credit would push total over the cap', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com', ammUsdcPoolCapBaseUnits: 10_000_000 }); // 10 USDC cap
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'admin@x.com');
    // Credit 8 USDC — under cap.
    const r1 = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/credit-usdc',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { email: 'a@x.com', amount_base_units: '8000000' },
    });
    expect(r1.statusCode).toBe(200);
    // Try to credit 3 more USDC — would push total to 11, over 10 cap.
    const r2 = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/credit-usdc',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { email: 'b@x.com', amount_base_units: '3000000' },
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe('USDC_POOL_CAP_EXCEEDED');
  });

  // Concurrent-credit TOCTOU protection: admin.ts wraps the cap check + UPDATE
  // in withTx + pg_advisory_xact_lock(hashtext('amm_credit')). All concurrent
  // admin credits serialize on that lock so two requests cannot both read the
  // same currentTotal, both pass the cap, and both commit. A deterministic unit
  // test for this race is impractical (Promise.all over inject() is sequential
  // under the hood in Fastify's light-my-request), but the advisory lock
  // guarantees correctness at the DB level.

  it('cap check sums across all users', async () => {
    const ctx = await makeTestApp({ ammAdminEmails: 'admin@x.com', ammUsdcPoolCapBaseUnits: 5_000_000 }); // 5 USDC cap
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'admin@x.com');
    // Credit 3 USDC to a, 2 USDC to b — total exactly at cap (5).
    await ctx.app.inject({
      method: 'POST', url: '/amm/admin/credit-usdc',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { email: 'a@x.com', amount_base_units: '3000000' },
    });
    await ctx.app.inject({
      method: 'POST', url: '/amm/admin/credit-usdc',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { email: 'b@x.com', amount_base_units: '2000000' },
    });
    // One more base unit would breach.
    const r = await ctx.app.inject({
      method: 'POST', url: '/amm/admin/credit-usdc',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { email: 'c@x.com', amount_base_units: '1' },
    });
    expect(r.statusCode).toBe(409);
  });
});
