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

async function markVerified(pool: any, email: string, handle: string, avatarUrl?: string) {
  await pool.query(
    `UPDATE users SET x_handle = $1, x_handle_verified_at = now(), x_avatar_url = $3 WHERE email = $2`,
    [handle, email, avatarUrl ?? null],
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

// ---------------------------------------------------------------------------
// GET /api/gladiator/lobby
// ---------------------------------------------------------------------------

describe('GET /api/gladiator/lobby', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('200 empty array when no open sessions', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/lobby' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gladiators).toEqual([]);
  });

  it('public — works without session cookie', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/lobby' });
    expect(res.statusCode).toBe(200);
  });

  it('returns OPEN sessions with all owner fields populated', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@b.com');
    await markVerified(ctx.pool, 'alice@b.com', 'alice', 'https://example.com/alice.png');
    const sessionId = await openSession(ctx.pool, 'alice@b.com', 10n, 100n);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/lobby' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gladiators).toHaveLength(1);

    const g = body.gladiators[0];
    expect(g.session_id).toBe(sessionId);
    expect(g.account_email).toBe('alice@b.com');
    expect(g.x_handle).toBe('alice');
    expect(g.x_avatar_url).toBe('https://example.com/alice.png');
    expect(g.bet_base_units).toBe('10');
    expect(g.bankroll_remaining_base_units).toBe('100');
    expect(g.flips_won).toBe(0);
    expect(g.flips_lost).toBe(0);
    expect(typeof g.opened_at).toBe('string');
    expect(g.last_flip_at).toBeNull();
  });

  it('excludes CLOSED sessions', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@b.com');
    await markVerified(ctx.pool, 'alice@b.com', 'alice');
    const sessionId = await openSession(ctx.pool, 'alice@b.com', 10n, 100n);

    // Close it
    await ctx.pool.query(
      `UPDATE gladiator_sessions SET status = 'CLOSED', closed_at = now() WHERE id = $1`,
      [sessionId],
    );

    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/lobby' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gladiators).toHaveLength(0);
  });

  it('returns multiple OPEN sessions ordered by opened_at DESC', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    // Create two users and sessions
    await login(ctx, 'alice@b.com');
    await markVerified(ctx.pool, 'alice@b.com', 'alice');
    await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');

    // Alice opened first (older)
    const aliceSessionId = await openSession(ctx.pool, 'alice@b.com', 10n, 100n);
    // Artificially age Alice's session
    await ctx.pool.query(
      `UPDATE gladiator_sessions SET opened_at = now() - INTERVAL '1 hour' WHERE id = $1`,
      [aliceSessionId],
    );

    // Bob opened second (newer)
    const bobSessionId = await openSession(ctx.pool, 'bob@b.com', 10n, 100n);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/gladiator/lobby' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gladiators).toHaveLength(2);

    // Bob should be first (more recent opened_at)
    expect(body.gladiators[0].session_id).toBe(bobSessionId);
    expect(body.gladiators[1].session_id).toBe(aliceSessionId);
  });
});
