import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

async function tableExists(pool: any, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists`,
    [name],
  );
  return rows[0].exists;
}

async function columnType(pool: any, table: string, column: string): Promise<string | null> {
  const { rows } = await pool.query<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows[0]?.data_type ?? null;
}

async function indexExists(pool: any, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = $1) AS exists`,
    [name],
  );
  return rows[0].exists;
}

describe('migration 029_freelottery', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('creates freelottery_codes with the expected PK', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    expect(await tableExists(ctx.pool, 'freelottery_codes')).toBe(true);
    expect(await columnType(ctx.pool, 'freelottery_codes', 'account_email')).toBe('text');
    expect(await columnType(ctx.pool, 'freelottery_codes', 'day_utc')).toBe('date');
    expect(await columnType(ctx.pool, 'freelottery_codes', 'code')).toBe('text');
    expect(await columnType(ctx.pool, 'freelottery_codes', 'expires_at')).toBe('timestamp with time zone');
  });

  it('creates freelottery_entries with ticket_count CHECK in (1,2)', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    expect(await tableExists(ctx.pool, 'freelottery_entries')).toBe(true);
    expect(await columnType(ctx.pool, 'freelottery_entries', 'ticket_count')).toBe('smallint');
    // Inserting a row with ticket_count = 3 must fail the CHECK.
    await ctx.pool.query(`INSERT INTO users (email) VALUES ('a@test') ON CONFLICT DO NOTHING`);
    await expect(
      ctx.pool.query(
        `INSERT INTO freelottery_entries
           (account_email, day_utc, x_handle, tweet_url, ticket_count, balance_base_units_at_entry)
         VALUES ('a@test','2026-05-13','x','u',3,0)`,
      ),
    ).rejects.toThrow(/ticket_count/);
  });

  it('creates freelottery_entries_day_idx index', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    expect(await indexExists(ctx.pool, 'freelottery_entries_day_idx')).toBe(true);
  });

  it('creates freelottery_draws with status default = ok and prize_base_units NOT NULL', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    expect(await tableExists(ctx.pool, 'freelottery_draws')).toBe(true);
    expect(await columnType(ctx.pool, 'freelottery_draws', 'prize_base_units')).toBe('bigint');
    expect(await columnType(ctx.pool, 'freelottery_draws', 'status')).toBe('text');
    await ctx.pool.query(
      `INSERT INTO freelottery_draws (day_utc, drawn_at, total_tickets, prize_base_units)
       VALUES ('2026-05-13', now(), 0, 1000000000000)`,
    );
    const { rows } = await ctx.pool.query(`SELECT status FROM freelottery_draws WHERE day_utc='2026-05-13'`);
    expect(rows[0].status).toBe('ok');
  });
});
