import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

describe('POST /amm/accept-terms', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'POST', url: '/amm/accept-terms' });
    expect(res.statusCode).toBe(401);
  });

  it('403 NOT_ALLOWED when caller is not in AMM_ALLOWED_EMAILS', async () => {
    const ctx = await makeTestApp({ ammAllowedEmails: 'alice@x.com' });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/accept-terms',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_ALLOWED');
  });

  it('200 sets amm_terms_accepted_at on first call', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/amm/accept-terms',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().accepted_at).toBe('string');
    const r = await ctx.pool.query<{ amm_terms_accepted_at: Date }>(
      `SELECT amm_terms_accepted_at FROM users WHERE email = 'a@x.com'`,
    );
    expect(r.rows[0].amm_terms_accepted_at).not.toBeNull();
  });

  it('idempotent — second call returns the original timestamp untouched', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const r1 = await ctx.app.inject({
      method: 'POST', url: '/amm/accept-terms',
      headers: { cookie },
    });
    expect(r1.statusCode).toBe(200);
    const first = r1.json().accepted_at;
    // small wait so a re-set would visibly differ
    await new Promise(res => setTimeout(res, 20));
    const r2 = await ctx.app.inject({
      method: 'POST', url: '/amm/accept-terms',
      headers: { cookie },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().accepted_at).toBe(first);
  });

  it('/me exposes amm_terms_accepted_at + usdc_base_units', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    // Pre-accept
    await ctx.app.inject({ method: 'POST', url: '/amm/accept-terms', headers: { cookie } });
    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json();
    expect(typeof me.amm_terms_accepted_at).toBe('string');
    expect(me.usdc_base_units).toBe('0');
  });

  it('/me exposes null amm_terms_accepted_at when not yet accepted', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } })).json();
    expect(me.amm_terms_accepted_at).toBeNull();
    expect(me.usdc_base_units).toBe('0');
  });
});
