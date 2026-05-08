import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('GET /auth/verify', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('exchanges valid token for session cookie + creates user', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    await ctx.app.inject({ method: 'POST', url: '/auth/request', headers: { 'content-type': 'application/json' }, payload: { email: 'frk@x.com' } });
    const link = ctx.mailer.outbox[0]!.text.match(/token=([\w-]+)/)![1];
    const res = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${link}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers['set-cookie']).toMatch(/rpow_session=/);
    const { rows } = await ctx.pool.query('SELECT email FROM users');
    expect(rows[0]!.email).toBe('frk@x.com');
  });

  it('rejects an unknown token', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/auth/verify?token=nope' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a reused token', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    await ctx.app.inject({ method: 'POST', url: '/auth/request', headers: { 'content-type': 'application/json' }, payload: { email: 'a@b.com' } });
    const link = ctx.mailer.outbox[0]!.text.match(/token=([\w-]+)/)![1];
    await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${link}` });
    const res2 = await ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${link}` });
    expect(res2.statusCode).toBe(400);
  });

  it('atomically consumes a magic link under concurrent verification', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    await ctx.app.inject({ method: 'POST', url: '/auth/request', headers: { 'content-type': 'application/json' }, payload: { email: 'race@x.com' } });
    const link = ctx.mailer.outbox[0]!.text.match(/token=([\w-]+)/)![1];

    const originalQuery = ctx.pool.query.bind(ctx.pool);
    let releaseSelects: (() => void) | undefined;
    const selectsReleased = new Promise<void>((resolve) => { releaseSelects = resolve; });
    let matchedSelects = 0;
    (ctx.pool as any).query = async (query: unknown, ...args: unknown[]) => {
      const text = typeof query === 'string' ? query : (query as { text?: string })?.text;
      if (typeof text === 'string' && text.includes('FROM magic_links WHERE token_hash=$1') && text.includes('used_at IS NULL')) {
        const result = await (originalQuery as any)(query, ...args);
        matchedSelects += 1;
        if (matchedSelects === 2) releaseSelects!();
        await selectsReleased;
        return result;
      }
      return (originalQuery as any)(query, ...args);
    };

    const [a, b] = await Promise.all([
      ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${link}` }),
      ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${link}` }),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([302, 400]);
    const cookies = [a.headers['set-cookie'], b.headers['set-cookie']].filter(Boolean);
    expect(cookies).toHaveLength(1);
  });
});
