import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

async function markVerified(pool: any, email: string, handle: string) {
  await pool.query(
    `UPDATE users SET x_handle = $1, x_handle_verified_at = now() WHERE email = $2`,
    [handle, email],
  );
}

describe('POST /api/favorites', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { 'content-type': 'application/json' },
      payload: { x_handle: 'alice' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('400 BAD_REQUEST on invalid body', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { not_a_handle: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404 USER_NOT_FOUND when x_handle does not exist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { x_handle: 'nobody' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('USER_NOT_FOUND');
  });

  it('400 SELF_FAVORITE when favoriting yourself', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await markVerified(ctx.pool, 'a@x.com', 'alice');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { x_handle: 'alice' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('SELF_FAVORITE');
  });

  it('200 happy path — inserts and is idempotent', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await login(ctx, 'b@x.com');
    await markVerified(ctx.pool, 'b@x.com', 'bob');
    const r1 = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { x_handle: 'bob' },
    });
    expect(r1.statusCode).toBe(200);
    expect(typeof r1.json().created_at).toBe('string');

    const r2 = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { x_handle: 'bob' },
    });
    expect(r2.statusCode).toBe(200);

    const rows = await ctx.pool.query(
      `SELECT account_email, favorite_email FROM user_favorites WHERE account_email = 'a@x.com'`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({ account_email: 'a@x.com', favorite_email: 'b@x.com' });
  });

  it('case-insensitive handle resolution', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await login(ctx, 'b@x.com');
    await markVerified(ctx.pool, 'b@x.com', 'BobTheGreat');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { x_handle: 'bobthegreat' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('409 FAVORITE_LIMIT_REACHED after 100 favorites', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    for (let i = 0; i < 100; i++) {
      await ctx.pool.query(
        `INSERT INTO users(email, x_handle, x_handle_verified_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
        [`u${i}@x.com`, `u${i}`],
      );
      await ctx.pool.query(
        `INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com', $1)`,
        [`u${i}@x.com`],
      );
    }
    await ctx.pool.query(
      `INSERT INTO users(email, x_handle, x_handle_verified_at) VALUES ('overflow@x.com','overflow', now())`,
    );
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/favorites',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { x_handle: 'overflow' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('FAVORITE_LIMIT_REACHED');
  });
});

describe('GET /api/favorites', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/favorites' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the caller\'s favorites with x_handle + avatar, NEVER emails', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await login(ctx, 'b@x.com');
    await markVerified(ctx.pool, 'b@x.com', 'bob');
    await ctx.pool.query(`UPDATE users SET x_avatar_url = 'https://x.com/avatar/bob.jpg' WHERE email = 'b@x.com'`);
    await ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com','b@x.com')`);
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/favorites',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.favorites).toHaveLength(1);
    expect(body.favorites[0]).toMatchObject({
      x_handle: 'bob',
      x_avatar_url: 'https://x.com/avatar/bob.jpg',
    });
    expect(typeof body.favorites[0].created_at).toBe('string');
    // Verify NO email leakage in the response.
    expect(JSON.stringify(body)).not.toContain('b@x.com');
    expect(JSON.stringify(body)).not.toContain('a@x.com');
  });

  it('returns empty list if no favorites', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/favorites', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().favorites).toEqual([]);
  });
});

describe('DELETE /api/favorites/:x_handle', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'DELETE', url: '/api/favorites/bob' });
    expect(res.statusCode).toBe(401);
  });

  it('200 happy path removes the favorite', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await login(ctx, 'b@x.com');
    await markVerified(ctx.pool, 'b@x.com', 'bob');
    await ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com','b@x.com')`);
    const res = await ctx.app.inject({
      method: 'DELETE', url: '/api/favorites/bob',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    const rows = await ctx.pool.query(`SELECT * FROM user_favorites WHERE account_email = 'a@x.com'`);
    expect(rows.rowCount).toBe(0);
  });

  it('200 ok even if the favorite did not exist (idempotent delete)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@x.com');
    await login(ctx, 'b@x.com');
    await markVerified(ctx.pool, 'b@x.com', 'bob');
    const res = await ctx.app.inject({
      method: 'DELETE', url: '/api/favorites/bob',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
