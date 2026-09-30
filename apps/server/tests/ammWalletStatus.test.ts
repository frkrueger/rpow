import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  await ctx.pool.query(`UPDATE users SET amm_terms_accepted_at = now() WHERE email=$1`, [email]);
  return `${SESSION_COOKIE}=${signSession({ email }, 'x'.repeat(32), 3600)}`;
}

describe('GET /amm/wallet/status', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    expect((await ctx.app.inject({ method: 'GET', url: '/amm/wallet/status' })).statusCode).toBe(401);
  });

  it('returns linked_pubkey: null when never linked', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/wallet/status', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ linked_pubkey: null });
  });

  it('returns linked_pubkey when set', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await ctx.pool.query(`UPDATE users SET solana_pubkey='PK1' WHERE email='a@x.com'`);
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/wallet/status', headers: { cookie } });
    expect(res.json()).toEqual({ linked_pubkey: 'PK1' });
  });

  it('403 NOT_ALLOWED when caller not in AMM_ALLOWED_EMAILS', async () => {
    const ctx = await makeTestApp({ ammAllowedEmails: 'someone@else.com' }); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/wallet/status', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('403 TERMS_NOT_ACCEPTED when terms not yet accepted', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com')`);
    // skip the terms-accept step
    const cookie = `${SESSION_COOKIE}=${signSession({ email: 'a@x.com' }, 'x'.repeat(32), 3600)}`;
    const res = await ctx.app.inject({ method: 'GET', url: '/amm/wallet/status', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('TERMS_NOT_ACCEPTED');
  });
});
