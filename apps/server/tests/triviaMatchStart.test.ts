import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.pool.query(
    `INSERT INTO users(email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
    [email],
  );
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
async function seedOfferer(ctx: any, email: string, handle: string, bet: bigint, bankroll: bigint): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  await markVerified(ctx.pool, email, handle);
  const id = randomUUID();
  await ctx.pool.query(
    `INSERT INTO trivia_sessions(id, account_email, bet_base_units,
       bankroll_initial_base_units, bankroll_remaining_base_units, status, opened_at)
     VALUES($1, $2, $3, $4, $5, 'OPEN', now())`,
    [id, email, bet.toString(), bankroll.toString(), bankroll.toString()],
  );
  await ctx.pool.query(
    `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
    [bankroll.toString()],
  );
  return id;
}

describe('POST /api/trivia/matches/start', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { 'content-type': 'application/json' },
      payload: { session_id: randomUUID() },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 X_HANDLE_REQUIRED when challenger unverified', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'cha@x.com');
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('X_HANDLE_REQUIRED');
  });

  it('400 SELF_CHALLENGE if challenger owns the session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedQuestion(ctx.pool);
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    const cookie = await login(ctx, 'off@x.com');
    await seedToken(ctx.pool, 'off@x.com', 1000n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('SELF_CHALLENGE');
  });

  it('409 INSUFFICIENT_BALANCE when challenger has no tokens', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedQuestion(ctx.pool);
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    const cookie = await login(ctx, 'cha@x.com');
    await markVerified(ctx.pool, 'cha@x.com', 'cha');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('404 SESSION_NOT_FOUND when session id does not exist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedQuestion(ctx.pool);
    const cookie = await login(ctx, 'cha@x.com');
    await markVerified(ctx.pool, 'cha@x.com', 'cha');
    await seedToken(ctx.pool, 'cha@x.com', 1000n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: randomUUID() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('SESSION_NOT_FOUND');
  });

  it('503 NO_QUESTIONS_AVAILABLE when question pool is empty', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    const cookie = await login(ctx, 'cha@x.com');
    await markVerified(ctx.pool, 'cha@x.com', 'cha');
    await seedToken(ctx.pool, 'cha@x.com', 1000n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('NO_QUESTIONS_AVAILABLE');
  });

  it('happy path: creates ACTIVE match, burns bet, returns question + deadline', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedQuestion(ctx.pool);
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    const cookie = await login(ctx, 'cha@x.com');
    await markVerified(ctx.pool, 'cha@x.com', 'cha');
    await seedToken(ctx.pool, 'cha@x.com', 1000n);

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.match_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.question).toBe('capital of France?');
    expect(body.choices).toEqual(['London','Paris','Berlin','Tokyo']);
    expect(body.bet_base_units).toBe('10');
    expect(new Date(body.deadline_at).getTime()).toBeGreaterThan(Date.now());

    const tok = await ctx.pool.query(
      `SELECT COALESCE(SUM(value), 0)::text AS total FROM tokens
       WHERE owner_email = 'cha@x.com' AND state = 'VALID'`,
    );
    expect(tok.rows[0].total).toBe('990');

    const mr = await ctx.pool.query(
      `SELECT state, offerer_session_id, offerer_email, challenger_email
       FROM trivia_matches WHERE id = $1`,
      [body.match_id],
    );
    expect(mr.rows[0]).toMatchObject({
      state: 'ACTIVE',
      offerer_session_id: sid,
      offerer_email: 'off@x.com',
      challenger_email: 'cha@x.com',
    });
  });

  it('409 OFFER_UNAVAILABLE when the session already has an active match', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedQuestion(ctx.pool);
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    const cookie = await login(ctx, 'cha@x.com');
    await markVerified(ctx.pool, 'cha@x.com', 'cha');
    await seedToken(ctx.pool, 'cha@x.com', 1000n);
    const r1 = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(r1.statusCode).toBe(200);
    const cookie2 = await login(ctx, 'cha2@x.com');
    await markVerified(ctx.pool, 'cha2@x.com', 'cha2');
    await seedToken(ctx.pool, 'cha2@x.com', 1000n);
    const r2 = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie: cookie2, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe('OFFER_UNAVAILABLE');
  });

  it('409 OFFER_UNAVAILABLE for CLOSED session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedQuestion(ctx.pool);
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    await ctx.pool.query(`UPDATE trivia_sessions SET status = 'CLOSED', closed_at = now() WHERE id = $1`, [sid]);
    const cookie = await login(ctx, 'cha@x.com');
    await markVerified(ctx.pool, 'cha@x.com', 'cha');
    await seedToken(ctx.pool, 'cha@x.com', 1000n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('OFFER_UNAVAILABLE');
  });
});
