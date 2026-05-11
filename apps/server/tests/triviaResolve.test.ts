import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { resolveMatchTx } from '../src/trivia/resolve.js';
import { verifyMatchPayload, type MatchPayload } from '../src/signing.js';

async function seedQuestion(pool: any, correctIdx: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trivia_questions(id, category, difficulty, question, correct_idx, choices)
     VALUES($1, 'General', 'easy', 'capital of France?', $2, ARRAY['London','Paris','Berlin','Tokyo'])`,
    [id, correctIdx],
  );
  return id;
}

async function seedSession(pool: any, email: string, bet: bigint, bankroll: bigint): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trivia_sessions(id, account_email, bet_base_units, bankroll_initial_base_units,
       bankroll_remaining_base_units, status, opened_at)
     VALUES($1, $2, $3, $4, $5, 'OPEN', now())`,
    [id, email, bet.toString(), bankroll.toString(), bankroll.toString()],
  );
  return id;
}

async function seedMatch(
  pool: any,
  opts: {
    offererSessionId: string;
    offererEmail: string;
    challengerEmail: string;
    bet: bigint;
    questionId: string;
    offererChoice: number | null;
    offererAnsweredAt: Date | null;
    challengerChoice: number | null;
    challengerAnsweredAt: Date | null;
    deadlineSecondsFromNow: number; // negative = already expired
  },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trivia_matches(id, offerer_session_id, offerer_email, challenger_email,
       bet_base_units, question_id, state, deadline_at,
       offerer_choice_idx, offerer_answered_at,
       challenger_choice_idx, challenger_answered_at, created_at)
     VALUES($1, $2, $3, $4, $5, $6, 'ACTIVE', now() + ($7 || ' seconds')::interval,
            $8, $9, $10, $11, now() - interval '1 hour')`,
    [
      id,
      opts.offererSessionId,
      opts.offererEmail,
      opts.challengerEmail,
      opts.bet.toString(),
      opts.questionId,
      String(opts.deadlineSecondsFromNow),
      opts.offererChoice,
      opts.offererAnsweredAt,
      opts.challengerChoice,
      opts.challengerAnsweredAt,
    ],
  );
  // Mirror minted_supply: challenger's bet was burned before this row existed.
  await pool.query(
    `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
    [opts.bet.toString()],
  );
  return id;
}

