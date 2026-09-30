import type { FastifyInstance } from 'fastify';
import { readSession } from '../auth.js';

export async function lobbyRoutes(app: FastifyInstance) {
  app.get('/api/gladiator/lobby', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    const callerEmail = s?.email ?? null;

    const res = await app.pool.query<{
      session_id: string;
      account_email: string;
      x_handle: string;
      x_avatar_url: string | null;
      bet_base_units: string;
      bankroll_remaining_base_units: string;
      flips_won: number;
      flips_lost: number;
      opened_at: Date;
      last_flip_at: Date | null;
      is_favorite: boolean;
    }>(
      `SELECT
         gs.id AS session_id,
         gs.account_email,
         u.x_handle,
         u.x_avatar_url,
         gs.bet_base_units::text,
         gs.bankroll_remaining_base_units::text,
         gs.flips_won,
         gs.flips_lost,
         gs.opened_at,
         gs.last_flip_at,
         (uf.account_email IS NOT NULL) AS is_favorite
       FROM gladiator_sessions gs
       JOIN users u ON u.email = gs.account_email
       LEFT JOIN user_favorites uf
         ON uf.account_email = $1::text AND uf.favorite_email = gs.account_email
       WHERE gs.status = 'OPEN'
       ORDER BY gs.opened_at DESC`,
      [callerEmail],
    );

    const gladiators = res.rows.map((row) => ({
      session_id: row.session_id,
      account_email: row.account_email,
      x_handle: row.x_handle,
      x_avatar_url: row.x_avatar_url ?? null,
      bet_base_units: row.bet_base_units,
      bankroll_remaining_base_units: row.bankroll_remaining_base_units,
      flips_won: row.flips_won,
      flips_lost: row.flips_lost,
      opened_at: row.opened_at.toISOString(),
      last_flip_at: row.last_flip_at ? row.last_flip_at.toISOString() : null,
      is_favorite: row.is_favorite,
    }));

    return reply.code(200).send({ gladiators });
  });
}
