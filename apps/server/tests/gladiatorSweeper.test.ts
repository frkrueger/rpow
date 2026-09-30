import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { sweepInactiveSessions } from '../src/gladiator/sweeper.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createUser(pool: any, email: string, handle: string) {
  await pool.query(
    `INSERT INTO users (email, x_handle, x_handle_verified_at) VALUES ($1, $2, now())
     ON CONFLICT (email) DO NOTHING`,
    [email, handle],
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

async function userBalance(pool: any, email: string): Promise<bigint> {
  const res = await pool.query<{ sum: string | null }>(
    `SELECT COALESCE(SUM(value), 0)::text AS sum FROM tokens
     WHERE owner_email = $1 AND state = 'VALID'`,
    [email],
  );
  return BigInt(res.rows[0].sum ?? '0');
}

async function getSessionStatus(pool: any, id: string): Promise<string> {
  const res = await pool.query<{ status: string }>(
    `SELECT status FROM gladiator_sessions WHERE id = $1`,
    [id],
  );
  return res.rows[0].status;
}

const SWEEPER_OPTS = {
  signingPrivateKeyHex: '11'.repeat(32),
  ttlHours: 48,
  mintMaxSupply: 21,
};

// ---------------------------------------------------------------------------
// sweepInactiveSessions
// ---------------------------------------------------------------------------

describe('sweepInactiveSessions', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('closes a session whose opened_at is older than ttl and last_flip_at IS NULL', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    await createUser(ctx.pool, 'alice@a.com', 'alice');
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);

    // Age the session beyond TTL
    await ctx.pool.query(
      `UPDATE gladiator_sessions SET opened_at = now() - INTERVAL '50 hours' WHERE id = $1`,
      [sessionId],
    );

    const result = await sweepInactiveSessions(ctx.pool, SWEEPER_OPTS);
    expect(result.swept).toBe(1);
    expect(await getSessionStatus(ctx.pool, sessionId)).toBe('CLOSED');
  });

  it('closes a session whose last_flip_at is older than ttl', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    await createUser(ctx.pool, 'alice@a.com', 'alice');
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);

    // Set last_flip_at to beyond TTL (opened_at is recent)
    await ctx.pool.query(
      `UPDATE gladiator_sessions SET last_flip_at = now() - INTERVAL '50 hours' WHERE id = $1`,
      [sessionId],
    );

    const result = await sweepInactiveSessions(ctx.pool, SWEEPER_OPTS);
    expect(result.swept).toBe(1);
    expect(await getSessionStatus(ctx.pool, sessionId)).toBe('CLOSED');
  });

  it('does NOT close sessions with recent activity', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    await createUser(ctx.pool, 'alice@a.com', 'alice');
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    // opened_at is NOW (fresh session) — not past TTL

    const result = await sweepInactiveSessions(ctx.pool, SWEEPER_OPTS);
    expect(result.swept).toBe(0);
    expect(await getSessionStatus(ctx.pool, sessionId)).toBe('OPEN');
  });

  it('does NOT close already CLOSED sessions', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    await createUser(ctx.pool, 'alice@a.com', 'alice');
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);

    // Pre-close the session and age it
    await ctx.pool.query(
      `UPDATE gladiator_sessions
       SET status = 'CLOSED', closed_at = now(), opened_at = now() - INTERVAL '50 hours'
       WHERE id = $1`,
      [sessionId],
    );

    const result = await sweepInactiveSessions(ctx.pool, SWEEPER_OPTS);
    expect(result.swept).toBe(0);
  });

  it('mints back bankroll_remaining if > 0', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    await createUser(ctx.pool, 'alice@a.com', 'alice');
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    // Prime the minted_supply counter so the cap check passes
    await ctx.pool.query(`UPDATE app_counters SET value = 100 WHERE name = 'minted_supply'`);

    // Age the session
    await ctx.pool.query(
      `UPDATE gladiator_sessions SET opened_at = now() - INTERVAL '50 hours' WHERE id = $1`,
      [sessionId],
    );

    const balanceBefore = await userBalance(ctx.pool, 'alice@a.com');
    const result = await sweepInactiveSessions(ctx.pool, SWEEPER_OPTS);
    expect(result.swept).toBe(1);

    const balanceAfter = await userBalance(ctx.pool, 'alice@a.com');
    // bankroll was 100, should be minted back
    expect(balanceAfter - balanceBefore).toBe(100n);
  });

  it('emits a SYSTEM chat row for auto-closed sessions', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    await createUser(ctx.pool, 'alice@a.com', 'alice');
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    await ctx.pool.query(`UPDATE app_counters SET value = 100 WHERE name = 'minted_supply'`);

    await ctx.pool.query(
      `UPDATE gladiator_sessions SET opened_at = now() - INTERVAL '50 hours' WHERE id = $1`,
      [sessionId],
    );

    await sweepInactiveSessions(ctx.pool, SWEEPER_OPTS);

    const { rows } = await ctx.pool.query<{ kind: string; body: string }>(
      `SELECT kind, body FROM gladiator_chat_messages
       WHERE kind = 'SYSTEM' AND body LIKE '%auto-closed%'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain('@alice');
    expect(rows[0].body).toContain('auto-closed');
  });

  it('returns correct swept count for multiple sessions', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;

    await createUser(ctx.pool, 'alice@a.com', 'alice');
    await createUser(ctx.pool, 'bob@b.com', 'bob');
    await createUser(ctx.pool, 'carol@c.com', 'carol');

    const aliceSession = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    const bobSession = await openSession(ctx.pool, 'bob@b.com', 10n, 100n);
    const carolSession = await openSession(ctx.pool, 'carol@c.com', 10n, 100n);

    await ctx.pool.query(`UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`);

    // Age alice and bob but not carol
    await ctx.pool.query(
      `UPDATE gladiator_sessions SET opened_at = now() - INTERVAL '50 hours' WHERE id = ANY($1)`,
      [[aliceSession, bobSession]],
    );

    const result = await sweepInactiveSessions(ctx.pool, SWEEPER_OPTS);
    expect(result.swept).toBe(2);
    expect(await getSessionStatus(ctx.pool, aliceSession)).toBe('CLOSED');
    expect(await getSessionStatus(ctx.pool, bobSession)).toBe('CLOSED');
    expect(await getSessionStatus(ctx.pool, carolSession)).toBe('OPEN');
  });
});
