import type { FastifyInstance } from 'fastify';
import { readSession } from '../auth.js';

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

export async function matchesRoutes(app: FastifyInstance) {
  app.post('/api/trivia/matches/start', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
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
