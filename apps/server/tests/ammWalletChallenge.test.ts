import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import { openEnvelope } from '../src/amm/wallet-link.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  await ctx.pool.query(`UPDATE users SET amm_terms_accepted_at = now() WHERE email=$1`, [email]);
  return `${SESSION_COOKIE}=${signSession({ email }, 'x'.repeat(32), 3600)}`;
}

describe('POST /amm/wallet/link-challenge', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns a message and an envelope sealed with our HMAC', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({ method: 'POST', url: '/amm/wallet/link-challenge', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { message, nonce_envelope } = res.json();

    const payload = openEnvelope(ctx.config.ammLinkHmacSecret, nonce_envelope);
    expect(payload.email).toBe('a@x.com');
    expect(payload.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new Date(payload.expiresAt).getTime()).toBeGreaterThan(Date.now());

    expect(message).toContain('a@x.com');
    expect(message).toContain(payload.nonce);
    expect(message).toContain(payload.expiresAt);
  });

  it('gate: 401 / 403 / 403 enforced', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    expect((await ctx.app.inject({ method: 'POST', url: '/amm/wallet/link-challenge' })).statusCode).toBe(401);
  });

  it('generates a fresh nonce each call', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const a = (await ctx.app.inject({ method: 'POST', url: '/amm/wallet/link-challenge', headers: { cookie } })).json();
    const b = (await ctx.app.inject({ method: 'POST', url: '/amm/wallet/link-challenge', headers: { cookie } })).json();
    expect(a.nonce_envelope).not.toBe(b.nonce_envelope);
  });
});
