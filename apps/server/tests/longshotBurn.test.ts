import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { burnFromUser } from '../src/longshot/burn.js';

async function seedToken(pool: any, email: string, value: bigint) {
  await pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, server_sig)
     VALUES($1, $2, $3, 'VALID', '\\x00')`,
    [randomUUID(), email, value.toString()],
  );
}

describe('burnFromUser', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('invalidates one token exactly equal to amount', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES('a@b.com')`);
    await seedToken(ctx.pool, 'a@b.com', 100n);
    const client = await ctx.pool.connect();
    try {
      await client.query(`BEGIN`);
      await burnFromUser(client, 'a@b.com', 100n, '11'.repeat(32));
      await client.query(`COMMIT`);
    } finally {
      client.release();
    }
    const valid = await ctx.pool.query<{ count: string }>(
      `SELECT count(*)::text FROM tokens WHERE owner_email='a@b.com' AND state='VALID'`,
    );
    expect(valid.rows[0].count).toBe('0');
  });

  it('mints change for overage', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES('a@b.com')`);
    await seedToken(ctx.pool, 'a@b.com', 100n);
    const client = await ctx.pool.connect();
    try {
      await client.query(`BEGIN`);
      await burnFromUser(client, 'a@b.com', 30n, '11'.repeat(32));
      await client.query(`COMMIT`);
    } finally {
      client.release();
    }
    const balance = await ctx.pool.query<{ sum: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS sum FROM tokens WHERE owner_email='a@b.com' AND state='VALID'`,
    );
    expect(balance.rows[0].sum).toBe('70');
  });

  it('combines multiple tokens to reach amount', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES('a@b.com')`);
    await seedToken(ctx.pool, 'a@b.com', 30n);
    await seedToken(ctx.pool, 'a@b.com', 30n);
    await seedToken(ctx.pool, 'a@b.com', 30n);
    const client = await ctx.pool.connect();
    try {
      await client.query(`BEGIN`);
      await burnFromUser(client, 'a@b.com', 75n, '11'.repeat(32));
      await client.query(`COMMIT`);
    } finally {
      client.release();
    }
    const balance = await ctx.pool.query<{ sum: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS sum FROM tokens WHERE owner_email='a@b.com' AND state='VALID'`,
    );
    expect(balance.rows[0].sum).toBe('15');
  });

  it('throws if balance insufficient', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES('a@b.com')`);
    await seedToken(ctx.pool, 'a@b.com', 50n);
    const client = await ctx.pool.connect();
    try {
      await client.query(`BEGIN`);
      await expect(
        burnFromUser(client, 'a@b.com', 100n, '11'.repeat(32)),
      ).rejects.toThrow(/INSUFFICIENT_BALANCE/);
      await client.query(`ROLLBACK`);
    } finally {
      client.release();
    }
  });
});
