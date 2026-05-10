import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import * as randomness from '../src/gladiator/randomness.js';
import { verifyFlipPayload, type FlipPayload } from '../src/signing.js';

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

async function totalSupply(pool: any): Promise<bigint> {
  const res = await pool.query<{ value: string }>(
    `SELECT value::text FROM app_counters WHERE name = 'minted_supply'`,
  );
  return BigInt(res.rows[0]?.value ?? '0');
}

async function userBalance(pool: any, email: string): Promise<bigint> {
  const res = await pool.query<{ sum: string | null }>(
    `SELECT COALESCE(SUM(value), 0)::text AS sum FROM tokens
     WHERE owner_email = $1 AND state = 'VALID'`,
    [email],
  );
  return BigInt(res.rows[0].sum ?? '0');
}

// ---------------------------------------------------------------------------
// Auth / validation
// ---------------------------------------------------------------------------

describe('POST /api/gladiator/flip', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
    vi.restoreAllMocks();
  });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { 'content-type': 'application/json' },
      payload: { session_id: randomUUID() },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
  });

  it('403 X_HANDLE_REQUIRED for unverified challenger', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@b.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: randomUUID() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('X_HANDLE_REQUIRED');
  });

  it('400 BAD_REQUEST for missing session_id', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('400 BAD_REQUEST for non-uuid session_id', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('404 SESSION_NOT_FOUND when session does not exist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: randomUUID() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('SESSION_NOT_FOUND');
  });

  it('409 OFFER_UNAVAILABLE when session is CLOSED', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    await ctx.pool.query(
      `UPDATE gladiator_sessions SET status = 'CLOSED', closed_at = now() WHERE id = $1`,
      [sessionId],
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('OFFER_UNAVAILABLE');
  });

  it('400 SELF_CHALLENGE when offerer tries to flip own session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('SELF_CHALLENGE');
  });

  it('409 INSUFFICIENT_BALANCE when challenger has no tokens', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  it('CHALLENGER WINS: balance +bet, bankroll -bet, supply +bet, flips_lost+=1', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    await seedToken(ctx.pool, 'bob@b.com', 1000n);
    await ctx.pool.query(
      `UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`,
    );
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);

    vi.spyOn(randomness, 'drawFlip').mockReturnValue({ challengerWins: true, hex: '01' });

    const before = { bal: await userBalance(ctx.pool, 'bob@b.com'), supply: await totalSupply(ctx.pool) };

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.winner_email).toBe('bob@b.com');
    expect(body.bet_base_units).toBe('10');
    expect(body.random_value_hex).toBe('01');
    expect(body.session_status).toBe('OPEN');
    expect(body.bankroll_remaining_base_units).toBe('90');
    expect(body.closed_at).toBeNull();
    expect(typeof body.share_text).toBe('string');
    expect(body.share_text).toMatch(/won .* RPOW.*@alice/i);

    const after = { bal: await userBalance(ctx.pool, 'bob@b.com'), supply: await totalSupply(ctx.pool) };
    expect(after.bal - before.bal).toBe(10n);
    expect(after.supply - before.supply).toBe(10n);

    const sess = await ctx.pool.query<{
      bankroll_remaining_base_units: string;
      flips_won: number;
      flips_lost: number;
      last_flip_at: Date | null;
      status: string;
    }>(
      `SELECT bankroll_remaining_base_units::text, flips_won, flips_lost, last_flip_at, status
       FROM gladiator_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(sess.rows[0].bankroll_remaining_base_units).toBe('90');
    expect(sess.rows[0].flips_won).toBe(0);
    expect(sess.rows[0].flips_lost).toBe(1);
    expect(sess.rows[0].last_flip_at).not.toBeNull();
    expect(sess.rows[0].status).toBe('OPEN');
  });

  it('OFFERER WINS: balance -bet, bankroll +bet, supply -bet, flips_won+=1', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    await seedToken(ctx.pool, 'bob@b.com', 1000n);
    await ctx.pool.query(
      `UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`,
    );
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);

    vi.spyOn(randomness, 'drawFlip').mockReturnValue({ challengerWins: false, hex: '00' });

    const before = { bal: await userBalance(ctx.pool, 'bob@b.com'), supply: await totalSupply(ctx.pool) };

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.winner_email).toBe('alice@a.com');
    expect(body.bet_base_units).toBe('10');
    expect(body.random_value_hex).toBe('00');
    expect(body.session_status).toBe('OPEN');
    expect(body.bankroll_remaining_base_units).toBe('110');
    expect(body.closed_at).toBeNull();

    const after = { bal: await userBalance(ctx.pool, 'bob@b.com'), supply: await totalSupply(ctx.pool) };
    expect(after.bal - before.bal).toBe(-10n);
    expect(after.supply - before.supply).toBe(-10n);

    const sess = await ctx.pool.query<{
      bankroll_remaining_base_units: string;
      flips_won: number;
      flips_lost: number;
      status: string;
    }>(
      `SELECT bankroll_remaining_base_units::text, flips_won, flips_lost, status
       FROM gladiator_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(sess.rows[0].bankroll_remaining_base_units).toBe('110');
    expect(sess.rows[0].flips_won).toBe(1);
    expect(sess.rows[0].flips_lost).toBe(0);
    expect(sess.rows[0].status).toBe('OPEN');
  });

  // ---------------------------------------------------------------------------
  // Drain (auto-close)
  // ---------------------------------------------------------------------------

  it('DRAIN: when bankroll_remaining < bet after settle, session auto-closes and remainder is minted back', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    await seedToken(ctx.pool, 'bob@b.com', 1000n);
    await ctx.pool.query(
      `UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`,
    );
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 10n);

    vi.spyOn(randomness, 'drawFlip').mockReturnValue({ challengerWins: true, hex: '01' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session_status).toBe('CLOSED');
    expect(body.bankroll_remaining_base_units).toBe('0');
    expect(body.closed_at).not.toBeNull();

    const sess = await ctx.pool.query<{ status: string; closed_at: Date | null }>(
      `SELECT status, closed_at FROM gladiator_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(sess.rows[0].status).toBe('CLOSED');
    expect(sess.rows[0].closed_at).not.toBeNull();
  });

  // The "drain with leftover" branch (newBankroll > 0 && < bet) is not
  // testable from a legal session state: migration 014's
  // CHECK (bankroll_initial % bet = 0) means bankroll_remaining is always a
  // clean multiple of bet, so post-flip remainder can only be 0 or >= bet.
  // The refund-mint path is exercised by the existing sessions/close test.

  // ---------------------------------------------------------------------------
  // Audit + chat side-effects
  // ---------------------------------------------------------------------------

  it('AUDIT: inserts a gladiator_flips row whose signature verifies under the public key', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    await seedToken(ctx.pool, 'bob@b.com', 1000n);
    await ctx.pool.query(
      `UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`,
    );
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);

    vi.spyOn(randomness, 'drawFlip').mockReturnValue({ challengerWins: true, hex: 'a5' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await ctx.pool.query<{
      id: string;
      offerer_session_id: string;
      challenger_session_id: string | null;
      offerer_email: string;
      challenger_email: string;
      bet_base_units: string;
      winner_email: string;
      random_value_hex: string;
      signature: Buffer;
      created_at: Date;
    }>(`SELECT id, offerer_session_id, challenger_session_id, offerer_email, challenger_email,
                bet_base_units::text, winner_email, random_value_hex, signature, created_at
         FROM gladiator_flips`);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.offerer_session_id).toBe(sessionId);
    expect(r.challenger_session_id).toBeNull();
    expect(r.offerer_email).toBe('alice@a.com');
    expect(r.challenger_email).toBe('bob@b.com');
    expect(r.bet_base_units).toBe('10');
    expect(r.winner_email).toBe('bob@b.com');
    expect(r.random_value_hex).toBe('a5');
    expect(r.signature.length).toBeGreaterThan(0);

    const payload: FlipPayload = {
      id: r.id,
      offerer_email_hash: createHash('sha256').update('alice@a.com').digest('hex'),
      challenger_email_hash: createHash('sha256').update('bob@b.com').digest('hex'),
      bet_base_units: BigInt(r.bet_base_units),
      winner_email_hash: createHash('sha256').update('bob@b.com').digest('hex'),
      random_value_hex: r.random_value_hex,
      created_at: r.created_at.toISOString(),
    };
    const pubHex = ctx.app.config.signingPublicKeyHex;
    expect(verifyFlipPayload(payload, r.signature, pubHex)).toBe(true);
  });

  it('CHAT: inserts a SYSTEM row about the flip result', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    await seedToken(ctx.pool, 'bob@b.com', 1000n);
    await ctx.pool.query(
      `UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`,
    );
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);

    vi.spyOn(randomness, 'drawFlip').mockReturnValue({ challengerWins: true, hex: '01' });

    await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });

    const { rows } = await ctx.pool.query<{ kind: string; body: string }>(
      `SELECT kind, body FROM gladiator_chat_messages
       WHERE kind = 'SYSTEM' AND body LIKE '%beat%'
       ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toMatch(/@bob beat @alice for .* RPOW/i);
  });

  it('CHAT (drain): inserts a SYSTEM row about the drain in addition to the flip row', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    await seedToken(ctx.pool, 'bob@b.com', 1000n);
    await ctx.pool.query(
      `UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`,
    );
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 10n);

    vi.spyOn(randomness, 'drawFlip').mockReturnValue({ challengerWins: true, hex: '01' });

    await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });

    const drainChat = await ctx.pool.query<{ body: string }>(
      `SELECT body FROM gladiator_chat_messages
       WHERE kind = 'SYSTEM' AND body LIKE '%drained%'`,
    );
    expect(drainChat.rows).toHaveLength(1);
    expect(drainChat.rows[0].body).toMatch(/@alice drained out of the arena/i);

    const flipChat = await ctx.pool.query<{ body: string }>(
      `SELECT body FROM gladiator_chat_messages
       WHERE kind = 'SYSTEM' AND body LIKE '%beat%'`,
    );
    expect(flipChat.rows).toHaveLength(1);
  });
});
