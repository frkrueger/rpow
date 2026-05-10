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

async function seedToken(pool: any, email: string, value: bigint) {
  await pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, server_sig)
     VALUES($1, $2, $3, 'VALID', '\\x00')`,
    [randomUUID(), email, value.toString()],
  );
}

async function markVerified(pool: any, email: string, handle: string) {
  await pool.query(
    `UPDATE users SET x_handle = $1, x_handle_verified_at = now() WHERE email = $2`,
    [handle, email],
  );
}

/** Valid enter-arena body using test defaults (min bet = 10, max bet = 1_000_000_000) */
const DEFAULT_BET = '10';
const DEFAULT_BANKROLL = '100'; // 10 × bet = valid multiple

// ---------------------------------------------------------------------------
// POST /api/gladiator/sessions — Enter arena
// ---------------------------------------------------------------------------

describe('POST /api/gladiator/sessions', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
  });

  it('403 X_HANDLE_REQUIRED for unverified user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('X_HANDLE_REQUIRED');
  });

  it('400 BAD_REQUEST for non-numeric strings in body', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: 'abc', bet_base_units: DEFAULT_BET },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('400 STAKE_OUT_OF_RANGE for bet below min', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    // Test min = 10, so 5 is below
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: '50', bet_base_units: '5' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('STAKE_OUT_OF_RANGE');
  });

  it('400 STAKE_OUT_OF_RANGE for bet above max', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    // Test max = 1_000_000_000
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: '2000000000', bet_base_units: '2000000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('STAKE_OUT_OF_RANGE');
  });

  it('400 BANKROLL_OUT_OF_RANGE for bankroll below bet', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    // bankroll (10) < bet (100) — below lower bound
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: '10', bet_base_units: '100' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BANKROLL_OUT_OF_RANGE');
  });

  it('400 BANKROLL_OUT_OF_RANGE for bankroll above max', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    // Test max bankroll = 10_000_000_000
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: '20000000000', bet_base_units: '10' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BANKROLL_OUT_OF_RANGE');
  });

  it('400 BANKROLL_NOT_MULTIPLE when bankroll % bet != 0', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    // 105 % 10 = 5 — not a clean multiple
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: '105', bet_base_units: '10' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BANKROLL_NOT_MULTIPLE');
  });

  it('403 NOT_ALLOWED when user is not on gladiator allowlist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    (ctx.app as any).config.gladiatorAllowedEmails = 'someone-else@example.com';
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    await seedToken(ctx.pool, 'a@b.com', 1000n);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: '100', bet_base_units: '10' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_ALLOWED');
  });

  it('409 INSUFFICIENT_BALANCE when user lacks tokens', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    // No tokens seeded
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('200 success: session row created, tokens burned, chat row inserted', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    await seedToken(ctx.pool, 'a@b.com', 1000n);
    // Pre-seed minted_supply so burnFromUser can track properly
    await ctx.pool.query(`UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('OPEN');
    expect(body.bet_base_units).toBe(DEFAULT_BET);
    expect(body.bankroll_initial_base_units).toBe(DEFAULT_BANKROLL);
    expect(body.bankroll_remaining_base_units).toBe(DEFAULT_BANKROLL);
    expect(body.session_id).toBeTruthy();
    expect(body.opened_at).toBeTruthy();

    // Verify DB row
    const { rows } = await ctx.pool.query<{ status: string; bankroll_remaining_base_units: string }>(
      `SELECT status, bankroll_remaining_base_units::text FROM gladiator_sessions WHERE id = $1`,
      [body.session_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('OPEN');
    expect(rows[0].bankroll_remaining_base_units).toBe(DEFAULT_BANKROLL);

    // Verify tokens were burned: balance should be 1000 - 100 = 900
    const { rows: tokenRows } = await ctx.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS total FROM tokens WHERE owner_email = 'a@b.com' AND state = 'VALID'`,
    );
    expect(BigInt(tokenRows[0].total)).toBe(1000n - BigInt(DEFAULT_BANKROLL));

    // Verify SYSTEM chat row was inserted
    const { rows: chatRows } = await ctx.pool.query<{ kind: string; body: string }>(
      `SELECT kind, body FROM gladiator_chat_messages ORDER BY created_at DESC LIMIT 1`,
    );
    expect(chatRows).toHaveLength(1);
    expect(chatRows[0].kind).toBe('SYSTEM');
    expect(chatRows[0].body).toContain('@alice');
    expect(chatRows[0].body).toContain('entered');
  });

  it('409 SESSION_ALREADY_OPEN when user tries a second OPEN session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    await seedToken(ctx.pool, 'a@b.com', 10_000n);
    await ctx.pool.query(`UPDATE app_counters SET value = 10000 WHERE name = 'minted_supply'`);

    // First enter - should succeed
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(first.statusCode).toBe(200);

    // Second enter - should fail
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('SESSION_ALREADY_OPEN');
  });
});

// ---------------------------------------------------------------------------
// POST /api/gladiator/sessions/:id/close — Leave arena
// ---------------------------------------------------------------------------

describe('POST /api/gladiator/sessions/:id/close', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const fakeId = randomUUID();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/gladiator/sessions/${fakeId}/close`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
  });

  it('404 when session id is unknown', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const fakeId = randomUUID();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/gladiator/sessions/${fakeId}/close`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('SESSION_NOT_FOUND');
  });

  it('403 when session belongs to someone else', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // Alice creates a session
    const cookieAlice = await login(ctx, 'alice@b.com');
    await markVerified(ctx.pool, 'alice@b.com', 'alice');
    await seedToken(ctx.pool, 'alice@b.com', 1000n);
    await ctx.pool.query(`UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`);

    const enterRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie: cookieAlice, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(enterRes.statusCode).toBe(200);
    const sessionId = enterRes.json().session_id;

    // Bob tries to close Alice's session
    const cookieBob = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    const closeRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/gladiator/sessions/${sessionId}/close`,
      headers: { cookie: cookieBob },
    });
    expect(closeRes.statusCode).toBe(403);
    expect(closeRes.json().error).toBe('FORBIDDEN');
  });

  it('409 when session is already CLOSED', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    await seedToken(ctx.pool, 'a@b.com', 1000n);
    await ctx.pool.query(`UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`);

    // Enter
    const enterRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(enterRes.statusCode).toBe(200);
    const sessionId = enterRes.json().session_id;

    // Close once — should succeed
    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/gladiator/sessions/${sessionId}/close`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);

    // Close again — should 409
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/gladiator/sessions/${sessionId}/close`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('SESSION_NOT_OPEN');
  });

  it('200 happy path: status CLOSED, token refunded, chat row inserted', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    await seedToken(ctx.pool, 'a@b.com', 1000n);
    await ctx.pool.query(`UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`);

    // Enter with bankroll = 100, bet = 10
    const enterRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(enterRes.statusCode).toBe(200);
    const sessionId = enterRes.json().session_id;

    // Balance after entering: 1000 - 100 = 900
    const { rows: beforeClose } = await ctx.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS total FROM tokens WHERE owner_email = 'a@b.com' AND state = 'VALID'`,
    );
    expect(BigInt(beforeClose[0].total)).toBe(900n);

    // Leave arena
    const closeRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/gladiator/sessions/${sessionId}/close`,
      headers: { cookie },
    });
    expect(closeRes.statusCode).toBe(200);
    const closeBody = closeRes.json();
    expect(closeBody.status).toBe('CLOSED');
    expect(closeBody.closed_at).toBeTruthy();
    expect(closeBody.refunded_base_units).toBe(DEFAULT_BANKROLL);

    // DB session row: should be CLOSED
    const { rows: sessionRows } = await ctx.pool.query<{ status: string; closed_at: Date | null }>(
      `SELECT status, closed_at FROM gladiator_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(sessionRows[0].status).toBe('CLOSED');
    expect(sessionRows[0].closed_at).toBeTruthy();

    // Balance after leaving: 900 + 100 (refund) = 1000 restored
    const { rows: afterClose } = await ctx.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(value), 0)::text AS total FROM tokens WHERE owner_email = 'a@b.com' AND state = 'VALID'`,
    );
    expect(BigInt(afterClose[0].total)).toBe(1000n);

    // SYSTEM chat row should exist for the leave event
    const { rows: chatRows } = await ctx.pool.query<{ kind: string; body: string }>(
      `SELECT kind, body FROM gladiator_chat_messages ORDER BY created_at DESC LIMIT 1`,
    );
    expect(chatRows[0].kind).toBe('SYSTEM');
    expect(chatRows[0].body).toContain('@alice');
    expect(chatRows[0].body).toContain('left the arena');
  });
});
