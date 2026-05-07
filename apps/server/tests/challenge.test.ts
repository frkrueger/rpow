import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email = 'a@b.com'): Promise<string> {
  await ctx.app.inject({ method: 'POST', url: '/auth/request', payload: { email }, headers: { 'content-type': 'application/json' } });
  const tok = ctx.mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1];
  const r = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${tok}` });
  return r.headers['set-cookie'] as string;
}

describe('POST /challenge', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('issues a challenge to a logged-in user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx);
    const res = await ctx.app.inject({ method: 'POST', url: '/challenge', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.challenge_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.nonce_prefix).toMatch(/^[0-9a-f]+$/);
    expect(body.difficulty_bits).toBe(8);
  });

  it('rejects unauthenticated', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'POST', url: '/challenge' });
    expect(res.statusCode).toBe(401);
  });
});
