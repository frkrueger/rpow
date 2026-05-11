import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';

async function totalCirculating(pool: any): Promise<bigint> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COALESCE(SUM(value), 0)::text AS n FROM app_counters WHERE name = 'circulating_supply_base_units'`,
  );
  return BigInt(rows[0].n);
}

async function totalWrapped(pool: any): Promise<bigint> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COALESCE(SUM(value), 0)::text AS n FROM app_counters WHERE name = 'wrapped_supply_base_units'`,
  );
  return BigInt(rows[0].n);
}

async function insertToken(pool: any, owner: string, value: bigint, state: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO users(email) VALUES($1) ON CONFLICT DO NOTHING`, [owner]);
  await pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, server_sig) VALUES($1, $2, $3, $4, '\\x00')`,
    [id, owner, value.toString(), state],
  );
  return id;
}

describe('tokens_adjust_supply trigger', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('INSERT VALID increments circulating', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    expect(await totalCirculating(ctx.pool)).toBe(0n);
    await insertToken(ctx.pool, 'a@x.com', 100n, 'VALID');
    expect(await totalCirculating(ctx.pool)).toBe(100n);
    expect(await totalWrapped(ctx.pool)).toBe(0n);
  });

  it('INSERT WRAPPED increments wrapped, not circulating', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await insertToken(ctx.pool, 'a@x.com', 50n, 'WRAPPED');
    expect(await totalCirculating(ctx.pool)).toBe(0n);
    expect(await totalWrapped(ctx.pool)).toBe(50n);
  });

  it('INSERT INVALIDATED affects neither counter', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await insertToken(ctx.pool, 'a@x.com', 999n, 'INVALIDATED');
    expect(await totalCirculating(ctx.pool)).toBe(0n);
    expect(await totalWrapped(ctx.pool)).toBe(0n);
  });

  it('VALID → INVALIDATED decrements circulating', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const id = await insertToken(ctx.pool, 'a@x.com', 100n, 'VALID');
    expect(await totalCirculating(ctx.pool)).toBe(100n);
    await ctx.pool.query(`UPDATE tokens SET state='INVALIDATED' WHERE id=$1`, [id]);
    expect(await totalCirculating(ctx.pool)).toBe(0n);
  });

  it('VALID → LOCKED_FOR_BRIDGE → WRAPPED moves value from circulating to wrapped', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const id = await insertToken(ctx.pool, 'a@x.com', 200n, 'VALID');
    expect(await totalCirculating(ctx.pool)).toBe(200n);
    await ctx.pool.query(`UPDATE tokens SET state='LOCKED_FOR_BRIDGE' WHERE id=$1`, [id]);
    expect(await totalCirculating(ctx.pool)).toBe(0n);
    expect(await totalWrapped(ctx.pool)).toBe(0n);
    await ctx.pool.query(`UPDATE tokens SET state='WRAPPED' WHERE id=$1`, [id]);
    expect(await totalCirculating(ctx.pool)).toBe(0n);
    expect(await totalWrapped(ctx.pool)).toBe(200n);
  });

  it('LOCKED_FOR_BRIDGE → VALID (refund path) restores circulating', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const id = await insertToken(ctx.pool, 'a@x.com', 75n, 'VALID');
    await ctx.pool.query(`UPDATE tokens SET state='LOCKED_FOR_BRIDGE' WHERE id=$1`, [id]);
    expect(await totalCirculating(ctx.pool)).toBe(0n);
    await ctx.pool.query(`UPDATE tokens SET state='VALID' WHERE id=$1`, [id]);
    expect(await totalCirculating(ctx.pool)).toBe(75n);
  });

  it('WRAPPED → VALID (unwrap) moves value back to circulating', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const id = await insertToken(ctx.pool, 'a@x.com', 300n, 'WRAPPED');
    expect(await totalWrapped(ctx.pool)).toBe(300n);
    await ctx.pool.query(`UPDATE tokens SET state='VALID' WHERE id=$1`, [id]);
    expect(await totalWrapped(ctx.pool)).toBe(0n);
    expect(await totalCirculating(ctx.pool)).toBe(300n);
  });

  it('UPDATE without state change does not affect counters', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const id = await insertToken(ctx.pool, 'a@x.com', 100n, 'VALID');
    expect(await totalCirculating(ctx.pool)).toBe(100n);
    await ctx.pool.query(`UPDATE tokens SET invalidated_at = now() WHERE id=$1`, [id]);
    expect(await totalCirculating(ctx.pool)).toBe(100n);
  });

  it('100 concurrent INSERT VALIDs produce correct SUM', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES('concurrent@x.com')`);
    const writes = Array.from({ length: 100 }, () =>
      ctx.pool.query(
        `INSERT INTO tokens(id, owner_email, value, state, server_sig) VALUES($1, 'concurrent@x.com', 7, 'VALID', '\\x00')`,
        [randomUUID()],
      ),
    );
    await Promise.all(writes);
    expect(await totalCirculating(ctx.pool)).toBe(700n);
  });

  it('counter SUM matches the actual tokens table state at all times', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const a = await insertToken(ctx.pool, 'a@x.com', 100n, 'VALID');
    const b = await insertToken(ctx.pool, 'b@x.com', 200n, 'VALID');
    await insertToken(ctx.pool, 'c@x.com', 300n, 'WRAPPED');
    await ctx.pool.query(`UPDATE tokens SET state='INVALIDATED' WHERE id=$1`, [a]);
    await ctx.pool.query(`UPDATE tokens SET state='LOCKED_FOR_BRIDGE' WHERE id=$1`, [b]);

    const cCirc = await totalCirculating(ctx.pool);
    const cWrap = await totalWrapped(ctx.pool);
    const { rows: actualValid } = await ctx.pool.query<{ n: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS n FROM tokens WHERE state='VALID'`,
    );
    const { rows: actualWrap } = await ctx.pool.query<{ n: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS n FROM tokens WHERE state='WRAPPED'`,
    );
    expect(cCirc.toString()).toBe(actualValid[0].n);
    expect(cWrap.toString()).toBe(actualWrap[0].n);
  });
});
