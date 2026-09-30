import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('migration 017_user_favorites', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('creates the user_favorites table with the expected columns', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const colsRes = await ctx.pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'user_favorites' AND table_schema = current_schema()
       ORDER BY ordinal_position`,
    );
    const names = colsRes.rows.map((r: any) => r.column_name);
    expect(names).toEqual(['account_email', 'favorite_email', 'created_at']);
  });

  it('enforces the (account_email, favorite_email) primary key', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com'), ('b@x.com')`);
    await ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com','b@x.com')`);
    await expect(
      ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com','b@x.com')`),
    ).rejects.toThrow();
  });

  it('rejects self-favorite at the CHECK constraint', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com')`);
    await expect(
      ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com','a@x.com')`),
    ).rejects.toThrow();
  });

  it('cascade-deletes when either user is removed', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x.com'), ('b@x.com')`);
    await ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('a@x.com','b@x.com')`);
    await ctx.pool.query(`DELETE FROM users WHERE email = 'b@x.com'`);
    const r = await ctx.pool.query(`SELECT count(*)::int AS n FROM user_favorites`);
    expect(r.rows[0].n).toBe(0);
  });
});
