import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readSession } from '../auth.js';
import { withTx } from '../../db.js';
import { burnFromUser } from '../../longshot/burn.js';

const NOT_IMPLEMENTED = { error: 'NOT_IMPLEMENTED', message: 'trivia slice 1' };

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

const StartBody = z.object({
  session_id: z.string().uuid(),
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
          `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
          [bet.toString()],
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
    });
  });
  app.get('/api/trivia/matches/active', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
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
  app.post('/api/trivia/matches/:id/answer', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
  // Note: register the parameterized GET LAST so the string-literal routes
  // (start/active/recent/history) match before this catch-all does.
  app.get('/api/trivia/matches/:id', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
}
