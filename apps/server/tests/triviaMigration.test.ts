import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

async function tableExists(pool: any, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists`,
    [name],
  );
  return rows[0].exists;
}

async function indexExists(pool: any, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = $1) AS exists`,
    [name],
  );
  return rows[0].exists;
}

describe('migration 016_trivia', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('creates the four trivia tables', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    expect(await tableExists(ctx.pool, 'trivia_questions')).toBe(true);
    expect(await tableExists(ctx.pool, 'trivia_sessions')).toBe(true);
    expect(await tableExists(ctx.pool, 'trivia_matches')).toBe(true);
    expect(await tableExists(ctx.pool, 'trivia_chat_messages')).toBe(true);
  });

  it('enforces choices array length 4 on trivia_questions', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await expect(ctx.pool.query(
      `INSERT INTO trivia_questions (id, category, difficulty, question, correct_idx, choices)
       VALUES (gen_random_uuid(), 'x', 'easy', 'q', 0, ARRAY['a','b','c'])`,
    )).rejects.toThrow();
  });

  it('enforces correct_idx in [0, 3] on trivia_questions', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await expect(ctx.pool.query(
      `INSERT INTO trivia_questions (id, category, difficulty, question, correct_idx, choices)
       VALUES (gen_random_uuid(), 'x', 'easy', 'q', 4, ARRAY['a','b','c','d'])`,
    )).rejects.toThrow();
  });

  it('enforces bankroll % bet = 0 on trivia_sessions', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@b.com') ON CONFLICT DO NOTHING`);
    await expect(ctx.pool.query(
      `INSERT INTO trivia_sessions (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
       VALUES (gen_random_uuid(), 'a@b.com', 10, 25, 25, 'OPEN')`,
    )).rejects.toThrow();
  });

  it('enforces one OPEN trivia session per account via partial UNIQUE index', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@b.com') ON CONFLICT DO NOTHING`);
    await ctx.pool.query(
      `INSERT INTO trivia_sessions (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
       VALUES (gen_random_uuid(), 'a@b.com', 10, 100, 100, 'OPEN')`,
    );
    await expect(ctx.pool.query(
      `INSERT INTO trivia_sessions (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
       VALUES (gen_random_uuid(), 'a@b.com', 10, 100, 100, 'OPEN')`,
    )).rejects.toThrow();
  });

  it('enforces one ACTIVE match per session via partial UNIQUE index', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@b.com') ON CONFLICT DO NOTHING`);
    const { rows: sessRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO trivia_sessions (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
       VALUES (gen_random_uuid(), 'a@b.com', 10, 100, 100, 'OPEN')
       RETURNING id`,
    );
    const { rows: qRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO trivia_questions (id, category, difficulty, question, correct_idx, choices)
       VALUES (gen_random_uuid(), 'x', 'easy', 'q', 0, ARRAY['a','b','c','d'])
       RETURNING id`,
    );
    await ctx.pool.query(
      `INSERT INTO trivia_matches (id, offerer_session_id, offerer_email, challenger_email, bet_base_units, question_id, state, deadline_at)
       VALUES (gen_random_uuid(), $1, 'a@b.com', 'c@d.com', 10, $2, 'ACTIVE', now() + INTERVAL '10 seconds')`,
      [sessRows[0].id, qRows[0].id],
    );
    await expect(ctx.pool.query(
      `INSERT INTO trivia_matches (id, offerer_session_id, offerer_email, challenger_email, bet_base_units, question_id, state, deadline_at)
       VALUES (gen_random_uuid(), $1, 'a@b.com', 'e@f.com', 10, $2, 'ACTIVE', now() + INTERVAL '10 seconds')`,
      [sessRows[0].id, qRows[0].id],
    )).rejects.toThrow();
  });

  it('rejects state=RESOLVED without winner+signature+resolved_at', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@b.com') ON CONFLICT DO NOTHING`);
    const { rows: sessRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO trivia_sessions (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
       VALUES (gen_random_uuid(), 'a@b.com', 10, 100, 100, 'OPEN')
       RETURNING id`,
    );
    const { rows: qRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO trivia_questions (id, category, difficulty, question, correct_idx, choices)
       VALUES (gen_random_uuid(), 'x', 'easy', 'q', 0, ARRAY['a','b','c','d'])
       RETURNING id`,
    );
    await expect(ctx.pool.query(
      `INSERT INTO trivia_matches (id, offerer_session_id, offerer_email, challenger_email, bet_base_units, question_id, state, deadline_at)
       VALUES (gen_random_uuid(), $1, 'a@b.com', 'c@d.com', 10, $2, 'RESOLVED', now() + INTERVAL '10 seconds')`,
      [sessRows[0].id, qRows[0].id],
    )).rejects.toThrow();
  });

  it('enforces chat USER rows have account_email, SYSTEM rows do not', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@b.com') ON CONFLICT DO NOTHING`);
    await expect(ctx.pool.query(
      `INSERT INTO trivia_chat_messages (id, account_email, x_handle, kind, body)
       VALUES (gen_random_uuid(), 'a@b.com', null, 'SYSTEM', 'hi')`,
    )).rejects.toThrow();
    await expect(ctx.pool.query(
      `INSERT INTO trivia_chat_messages (id, account_email, x_handle, kind, body)
       VALUES (gen_random_uuid(), null, null, 'USER', 'hi')`,
    )).rejects.toThrow();
  });

  it('has the partial UNIQUE indexes', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    expect(await indexExists(ctx.pool, 'trivia_sessions_one_open_per_user')).toBe(true);
    expect(await indexExists(ctx.pool, 'trivia_matches_one_active_per_session')).toBe(true);
  });
});
