import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readSession } from '../auth.js';
import { withTx } from '../../db.js';
import { burnFromUser } from '../../longshot/burn.js';
import { resolveMatchTx } from '../../trivia/resolve.js';
import { pickSupplyShard } from '../../supplyShards.js';


type MatchRow = {
  id: string;
  offerer_email: string;
  challenger_email: string;
  offerer_x_handle: string | null;
  challenger_x_handle: string | null;
  bet_base_units: string;
  winner_email: string;
  offerer_choice_idx: number | null;
  challenger_choice_idx: number | null;
  question_id: string;
  created_at: Date;
  resolved_at: Date;
};

const MATCH_SELECT = `
  SELECT
    m.id, m.offerer_email, m.challenger_email,
    offerer_user.x_handle AS offerer_x_handle,
    challenger_user.x_handle AS challenger_x_handle,
    m.bet_base_units::text, m.winner_email,
    m.offerer_choice_idx, m.challenger_choice_idx,
    m.question_id, m.created_at, m.resolved_at
  FROM trivia_matches m
  LEFT JOIN users offerer_user ON offerer_user.email = m.offerer_email
  LEFT JOIN users challenger_user ON challenger_user.email = m.challenger_email
  WHERE m.state = 'RESOLVED'
`;

function formatMatch(r: MatchRow) {
  return {
    id: r.id,
    offerer_email: r.offerer_email,
    challenger_email: r.challenger_email,
    offerer_x_handle: r.offerer_x_handle ?? null,
    challenger_x_handle: r.challenger_x_handle ?? null,
    bet_base_units: r.bet_base_units,
    winner_email: r.winner_email,
    offerer_choice_idx: r.offerer_choice_idx,
    challenger_choice_idx: r.challenger_choice_idx,
    question_id: r.question_id,
    created_at: r.created_at.toISOString(),
    resolved_at: r.resolved_at.toISOString(),
  };
}

type PollMatchRow = {
  id: string;
  state: 'ACTIVE' | 'RESOLVED';
  offerer_email: string;
  challenger_email: string;
  offerer_x_handle: string | null;
  challenger_x_handle: string | null;
  bet_base_units: string;
  question_id: string;
  question: string;
  choices: string[];
  correct_idx: number;
  offerer_choice_idx: number | null;
  offerer_answered_at: Date | null;
  challenger_choice_idx: number | null;
  challenger_answered_at: Date | null;
  winner_email: string | null;
  signature: Buffer | null;
  deadline_at: Date;
  created_at: Date;
  resolved_at: Date | null;
};

function formatPollMatch(r: PollMatchRow) {
  const resolved = r.state === 'RESOLVED';
  return {
    id: r.id,
    state: r.state,
    offerer_email: r.offerer_email,
    challenger_email: r.challenger_email,
    offerer_x_handle: r.offerer_x_handle ?? null,
    challenger_x_handle: r.challenger_x_handle ?? null,
    bet_base_units: r.bet_base_units,
    question_id: r.question_id,
    question: r.question,
    choices: r.choices,
    // Don't leak the correct answer or the opponent's choice while the match
    // is still active — the *_answered booleans below tell the client that
    // the opponent has answered without revealing what they picked.
    correct_choice_idx: resolved ? r.correct_idx : null,
    offerer_choice_idx: resolved ? r.offerer_choice_idx : null,
    offerer_answered: r.offerer_choice_idx !== null,
    offerer_answered_at: resolved ? (r.offerer_answered_at?.toISOString() ?? null) : null,
    challenger_choice_idx: resolved ? r.challenger_choice_idx : null,
    challenger_answered: r.challenger_choice_idx !== null,
    challenger_answered_at: resolved ? (r.challenger_answered_at?.toISOString() ?? null) : null,
    winner_email: r.winner_email,
    signature_hex: r.signature ? Buffer.from(r.signature).toString('hex') : null,
    deadline_at: r.deadline_at.toISOString(),
    created_at: r.created_at.toISOString(),
    resolved_at: r.resolved_at?.toISOString() ?? null,
    // Server-anchored clock — clients use this to correct for local clock skew
    // when computing the countdown remaining time.
    server_time: new Date().toISOString(),
  };
}

