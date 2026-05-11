import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

async function seedResolvedMatch(pool: any, offererEmail: string, challengerEmail: string, winnerEmail: string) {
  await pool.query(
    `INSERT INTO users(email, x_handle, x_handle_verified_at)
     VALUES ($1, $2, now()), ($3, $4, now())
     ON CONFLICT (email) DO UPDATE SET x_handle = EXCLUDED.x_handle, x_handle_verified_at = EXCLUDED.x_handle_verified_at`,
    [offererEmail, offererEmail.split('@')[0], challengerEmail, challengerEmail.split('@')[0]],
  );
  const { rows: s } = await pool.query<{ id: string }>(
    `INSERT INTO trivia_sessions (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
     VALUES (gen_random_uuid(), $1, 10, 100, 100, 'OPEN')
     RETURNING id`,
    [offererEmail],
  );
  const { rows: q } = await pool.query<{ id: string }>(
    `INSERT INTO trivia_questions (id, category, difficulty, question, correct_idx, choices)
     VALUES (gen_random_uuid(), 'x', 'easy', 'q', 0, ARRAY['a','b','c','d'])
     RETURNING id`,
  );
  const { rows: m } = await pool.query<{ id: string }>(
    `INSERT INTO trivia_matches (id, offerer_session_id, offerer_email, challenger_email, bet_base_units, question_id, state, deadline_at, winner_email, signature, resolved_at, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 10, $4, 'RESOLVED', now() + INTERVAL '10 seconds', $5, '\\x00', now(), now())
     RETURNING id`,
    [s[0].id, offererEmail, challengerEmail, q[0].id, winnerEmail],
  );
  return m[0].id;
}

describe('GET /api/trivia/matches/recent', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('200 empty when no resolved matches', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/matches/recent' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ matches: [] });
  });

  it('returns RESOLVED matches with x_handles', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedResolvedMatch(ctx.pool, 'a@b.com', 'c@d.com', 'a@b.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/matches/recent' });
    expect(res.json().matches).toHaveLength(1);
    const m = res.json().matches[0];
    expect(m.offerer_x_handle).toBe('a');
    expect(m.challenger_x_handle).toBe('c');
    expect(m.winner_email).toBe('a@b.com');
  });

  it('public — works without session cookie', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/matches/recent' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/trivia/matches/history', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/matches/history' });
    expect(res.statusCode).toBe(401);
  });

  it('returns matches where caller is offerer or challenger', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await seedResolvedMatch(ctx.pool, 'a@b.com', 'c@d.com', 'a@b.com');
    await seedResolvedMatch(ctx.pool, 'e@f.com', 'a@b.com', 'e@f.com');
    await seedResolvedMatch(ctx.pool, 'x@y.com', 'z@y.com', 'x@y.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/matches/history', headers: { cookie } });
    expect(res.json().matches).toHaveLength(2);
  });

  it('returns empty when caller has no matches', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/matches/history', headers: { cookie } });
    expect(res.json()).toEqual({ matches: [] });
  });
});
