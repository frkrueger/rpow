import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function openSession(pool: any, ownerEmail: string, bet: bigint, bankroll: bigint, handle: string): Promise<string> {
  await pool.query(
    `INSERT INTO users(email, x_handle, x_handle_verified_at)
     VALUES ($1, $2, now())
     ON CONFLICT (email) DO UPDATE
       SET x_handle = $2, x_handle_verified_at = now()`,
    [ownerEmail, handle],
  );
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trivia_sessions (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
     VALUES ($1, $2, $3, $4, $5, 'OPEN')`,
    [id, ownerEmail, bet.toString(), bankroll.toString(), bankroll.toString()],
  );
  return id;
}

describe('GET /api/trivia/lobby', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns empty when nobody in arena', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/lobby' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ players: [] });
  });

  it('returns OPEN sessions with owner profile fields', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await openSession(ctx.pool, 'a@b.com', 10n, 100n, 'alice');
    await openSession(ctx.pool, 'c@d.com', 20n, 200n, 'charlie');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/lobby' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.players).toHaveLength(2);
    const handles = body.players.map((p: any) => p.x_handle).sort();
    expect(handles).toEqual(['alice', 'charlie']);
  });

  it('includes the full row shape per player', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await openSession(ctx.pool, 'a@b.com', 10n, 100n, 'alice');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/lobby' });
    const p = res.json().players[0];
    expect(p).toMatchObject({
      account_email: 'a@b.com',
      x_handle: 'alice',
      bet_base_units: '10',
      bankroll_remaining_base_units: '100',
      matches_won: 0,
      matches_lost: 0,
    });
    expect(p.session_id).toBeTruthy();
    expect(p.opened_at).toBeTruthy();
    expect(p.last_match_at).toBeNull();
  });

  it('excludes CLOSED sessions', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const id = await openSession(ctx.pool, 'a@b.com', 10n, 100n, 'alice');
    await ctx.pool.query(`UPDATE trivia_sessions SET status = 'CLOSED', closed_at = now() WHERE id = $1`, [id]);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/lobby' });
    expect(res.json().players).toHaveLength(0);
  });

  it('ordered by opened_at DESC', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await openSession(ctx.pool, 'a@b.com', 10n, 100n, 'alice');
    await new Promise(r => setTimeout(r, 20));
    await openSession(ctx.pool, 'c@d.com', 10n, 100n, 'charlie');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/lobby' });
    const handles = res.json().players.map((g: any) => g.x_handle);
    expect(handles[0]).toBe('charlie');
    expect(handles[1]).toBe('alice');
  });

  it('public — works without session cookie', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await openSession(ctx.pool, 'a@b.com', 10n, 100n, 'alice');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/lobby' });
    expect(res.statusCode).toBe(200);
  });
});

async function loginForTriviaFavTest(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

async function seedTriviaPlayer(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string, handle: string) {
  await openSession(ctx.pool, email, 10n, 30n, handle);
}

describe('GET /api/trivia/lobby — is_favorite', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('is_favorite is false for spectators on every row', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedTriviaPlayer(ctx, 'a@x.com', 'alice');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/lobby' });
    expect(res.statusCode).toBe(200);
    const p = res.json().players[0];
    expect(p.is_favorite).toBe(false);
  });

  it('is_favorite reflects the caller user_favorites', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedTriviaPlayer(ctx, 'a@x.com', 'alice');
    await seedTriviaPlayer(ctx, 'b@x.com', 'bob');
    const cookie = await loginForTriviaFavTest(ctx, 'me@x.com');
    await ctx.pool.query(`INSERT INTO user_favorites(account_email, favorite_email) VALUES ('me@x.com','a@x.com')`);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/lobby', headers: { cookie } });
    const byHandle: Record<string, any> = {};
    for (const p of res.json().players) byHandle[p.x_handle] = p;
    expect(byHandle.alice.is_favorite).toBe(true);
    expect(byHandle.bob.is_favorite).toBe(false);
  });
});
