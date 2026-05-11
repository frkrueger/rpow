import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

async function markVerified(pool: any, email: string, handle: string) {
  await pool.query(
    `UPDATE users SET x_handle = $1, x_handle_verified_at = now(), x_avatar_url = $2 WHERE email = $3`,
    [handle, `https://unavatar.io/twitter/${handle}`, email],
  );
}

async function openSession(pool: any, ownerEmail: string, bet: bigint, bankroll: bigint): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trivia_sessions (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
     VALUES ($1, $2, $3, $4, $5, 'OPEN')`,
    [id, ownerEmail, bet.toString(), bankroll.toString(), bankroll.toString()],
  );
  return id;
}

async function seedResolvedMatch(pool: any, offererSessionId: string, offererEmail: string, challengerEmail: string, winnerEmail: string) {
  const { rows: q } = await pool.query<{ id: string }>(
    `INSERT INTO trivia_questions (id, category, difficulty, question, correct_idx, choices)
     VALUES (gen_random_uuid(), 'x', 'easy', 'q', 0, ARRAY['a','b','c','d']) RETURNING id`,
  );
  await pool.query(
    `INSERT INTO trivia_matches (id, offerer_session_id, offerer_email, challenger_email, bet_base_units, question_id, state, deadline_at, winner_email, signature, resolved_at, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 10, $4, 'RESOLVED', now() + INTERVAL '10 seconds', $5, '\\x00', now(), now())`,
    [offererSessionId, offererEmail, challengerEmail, q[0].id, winnerEmail],
  );
}

describe('GET /api/trivia/me', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns profile with x_handle=null when not verified', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      email: 'a@b.com',
      x_handle: null,
      x_handle_verified_at: null,
      x_avatar_url: null,
      open_session: null,
      career: { wins: 0, losses: 0 },
    });
  });

  it('returns x_handle / verified_at / avatar when verified', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/me', headers: { cookie } });
    const body = res.json();
    expect(body.x_handle).toBe('alice');
    expect(body.x_handle_verified_at).toBeTruthy();
    expect(body.x_avatar_url).toBe('https://unavatar.io/twitter/alice');
  });

  it('returns open_session when user has one open', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    const sid = await openSession(ctx.pool, 'a@b.com', 10n, 100n);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/me', headers: { cookie } });
    const body = res.json();
    expect(body.open_session).toBeTruthy();
    expect(body.open_session.id).toBe(sid);
    expect(body.open_session.status).toBe('OPEN');
    expect(body.open_session.bet_base_units).toBe('10');
    expect(body.open_session.bankroll_remaining_base_units).toBe('100');
  });

  it('omits open_session after it has CLOSED', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    const sid = await openSession(ctx.pool, 'a@b.com', 10n, 100n);
    await ctx.pool.query(`UPDATE trivia_sessions SET status='CLOSED', closed_at=now() WHERE id=$1`, [sid]);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/me', headers: { cookie } });
    expect(res.json().open_session).toBeNull();
  });

  it('career counts wins as offerer and challenger', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    const sid = await openSession(ctx.pool, 'a@b.com', 10n, 100n);
    // alice wins one as offerer
    await seedResolvedMatch(ctx.pool, sid, 'a@b.com', 'b@c.com', 'a@b.com');
    // alice wins one as challenger — need a different offerer's session
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('c@d.com') ON CONFLICT DO NOTHING`);
    const otherSid = await openSession(ctx.pool, 'c@d.com', 10n, 100n);
    await seedResolvedMatch(ctx.pool, otherSid, 'c@d.com', 'a@b.com', 'a@b.com');
    // alice loses one
    const losingSid = await openSession(ctx.pool, 'a@b.com', 0n + 10n, 0n + 100n).catch(async () => {
      // alice already has one open. CLOSED out the existing one first
      await ctx.pool.query(`UPDATE trivia_sessions SET status='CLOSED', closed_at=now() WHERE id=$1`, [sid]);
      return openSession(ctx.pool, 'a@b.com', 10n, 100n);
    });
    await seedResolvedMatch(ctx.pool, losingSid, 'a@b.com', 'b@c.com', 'b@c.com');

    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/me', headers: { cookie } });
    expect(res.json().career).toEqual({ wins: 2, losses: 1 });
  });
});
