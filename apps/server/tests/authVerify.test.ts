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
    let releaseAtomicUpdates: (() => void) | undefined;
    let rejectAtomicUpdates: ((reason: Error) => void) | undefined;
    const atomicUpdatesReleased = new Promise<void>((resolve, reject) => {
      releaseAtomicUpdates = resolve;
      rejectAtomicUpdates = reject;
    });
    const atomicUpdateTimeout = setTimeout(() => {
      rejectAtomicUpdates?.(new Error('timed out waiting for both atomic magic-link UPDATE queries'));
    }, 1000);
    let matchedAtomicUpdates = 0;
    (ctx.pool as any).query = async (query: unknown, ...args: unknown[]) => {
      const rawText = typeof query === 'string' ? query : (query as { text?: string })?.text;
      const text = typeof rawText === 'string' ? rawText.replace(/\s+/g, ' ').trim().toLowerCase() : '';
      if (text.includes('from magic_links where token_hash=$1') && text.includes('used_at is null')) {
        throw new Error('auth/verify used the old SELECT magic-link lookup instead of the atomic UPDATE');
      }
      if (
        text.startsWith('update magic_links') &&
        text.includes('where token_hash=$1') &&
        text.includes('used_at is null') &&
        text.includes('returning id, email')
      ) {
        matchedAtomicUpdates += 1;
        if (matchedAtomicUpdates === 2) {
          clearTimeout(atomicUpdateTimeout);
          releaseAtomicUpdates!();
        }
        await atomicUpdatesReleased;
      }
      return (originalQuery as any)(query, ...args);
    };

    let a;
    let b;
    try {
      [a, b] = await Promise.all([
        ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${link}` }),
        ctx.app.inject({ method: 'GET', url: `/auth/verify?token=${link}` }),
      ]);
    } finally {
      clearTimeout(atomicUpdateTimeout);
      (ctx.pool as any).query = originalQuery;
    }

    expect(matchedAtomicUpdates).toBe(2);
    expect([a.statusCode, b.statusCode].sort()).toEqual([302, 400]);
    const cookies = [a.headers['set-cookie'], b.headers['set-cookie']].filter(Boolean);
    expect(cookies).toHaveLength(1);
  });
});
