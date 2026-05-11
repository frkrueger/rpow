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
  await pool.query(`UPDATE users SET x_handle = $1, x_handle_verified_at = now() WHERE email = $2`, [handle, email]);
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

async function setupMatch(ctx: any) {
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
  const r = await ctx.app.inject({
    method: 'POST', url: '/api/trivia/matches/start',
    headers: { cookie: challengerCookie, 'content-type': 'application/json' },
    payload: { session_id: sessionId },
  });
  expect(r.statusCode).toBe(200);
  return { matchId: r.json().match_id, sessionId, offererCookie, challengerCookie };
}

describe('GET /api/trivia/matches/active', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/trivia/matches/active?session_id=${randomUUID()}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 when caller does not own the session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { sessionId } = await setupMatch(ctx);
    const cookie = await login(ctx, 'someone-else@x.com');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/trivia/matches/active?session_id=${sessionId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns { match: null } when no active match', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('off@x.com') ON CONFLICT DO NOTHING`);
    await markVerified(ctx.pool, 'off@x.com', 'off');
    const sessionId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO trivia_sessions(id, account_email, bet_base_units,
         bankroll_initial_base_units, bankroll_remaining_base_units, status, opened_at)
       VALUES($1, 'off@x.com', 10, 30, 30, 'OPEN', now())`,
      [sessionId],
    );
    const cookie = await login(ctx, 'off@x.com');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/trivia/matches/active?session_id=${sessionId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().match).toBeNull();
  });

  it('returns the active match for the offerer with question + choices', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, sessionId, offererCookie } = await setupMatch(ctx);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/trivia/matches/active?session_id=${sessionId}`,
      headers: { cookie: offererCookie },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json().match;
    expect(m.id).toBe(matchId);
    expect(m.state).toBe('ACTIVE');
    expect(m.question).toBe('capital of France?');
    expect(m.choices).toEqual(['London','Paris','Berlin','Tokyo']);
    expect(m.offerer_answered).toBe(false);
    expect(m.challenger_answered).toBe(false);
  });

  it('lazy-resolves a stale ACTIVE match when polled after deadline', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, sessionId, offererCookie } = await setupMatch(ctx);
    // Set deadline in the past, keeping deadline_at > created_at (CHECK constraint).
    await ctx.pool.query(
      `UPDATE trivia_matches SET deadline_at = created_at + interval '1 millisecond' WHERE id = $1`,
      [matchId],
    );
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/trivia/matches/active?session_id=${sessionId}`,
      headers: { cookie: offererCookie },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json().match;
    expect(m.id).toBe(matchId);
    expect(m.state).toBe('RESOLVED');
    expect(m.winner_email).toBe('off@x.com'); // both timed out, offerer wins
    expect(m.signature_hex).toMatch(/^[0-9a-f]+$/);
  });
});

describe('GET /api/trivia/matches/:id', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId } = await setupMatch(ctx);
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/trivia/matches/${matchId}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 for non-player', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId } = await setupMatch(ctx);
    const cookie = await login(ctx, 'rando@x.com');
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/trivia/matches/${matchId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns ACTIVE state for the challenger', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, challengerCookie } = await setupMatch(ctx);
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/trivia/matches/${matchId}`,
      headers: { cookie: challengerCookie },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json().match;
    expect(m.state).toBe('ACTIVE');
    expect(m.question).toBe('capital of France?');
    expect(m.offerer_choice_idx).toBeNull();
    expect(m.challenger_choice_idx).toBeNull();
    // Correct answer must be HIDDEN while ACTIVE.
    expect(m.correct_choice_idx).toBeNull();
  });

  it('does NOT leak opponent choice_idx while match is ACTIVE (game-integrity)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie, challengerCookie } = await setupMatch(ctx);
    // Offerer answers first.
    await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    // Challenger polls before submitting — must not see offerer's pick.
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/trivia/matches/${matchId}`,
      headers: { cookie: challengerCookie },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json().match;
    expect(m.state).toBe('ACTIVE');
    expect(m.offerer_choice_idx).toBeNull();      // hidden
    expect(m.offerer_answered).toBe(true);         // but UI knows opponent has answered
    expect(m.offerer_answered_at).toBeNull();      // timestamp also hidden
    expect(m.correct_choice_idx).toBeNull();
  });

  it('reveals both choice_idx values once RESOLVED', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie, challengerCookie } = await setupMatch(ctx);
    await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: challengerCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 3 },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/trivia/matches/${matchId}`,
      headers: { cookie: challengerCookie },
    });
    const m = res.json().match;
    expect(m.state).toBe('RESOLVED');
    expect(m.offerer_choice_idx).toBe(1);
    expect(m.challenger_choice_idx).toBe(3);
    expect(typeof m.offerer_answered_at).toBe('string');
    expect(typeof m.challenger_answered_at).toBe('string');
  });

  it('returns RESOLVED state with winner + signature + correct_choice_idx after both answer', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie, challengerCookie } = await setupMatch(ctx);
    await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: challengerCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/trivia/matches/${matchId}`,
      headers: { cookie: offererCookie },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json().match;
    expect(m.state).toBe('RESOLVED');
    expect(m.offerer_choice_idx).toBe(1);
    expect(m.challenger_choice_idx).toBe(1);
    expect(m.correct_choice_idx).toBe(1);
    expect(m.signature_hex).toMatch(/^[0-9a-f]+$/);
  });

  it('lazy-resolves on deadline-passed read', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, challengerCookie } = await setupMatch(ctx);
    await ctx.pool.query(
      `UPDATE trivia_matches SET deadline_at = created_at + interval '1 millisecond' WHERE id = $1`,
      [matchId],
    );
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/trivia/matches/${matchId}`,
      headers: { cookie: challengerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().match.state).toBe('RESOLVED');
  });
});
