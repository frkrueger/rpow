import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
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
async function seedToken(pool: any, email: string, value: bigint) {
  await pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, server_sig)
     VALUES($1, $2, $3, 'VALID', '\\x00')`,
    [randomUUID(), email, value.toString()],
  );
}
async function seedQuestion(pool: any, correctIdx = 1): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trivia_questions(id, category, difficulty, question, correct_idx, choices)
     VALUES($1, 'General', 'easy', 'capital of France?', $2, ARRAY['London','Paris','Berlin','Tokyo'])`,
    [id, correctIdx],
  );
  return id;
}

/** Start a match via the real endpoint so the seeded state is realistic. */
async function startMatch(ctx: any): Promise<{ matchId: string; sessionId: string; offererCookie: string; challengerCookie: string }> {
  await seedQuestion(ctx.pool);
  await ctx.pool.query(`INSERT INTO users(email) VALUES ('off@x.com') ON CONFLICT DO NOTHING`);
  await markVerified(ctx.pool, 'off@x.com', 'off');
  const sessionId = randomUUID();
  await ctx.pool.query(
    `INSERT INTO trivia_sessions(id, account_email, bet_base_units,
       bankroll_initial_base_units, bankroll_remaining_base_units, status, opened_at)
     VALUES($1, 'off@x.com', 10, 30, 30, 'OPEN', now())`,
    [sessionId],
  );
  await ctx.pool.query(`UPDATE app_counters SET value = value - 30 WHERE name = 'minted_supply'`);
  const challengerCookie = await login(ctx, 'cha@x.com');
  await markVerified(ctx.pool, 'cha@x.com', 'cha');
  await seedToken(ctx.pool, 'cha@x.com', 1000n);
  const offererCookie = await login(ctx, 'off@x.com');
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/trivia/matches/start',
    headers: { cookie: challengerCookie, 'content-type': 'application/json' },
    payload: { session_id: sessionId },
  });
  expect(res.statusCode).toBe(200);
  return { matchId: res.json().match_id, sessionId, offererCookie, challengerCookie };
}

describe('POST /api/trivia/matches/:id/answer', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId } = await startMatch(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('400 BAD_REQUEST for out-of-range choice_idx', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie } = await startMatch(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 99 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('404 MATCH_NOT_FOUND for unknown id', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { offererCookie } = await startMatch(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${randomUUID()}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('MATCH_NOT_FOUND');
  });

  it('403 NOT_A_PLAYER for a third-party email', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId } = await startMatch(ctx);
    const cookie = await login(ctx, 'other@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_A_PLAYER');
  });

  it('happy path single-side: records answer, both_answered=false', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie } = await startMatch(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().both_answered).toBe(false);
    expect(typeof res.json().answered_at).toBe('string');
    const m = await ctx.pool.query(
      `SELECT state, offerer_choice_idx FROM trivia_matches WHERE id = $1`,
      [matchId],
    );
    expect(m.rows[0]).toMatchObject({ state: 'ACTIVE', offerer_choice_idx: 1 });
  });

  it('409 ALREADY_ANSWERED on second submission from same side', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie } = await startMatch(ctx);
    const r1 = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 2 },
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe('ALREADY_ANSWERED');
  });

  it('both sides answer → match resolves and both_answered=true on the second answer', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie, challengerCookie } = await startMatch(ctx);
    const r1 = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().both_answered).toBe(false);

    const r2 = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: challengerCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 3 },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().both_answered).toBe(true);

    const m = await ctx.pool.query(
      `SELECT state, winner_email, resolved_at, signature
       FROM trivia_matches WHERE id = $1`,
      [matchId],
    );
    expect(m.rows[0].state).toBe('RESOLVED');
    expect(m.rows[0].winner_email).toBe('off@x.com');
    expect(m.rows[0].resolved_at).not.toBeNull();
    expect(m.rows[0].signature).not.toBeNull();
  });

  it('410 MATCH_EXPIRED if deadline passed before answer arrives', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie } = await startMatch(ctx);
    await ctx.pool.query(
      `UPDATE trivia_matches SET deadline_at = created_at + interval '1 millisecond' WHERE id = $1`,
      [matchId],
    );
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('MATCH_EXPIRED');
  });
});
