import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.pool.query(
    `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
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

async function openSession(
  pool: any,
  ownerEmail: string,
  bet: bigint,
  bankroll: bigint,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO gladiator_sessions
       (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
     VALUES ($1, $2, $3, $4, $5, 'OPEN')`,
    [id, ownerEmail, bet.toString(), bankroll.toString(), bankroll.toString()],
  );
  return id;
}

async function insertFlip(
  pool: any,
  offererEmail: string,
  challengerEmail: string,
  bet: bigint,
  winnerEmail: string,
  sessionId: string,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO gladiator_flips
       (id, offerer_session_id, challenger_session_id, offerer_email, challenger_email,
        bet_base_units, winner_email, random_value_hex, signature)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, 'ab', '\\x00')`,
    [id, sessionId, offererEmail, challengerEmail, bet.toString(), winnerEmail],
  );
  return id;
}

// ---------------------------------------------------------------------------
// GET /api/gladiator/flips/recent
// ---------------------------------------------------------------------------

describe('GET /api/gladiator/flips/recent', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('200 empty array when no flips', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/flips/recent' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.flips).toEqual([]);
  });

  it('public — works without session cookie', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/flips/recent' });
    expect(res.statusCode).toBe(200);
  });

  it('returns flips newest first with all fields', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');

    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    const flip1 = await insertFlip(ctx.pool, 'alice@a.com', 'bob@b.com', 10n, 'bob@b.com', sessionId);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/flips/recent' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.flips).toHaveLength(1);

    const f = body.flips[0];
    expect(f.id).toBe(flip1);
    expect(f.offerer_email).toBe('alice@a.com');
    expect(f.challenger_email).toBe('bob@b.com');
    expect(f.offerer_x_handle).toBe('alice');
    expect(f.challenger_x_handle).toBe('bob');
    expect(f.bet_base_units).toBe('10');
    expect(f.winner_email).toBe('bob@b.com');
    expect(f.random_value_hex).toBe('ab');
    expect(typeof f.created_at).toBe('string');
  });

  it('returns at most 50 flips ordered by created_at DESC', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');

    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 1000n);

    // Insert 55 flips
    for (let i = 0; i < 55; i++) {
      await insertFlip(ctx.pool, 'alice@a.com', 'bob@b.com', 10n, 'bob@b.com', sessionId);
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/flips/recent' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.flips).toHaveLength(50);

    // Verify ordering: newest first
    for (let i = 0; i < body.flips.length - 1; i++) {
      expect(new Date(body.flips[i].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(body.flips[i + 1].created_at).getTime(),
      );
    }
  });

  it('x_handles are null when user has no verified handle', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    // Insert users but don't verify handles
    await login(ctx, 'alice@a.com');
    await login(ctx, 'bob@b.com');

    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    await insertFlip(ctx.pool, 'alice@a.com', 'bob@b.com', 10n, 'alice@a.com', sessionId);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/flips/recent' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.flips).toHaveLength(1);
    expect(body.flips[0].offerer_x_handle).toBeNull();
    expect(body.flips[0].challenger_x_handle).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/gladiator/flips/history
// ---------------------------------------------------------------------------

describe('GET /api/gladiator/flips/history', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/flips/history' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
  });

  it('200 empty when caller has no flips', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'alice@a.com');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/gladiator/flips/history',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.flips).toEqual([]);
  });

  it('200 returns only the caller\'s flips (offerer or challenger side)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookieBob = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    await login(ctx, 'carol@c.com');
    await markVerified(ctx.pool, 'carol@c.com', 'carol');

    const aliceSession = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    const carolSession = await openSession(ctx.pool, 'carol@c.com', 10n, 100n);

    // Bob as challenger in alice's session
    await insertFlip(ctx.pool, 'alice@a.com', 'bob@b.com', 10n, 'bob@b.com', aliceSession);
    // Bob as offerer (simulate)
    const bobSession = await openSession(ctx.pool, 'bob@b.com', 10n, 100n);
    await insertFlip(ctx.pool, 'bob@b.com', 'carol@c.com', 10n, 'carol@c.com', bobSession);
    // Carol vs Alice (Bob not involved)
    await insertFlip(ctx.pool, 'carol@c.com', 'alice@a.com', 10n, 'alice@a.com', carolSession);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/gladiator/flips/history',
      headers: { cookie: cookieBob },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Bob is in 2 flips (as challenger and as offerer), not the Carol vs Alice one
    expect(body.flips).toHaveLength(2);
    for (const flip of body.flips) {
      expect(
        flip.offerer_email === 'bob@b.com' || flip.challenger_email === 'bob@b.com',
      ).toBe(true);
    }
  });

  it('200 returns flips ordered newest first', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    const cookieAlice = await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');

    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    await insertFlip(ctx.pool, 'alice@a.com', 'bob@b.com', 10n, 'bob@b.com', sessionId);
    await insertFlip(ctx.pool, 'alice@a.com', 'bob@b.com', 10n, 'alice@a.com', sessionId);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/gladiator/flips/history',
      headers: { cookie: cookieAlice },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.flips).toHaveLength(2);
    expect(new Date(body.flips[0].created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(body.flips[1].created_at).getTime(),
    );
  });
});