const POLL_MATCH_SELECT = `
  SELECT
    m.id, m.state,
    m.offerer_email, m.challenger_email,
    off_user.x_handle AS offerer_x_handle,
    cha_user.x_handle AS challenger_x_handle,
    m.bet_base_units::text,
    m.question_id, q.question, q.choices, q.correct_idx,
    m.offerer_choice_idx, m.offerer_answered_at,
    m.challenger_choice_idx, m.challenger_answered_at,
    m.winner_email, m.signature,
    m.deadline_at, m.created_at, m.resolved_at
  FROM trivia_matches m
  JOIN trivia_questions q ON q.id = m.question_id
  LEFT JOIN users off_user ON off_user.email = m.offerer_email
  LEFT JOIN users cha_user ON cha_user.email = m.challenger_email
`;

const StartBody = z.object({
  session_id: z.string().uuid(),
});

const AnswerBody = z.object({
  choice_idx: z.number().int().min(0).max(3),
});

function isAllowed(allowlistCsv: string, email: string): boolean {
  const trimmed = allowlistCsv.trim();
  if (trimmed === '*') return true;
  const emailLower = email.toLowerCase();
  return trimmed.split(',').map((e) => e.trim().toLowerCase()).includes(emailLower);
}

export async function matchesRoutes(app: FastifyInstance) {
  app.post('/api/trivia/matches/start', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (req: any) => req.headers['x-forwarded-for'] ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const challengerEmail = s.email;

    if (!isAllowed(app.config.triviaAllowedEmails, challengerEmail)) {
      return reply.code(403).send({ error: 'NOT_ALLOWED', message: 'trivia access required' });
    }

    const challengerRes = await app.pool.query<{
      x_handle: string | null;
      x_handle_verified_at: Date | null;
    }>(
      `SELECT x_handle, x_handle_verified_at FROM users WHERE email = $1`,
      [challengerEmail],
    );
    const ch = challengerRes.rows[0];
    if (!ch || !ch.x_handle || !ch.x_handle_verified_at) {
      return reply.code(403).send({ error: 'X_HANDLE_REQUIRED', message: 'X handle verification required' });
    }

    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }
    const sessionId = parsed.data.session_id;

    type StartResult =
      | {
          ok: true;
          matchId: string;
          questionId: string;
          question: string;
          choices: string[];
          bet: bigint;
          deadlineAt: Date;
        }
      | { error: string; message: string; status: number };

    let result: StartResult;
    try {
      result = await withTx<StartResult>(app.pool, async (c) => {
        const sessRes = await c.query<{
          id: string;
          account_email: string;
          bet_base_units: string;
          bankroll_remaining_base_units: string;
          status: string;
        }>(
          `SELECT id, account_email, bet_base_units::text,
                  bankroll_remaining_base_units::text, status
           FROM trivia_sessions WHERE id = $1 FOR UPDATE`,
          [sessionId],
        );
        if (sessRes.rows.length === 0) {
          return { error: 'SESSION_NOT_FOUND', message: 'session not found', status: 404 };
        }
        const sess = sessRes.rows[0];
        if (sess.account_email === challengerEmail) {
          return { error: 'SELF_CHALLENGE', message: 'cannot challenge your own session', status: 400 };
        }
        const bet = BigInt(sess.bet_base_units);
        const bankroll = BigInt(sess.bankroll_remaining_base_units);
        if (sess.status !== 'OPEN' || bankroll < bet) {
          return { error: 'OFFER_UNAVAILABLE', message: 'session not open or bankroll insufficient', status: 409 };
        }

        const qRes = await c.query<{
          id: string; question: string; choices: string[];
        }>(
          `SELECT id, question, choices
           FROM trivia_questions
           ORDER BY random() LIMIT 1`,
        );
        if (qRes.rows.length === 0) {
          return { error: 'NO_QUESTIONS_AVAILABLE', message: 'no trivia questions cached', status: 503 };
        }
        const q = qRes.rows[0];

        await burnFromUser(c, challengerEmail, bet, app.config.signingPrivateKeyHex);
        await c.query(
          `UPDATE app_counters SET value = value - $1::bigint
           WHERE name = 'minted_supply' AND shard = $2`,
          [bet.toString(), pickSupplyShard()],
        );

        const matchId = randomUUID();
        const deadlineSeconds = app.config.triviaMatchDeadlineSeconds;
        const insertRes = await c.query<{ deadline_at: Date }>(
          `INSERT INTO trivia_matches
             (id, offerer_session_id, offerer_email, challenger_email,
              bet_base_units, question_id, state, deadline_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', now() + ($7 || ' seconds')::interval)
           RETURNING deadline_at`,
          [matchId, sessionId, sess.account_email, challengerEmail,
           bet.toString(), q.id, String(deadlineSeconds)],
        );

        return {
          ok: true,
          matchId,
          questionId: q.id,
          question: q.question,
          choices: q.choices,
          bet,
          deadlineAt: insertRes.rows[0].deadline_at,
        };
      });
    } catch (e: any) {
      if (e?.message === 'INSUFFICIENT_BALANCE') {
        return reply.code(409).send({ error: 'INSUFFICIENT_BALANCE', message: 'not enough tokens' });
      }
      if (e?.code === '23505') {
        return reply.code(409).send({ error: 'OFFER_UNAVAILABLE', message: 'session already has an active match' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    return reply.code(200).send({
      match_id: result.matchId,
      question_id: result.questionId,
      question: result.question,
      choices: result.choices,
      bet_base_units: result.bet.toString(),
      deadline_at: result.deadlineAt.toISOString(),
      server_time: new Date().toISOString(),
    });
  });
  app.get('/api/trivia/matches/active', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const query = req.query as Record<string, string | undefined>;
    const sessionId = query['session_id'];
    if (!sessionId) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'session_id required' });
    }

    // Ownership check.
    const sessRes = await app.pool.query<{ account_email: string }>(
      `SELECT account_email FROM trivia_sessions WHERE id = $1`,
      [sessionId],
    );
    if (sessRes.rows.length === 0) {
      return reply.code(404).send({ error: 'SESSION_NOT_FOUND', message: 'session not found' });
    }
    if (sessRes.rows[0].account_email !== s.email) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'not your session' });
    }

    // Find the most recent match for this session. ACTIVE always wins;
    // otherwise fall back to a very recent RESOLVED one so the offerer's
    // UI can render the result for ~5s.
    const matchRes = await app.pool.query<PollMatchRow>(
      `${POLL_MATCH_SELECT}
       WHERE m.offerer_session_id = $1
         AND (m.state = 'ACTIVE'
              OR (m.state = 'RESOLVED' AND m.resolved_at > now() - interval '5 seconds'))
       ORDER BY m.created_at DESC LIMIT 1`,
      [sessionId],
    );
    if (matchRes.rows.length === 0) {
      return reply.code(200).send({ match: null });
    }
    let row = matchRes.rows[0];

    // Lazy resolve if ACTIVE but deadline has passed.
    if (row.state === 'ACTIVE' && row.deadline_at.getTime() <= Date.now()) {
      try {
        await withTx(app.pool, async (c) => {
          await resolveMatchTx(c, row.id, {
            signingPrivateKeyHex: app.config.signingPrivateKeyHex,
            mintMaxSupply: app.config.mintMaxSupply,
          });
        });
      } catch (e: any) {
        if (e?.message !== 'SUPPLY_CAP_REACHED') throw e;
        return reply.code(503).send({ error: 'SUPPLY_CAP_REACHED', message: 'minted supply cap reached' });
      }
      const refetch = await app.pool.query<PollMatchRow>(
        `${POLL_MATCH_SELECT} WHERE m.id = $1`,
        [row.id],
      );
      row = refetch.rows[0];
    }

    return reply.code(200).send({ match: formatPollMatch(row) });
  });
  app.get('/api/trivia/matches/recent', async (_req, reply) => {
    const res = await app.pool.query<MatchRow>(
      `${MATCH_SELECT} ORDER BY m.created_at DESC LIMIT 50`,
    );
    return reply.code(200).send({ matches: res.rows.map(formatMatch) });
  });
  app.get('/api/trivia/matches/history', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const res = await app.pool.query<MatchRow>(
      `${MATCH_SELECT} AND (m.offerer_email = $1 OR m.challenger_email = $1) ORDER BY m.created_at DESC LIMIT 50`,
      [s.email],
    );
    return reply.code(200).send({ matches: res.rows.map(formatMatch) });
  });
  app.post('/api/trivia/matches/:id/answer', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (req: any) => req.headers['x-forwarded-for'] ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const caller = s.email;

    const parsed = AnswerBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }
    const choiceIdx = parsed.data.choice_idx;
    const { id: matchId } = req.params as { id: string };

    type AnswerResult =
      | { ok: true; answeredAt: Date; bothAnswered: boolean }
      | { error: string; message: string; status: number };

    let result: AnswerResult;
    try {
      result = await withTx<AnswerResult>(app.pool, async (c) => {
        const mRes = await c.query<{
          state: string;
          offerer_email: string;
          challenger_email: string;
          offerer_choice_idx: number | null;
          challenger_choice_idx: number | null;
          expired: boolean;
        }>(
          `SELECT state, offerer_email, challenger_email,
                  offerer_choice_idx, challenger_choice_idx,
                  (now() >= deadline_at) AS expired
           FROM trivia_matches WHERE id = $1 FOR UPDATE`,
          [matchId],
        );
        if (mRes.rows.length === 0) {
          return { error: 'MATCH_NOT_FOUND', message: 'match not found', status: 404 };
        }
        const m = mRes.rows[0];
        if (m.state !== 'ACTIVE') {
          return { error: 'MATCH_EXPIRED', message: 'match is not active', status: 410 };
        }
        if (m.expired) {
          return { error: 'MATCH_EXPIRED', message: 'deadline passed', status: 410 };
        }
        const isOfferer = m.offerer_email === caller;
        const isChallenger = m.challenger_email === caller;
        if (!isOfferer && !isChallenger) {
          return { error: 'NOT_A_PLAYER', message: 'not a player of this match', status: 403 };
        }
        const alreadyAnswered = isOfferer ? m.offerer_choice_idx !== null : m.challenger_choice_idx !== null;
        if (alreadyAnswered) {
          return { error: 'ALREADY_ANSWERED', message: 'you already answered', status: 409 };
        }

        const col = isOfferer ? 'offerer' : 'challenger';
        const upd = await c.query<{ answered_at: Date }>(
          `UPDATE trivia_matches
           SET ${col}_choice_idx = $1, ${col}_answered_at = now()
           WHERE id = $2
           RETURNING ${col}_answered_at AS answered_at`,
          [choiceIdx, matchId],
        );

        const both = isOfferer
          ? m.challenger_choice_idx !== null
          : m.offerer_choice_idx !== null;

        if (both) {
          await resolveMatchTx(c, matchId, {
            signingPrivateKeyHex: app.config.signingPrivateKeyHex,
            mintMaxSupply: app.config.mintMaxSupply,
          });
        }

        return { ok: true, answeredAt: upd.rows[0].answered_at, bothAnswered: both };
      });
    } catch (e: any) {
      if (e?.message === 'SUPPLY_CAP_REACHED') {
        return reply.code(503).send({ error: 'SUPPLY_CAP_REACHED', message: 'minted supply cap reached' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    return reply.code(200).send({
      answered_at: result.answeredAt.toISOString(),
      both_answered: result.bothAnswered,
    });
  });
  // Note: register the parameterized GET LAST so the string-literal routes
  // (start/active/recent/history) match before this catch-all does.
  app.get('/api/trivia/matches/:id', async (req, reply) => {
    const sSess = readSession(req as any, app.config.sessionSecret);
    if (!sSess) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const { id: mid } = req.params as { id: string };

    const r = await app.pool.query<PollMatchRow>(
      `${POLL_MATCH_SELECT} WHERE m.id = $1`,
      [mid],
    );
    if (r.rows.length === 0) {
      return reply.code(404).send({ error: 'MATCH_NOT_FOUND', message: 'match not found' });
    }
    let row = r.rows[0];

    if (row.offerer_email !== sSess.email && row.challenger_email !== sSess.email) {
      return reply.code(403).send({ error: 'NOT_A_PLAYER', message: 'not a player of this match' });
    }

    if (row.state === 'ACTIVE' && row.deadline_at.getTime() <= Date.now()) {
      try {
        await withTx(app.pool, async (c) => {
          await resolveMatchTx(c, mid, {
            signingPrivateKeyHex: app.config.signingPrivateKeyHex,
            mintMaxSupply: app.config.mintMaxSupply,
          });
        });
      } catch (e: any) {
        if (e?.message !== 'SUPPLY_CAP_REACHED') throw e;
        return reply.code(503).send({ error: 'SUPPLY_CAP_REACHED', message: 'minted supply cap reached' });
      }
      const refetch = await app.pool.query<PollMatchRow>(
        `${POLL_MATCH_SELECT} WHERE m.id = $1`,
        [mid],
      );
      row = refetch.rows[0];
    }

    return reply.code(200).send({ match: formatPollMatch(row) });
  });
}