async function getMatch(pool: any, id: string) {
  const r = await pool.query(
    `SELECT state, winner_email, signature,
            offerer_choice_idx, offerer_answered_at,
            challenger_choice_idx, challenger_answered_at,
            created_at, resolved_at
     FROM trivia_matches WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function getSession(pool: any, id: string) {
  const r = await pool.query(
    `SELECT status, bankroll_remaining_base_units::text AS bankroll_remaining,
            matches_won, matches_lost
     FROM trivia_sessions WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

import { withTx } from '../src/db.js';
import { createHash } from 'node:crypto';

describe('resolveMatchTx — §4 resolution table', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  const BET = 10n;
  const BANKROLL = 30n;
  const offerer = 'off@x.com';
  const challenger = 'cha@x.com';

  async function setupCtx() {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    await ctx.pool.query(
      `INSERT INTO users(email, x_handle, x_handle_verified_at) VALUES
         ($1, 'offhandle', now()), ($2, 'chahandle', now())`,
      [offerer, challenger],
    );
    return ctx;
  }

  it('row 1: offerer correct, challenger correct but slower → offerer wins', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const t1 = new Date(Date.now() - 4000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 1, offererAnsweredAt: t0,
      challengerChoice: 1, challengerAnsweredAt: t1,
      deadlineSecondsFromNow: 10,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(offerer);
    const s = await getSession(ctx.pool, sid);
    expect(s.bankroll_remaining).toBe('40');
    expect(s.matches_won).toBe(1);
    expect(s.matches_lost).toBe(0);
    expect(s.status).toBe('OPEN');
  });

  it('row 2: offerer correct slower, challenger correct → challenger wins, payout minted', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const tFast = new Date(Date.now() - 5000);
    const tSlow = new Date(Date.now() - 4000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 1, offererAnsweredAt: tSlow,
      challengerChoice: 1, challengerAnsweredAt: tFast,
      deadlineSecondsFromNow: 10,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(challenger);
    const s = await getSession(ctx.pool, sid);
    expect(s.bankroll_remaining).toBe('20');
    expect(s.matches_lost).toBe(1);
    const tok = await ctx.pool.query(
      `SELECT value::text AS value FROM tokens WHERE owner_email = $1 AND state = 'VALID'`,
      [challenger],
    );
    const total = tok.rows.reduce((acc: bigint, r: any) => acc + BigInt(r.value), 0n);
    expect(total).toBe(20n);
  });

  it('row 3: offerer correct, challenger wrong → offerer wins', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 1, offererAnsweredAt: t0,
      challengerChoice: 3, challengerAnsweredAt: t0,
      deadlineSecondsFromNow: 10,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(offerer);
  });

  it('row 4: offerer wrong, challenger correct → challenger wins', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 3, offererAnsweredAt: t0,
      challengerChoice: 1, challengerAnsweredAt: t0,
      deadlineSecondsFromNow: 10,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(challenger);
  });

  it('row 5: both wrong → offerer wins (challenger loses bet)', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 3, offererAnsweredAt: t0,
      challengerChoice: 2, challengerAnsweredAt: t0,
      deadlineSecondsFromNow: 10,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(offerer);
  });

  it('row 5b: both timeout (null choices) → offerer wins', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: null, offererAnsweredAt: null,
      challengerChoice: null, challengerAnsweredAt: null,
      deadlineSecondsFromNow: -1,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(offerer);
  });

  it('row 6: tie on ms-equal correct timestamps → offerer wins', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 1, offererAnsweredAt: t0,
      challengerChoice: 1, challengerAnsweredAt: t0,
      deadlineSecondsFromNow: 10,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(offerer);
  });

  it('auto-closes the session and mints remainder back when bankroll drops below bet', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BET);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 3, offererAnsweredAt: t0,
      challengerChoice: 1, challengerAnsweredAt: t0,
      deadlineSecondsFromNow: 10,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(challenger);
    expect(res.session_status).toBe('CLOSED');
    const s = await getSession(ctx.pool, sid);
    expect(s.status).toBe('CLOSED');
    expect(s.bankroll_remaining).toBe('0');
    const chat = await ctx.pool.query(
      `SELECT body FROM trivia_chat_messages WHERE kind = 'SYSTEM' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(chat.rows[0]?.body).toContain('drained');
  });

  it('signs the canonical payload and verifies', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 1, offererAnsweredAt: t0,
      challengerChoice: 3, challengerAnsweredAt: t0,
      deadlineSecondsFromNow: 10,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    const m = await getMatch(ctx.pool, mid);
    const payload: MatchPayload = {
      id: mid,
      offerer_email_hash: createHash('sha256').update(offerer).digest('hex'),
      challenger_email_hash: createHash('sha256').update(challenger).digest('hex'),
      bet_base_units: BET,
      question_id: qid,
      offerer_choice_idx: m.offerer_choice_idx,
      offerer_answered_at: m.offerer_answered_at?.toISOString() ?? null,
      challenger_choice_idx: m.challenger_choice_idx,
      challenger_answered_at: m.challenger_answered_at?.toISOString() ?? null,
      winner_email_hash: createHash('sha256').update(res.winner_email).digest('hex'),
      created_at: m.created_at.toISOString(),
    };
    expect(verifyMatchPayload(payload, res.signature, ctx.app.config.signingPublicKeyHex)).toBe(true);
  });

  it('is idempotent — calling twice on a RESOLVED match returns the same signature', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 1, offererAnsweredAt: t0,
      challengerChoice: 3, challengerAnsweredAt: t0,
      deadlineSecondsFromNow: 10,
    });
    const r1 = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    const r2 = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(r1.signature.equals(r2.signature)).toBe(true);
    expect(r1.winner_email).toBe(r2.winner_email);
  });
});
