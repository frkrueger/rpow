import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('migration 014: gladiator', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('adds x_handle columns to users', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { rows } = await ctx.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'users'
         AND column_name IN ('x_handle', 'x_handle_verified_at', 'x_avatar_url')
       ORDER BY column_name`,
    );
    expect(rows.map(r => r.column_name)).toEqual(['x_avatar_url', 'x_handle', 'x_handle_verified_at']);
  });

  it('creates x_verification_codes table', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { rows } = await ctx.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'x_verification_codes'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('creates gladiator_sessions table', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { rows } = await ctx.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'gladiator_sessions'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('creates gladiator_flips table', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { rows } = await ctx.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'gladiator_flips'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('creates gladiator_chat_messages table', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { rows } = await ctx.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'gladiator_chat_messages'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('enforces gladiator_sessions status CHECK constraint', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES('c@d.com')`);
    const insertBadStatus = () => ctx.pool.query(
      `INSERT INTO gladiator_sessions(id, account_email, bet_base_units,
         bankroll_initial_base_units, bankroll_remaining_base_units, status)
       VALUES('00000000-0000-0000-0000-000000000001', 'c@d.com', 100, 100, 100, 'INVALID')`,
    );
    await expect(insertBadStatus()).rejects.toThrow();
  });

  it('enforces gladiator_sessions bankroll-must-be-multiple-of-bet CHECK constraint', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES('e@f.com')`);
    const insertBadBankroll = () => ctx.pool.query(
      `INSERT INTO gladiator_sessions(id, account_email, bet_base_units,
         bankroll_initial_base_units, bankroll_remaining_base_units, status)
       VALUES('00000000-0000-0000-0000-000000000002', 'e@f.com', 100, 150, 150, 'OPEN')`,
    );
    await expect(insertBadBankroll()).rejects.toThrow();
  });

  it('enforces gladiator_chat_messages kind CHECK constraint', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const insertBadKind = () => ctx.pool.query(
      `INSERT INTO gladiator_chat_messages(id, kind, body)
       VALUES('00000000-0000-0000-0000-000000000003', 'INVALID', 'hello')`,
    );
    await expect(insertBadKind()).rejects.toThrow();
  });

  it('enforces gladiator_chat_messages USER-must-have-account_email CHECK constraint', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    // USER row without account_email should fail
    const insertUserNoEmail = () => ctx.pool.query(
      `INSERT INTO gladiator_chat_messages(id, kind, body)
       VALUES('00000000-0000-0000-0000-000000000004', 'USER', 'hello')`,
    );
    await expect(insertUserNoEmail()).rejects.toThrow();
  });

  it('partial unique index gladiator_sessions_one_open_per_user rejects two OPEN rows for same user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES('g@h.com')`);

    // First OPEN session — should succeed
    await ctx.pool.query(
      `INSERT INTO gladiator_sessions(id, account_email, bet_base_units,
         bankroll_initial_base_units, bankroll_remaining_base_units, status)
       VALUES('00000000-0000-0000-0000-000000000010', 'g@h.com', 100, 100, 100, 'OPEN')`,
    );

    // Second OPEN session for same user — must be rejected by the partial unique index
    const insertSecondOpen = () => ctx.pool.query(
      `INSERT INTO gladiator_sessions(id, account_email, bet_base_units,
         bankroll_initial_base_units, bankroll_remaining_base_units, status)
       VALUES('00000000-0000-0000-0000-000000000011', 'g@h.com', 100, 100, 100, 'OPEN')`,
    );
    await expect(insertSecondOpen()).rejects.toThrow();

    // A CLOSED session for the same user should still succeed (index is partial on OPEN)
    await expect(ctx.pool.query(
      `INSERT INTO gladiator_sessions(id, account_email, bet_base_units,
         bankroll_initial_base_units, bankroll_remaining_base_units, status)
       VALUES('00000000-0000-0000-0000-000000000012', 'g@h.com', 100, 100, 100, 'CLOSED')`,
    )).resolves.toBeDefined();
  });

  it('users_x_handle_lower_uniq index rejects duplicate handles (case-insensitive)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, x_handle) VALUES('i@j.com', 'TestUser')`);
    const insertDupe = () => ctx.pool.query(
      `INSERT INTO users(email, x_handle) VALUES('k@l.com', 'testuser')`,
    );
    await expect(insertDupe()).rejects.toThrow();
  });
});
