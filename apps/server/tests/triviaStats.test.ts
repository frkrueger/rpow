import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('GET /api/trivia/stats', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns zeros on empty DB', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/stats' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      total_matches: 0,
      total_volume_base_units: '0',
      total_verified_users: 0,
      open_arena_count: 0,
    });
  });

  it('counts verified users (with x_handle)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users (email, x_handle, x_handle_verified_at) VALUES ('a@b.com', 'alice', now()), ('c@d.com', 'charlie', now())`);
    await ctx.pool.query(`INSERT INTO users (email) VALUES ('e@f.com')`);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/stats' });
    expect(res.json().total_verified_users).toBe(2);
  });

  it('counts open arena sessions', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@b.com'),('c@d.com') ON CONFLICT DO NOTHING`);
    await ctx.pool.query(
      `INSERT INTO trivia_sessions (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
       VALUES (gen_random_uuid(), 'a@b.com', 10, 100, 100, 'OPEN'),
              (gen_random_uuid(), 'c@d.com', 10, 100, 100, 'OPEN')`,
    );
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/stats' });
    expect(res.json().open_arena_count).toBe(2);
  });

  it('aggregates resolved matches', async () => {
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
      `INSERT INTO trivia_matches (id, offerer_session_id, offerer_email, challenger_email, bet_base_units, question_id, state, deadline_at, winner_email, signature, resolved_at, created_at)
       VALUES (gen_random_uuid(), $1, 'a@b.com', 'c@d.com', 10, $2, 'RESOLVED', now() + INTERVAL '10 seconds', 'a@b.com', '\\x00', now(), now()),
              (gen_random_uuid(), $1, 'a@b.com', 'e@f.com', 10, $2, 'RESOLVED', now() + INTERVAL '10 seconds', 'e@f.com', '\\x00', now(), now())`,
      [sessRows[0].id, qRows[0].id],
    );
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/stats' });
    expect(res.json().total_matches).toBe(2);
    expect(res.json().total_volume_base_units).toBe('40');
  });

  it('public — works without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/stats' });
    expect(res.statusCode).toBe(200);
  });
});
