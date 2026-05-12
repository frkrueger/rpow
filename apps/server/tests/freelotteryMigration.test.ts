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
    // Use status='empty' so winner_email stays NULL (satisfies the new CHECK constraint).
    await ctx.pool.query(
      `INSERT INTO freelottery_draws (day_utc, drawn_at, total_tickets, prize_base_units, status)
       VALUES ('2026-05-13', now(), 0, 1000000000000, 'empty')`,
    );
    const { rows } = await ctx.pool.query(`SELECT status FROM freelottery_draws WHERE day_utc='2026-05-13'`);
    expect(rows[0].status).toBe('empty');
  });

  it('enforces winner_email nullability against status', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users (email) VALUES ('w@test') ON CONFLICT DO NOTHING`);

    // status='ok' with no winner_email must fail.
    await expect(
      ctx.pool.query(
        `INSERT INTO freelottery_draws (day_utc, drawn_at, total_tickets, prize_base_units, status)
         VALUES ('2026-05-13', now(), 5, 1000000000000, 'ok')`,
      ),
    ).rejects.toThrow(/check|winner_email/i);

    // status='empty' WITH a winner_email must also fail.
    await expect(
      ctx.pool.query(
        `INSERT INTO freelottery_draws (day_utc, drawn_at, total_tickets, prize_base_units, status, winner_email)
         VALUES ('2026-05-14', now(), 0, 1000000000000, 'empty', 'w@test')`,
      ),
    ).rejects.toThrow(/check|winner_email/i);

    // status='ok' WITH winner_email must succeed.
    await ctx.pool.query(
      `INSERT INTO freelottery_draws (day_utc, drawn_at, total_tickets, prize_base_units, status, winner_email)
       VALUES ('2026-05-15', now(), 5, 1000000000000, 'ok', 'w@test')`,
    );

    // status='empty' with NULL winner_email must succeed.
    await ctx.pool.query(
      `INSERT INTO freelottery_draws (day_utc, drawn_at, total_tickets, prize_base_units, status)
       VALUES ('2026-05-16', now(), 0, 1000000000000, 'empty')`,
    );
  });
});
