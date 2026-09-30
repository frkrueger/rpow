import type { FastifyInstance } from 'fastify';
import { readSession } from '../auth.js';

export async function meRoutes(app: FastifyInstance) {
  // --------------------------------------------------------------------------
  // GET /api/trivia/me
  // --------------------------------------------------------------------------
  app.get('/api/trivia/me', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const [userRes, openSessRes, careerRes] = await Promise.all([
      app.pool.query<{
        email: string;
        x_handle: string | null;
        x_handle_verified_at: Date | null;
        x_avatar_url: string | null;
      }>(
        `SELECT email, x_handle, x_handle_verified_at, x_avatar_url FROM users WHERE email = $1`,
        [s.email],
      ),
      app.pool.query(
        `SELECT id,
                bet_base_units::text,
                bankroll_initial_base_units::text,
                bankroll_remaining_base_units::text,
                matches_won,
                matches_lost,
                status,
                opened_at,
                last_match_at,
                closed_at
           FROM trivia_sessions
          WHERE account_email = $1 AND status = 'OPEN'`,
        [s.email],
      ),
      app.pool.query<{ wins: string; losses: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE winner_email = $1)::int AS wins,
           COUNT(*) FILTER (WHERE (offerer_email = $1 OR challenger_email = $1) AND winner_email IS NOT NULL AND winner_email != $1)::int AS losses
         FROM trivia_matches
         WHERE state = 'RESOLVED' AND (offerer_email = $1 OR challenger_email = $1)`,
        [s.email],
      ),
    ]);

    if (userRes.rows.length === 0) {
      return reply.code(404).send({ error: 'USER_NOT_FOUND', message: 'user not found' });
    }

    const user = userRes.rows[0];
    const openSession = openSessRes.rows.length > 0 ? openSessRes.rows[0] : null;
    const careerRow = careerRes.rows[0];
    const career = {
      wins: Number(careerRow?.wins ?? 0),
      losses: Number(careerRow?.losses ?? 0),
    };

    return reply.code(200).send({
      email: user.email,
      x_handle: user.x_handle ?? null,
      x_handle_verified_at: user.x_handle_verified_at ? user.x_handle_verified_at.toISOString() : null,
      x_avatar_url: user.x_avatar_url ?? null,
      open_session: openSession,
      career,
    });
  });
}
