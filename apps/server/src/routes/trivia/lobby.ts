import type { FastifyInstance } from 'fastify';

export async function lobbyRoutes(app: FastifyInstance) {
  app.get('/api/trivia/lobby', async (_req, reply) => {
    const res = await app.pool.query<{
      session_id: string;
      account_email: string;
      x_handle: string;
      x_avatar_url: string | null;
      bet_base_units: string;
      bankroll_remaining_base_units: string;
      matches_won: number;
      matches_lost: number;
      opened_at: Date;
      last_match_at: Date | null;
    }>(
      `SELECT
         ts.id AS session_id,
         ts.account_email,
         u.x_handle,
         u.x_avatar_url,
         ts.bet_base_units::text,
         ts.bankroll_remaining_base_units::text,
         ts.matches_won,
         ts.matches_lost,
         ts.opened_at,
         ts.last_match_at
       FROM trivia_sessions ts
       JOIN users u ON u.email = ts.account_email
       WHERE ts.status = 'OPEN'
       ORDER BY ts.opened_at DESC`,
    );

    const players = res.rows.map((row) => ({
      session_id: row.session_id,
      account_email: row.account_email,
      x_handle: row.x_handle,
      x_avatar_url: row.x_avatar_url ?? null,
      bet_base_units: row.bet_base_units,
      bankroll_remaining_base_units: row.bankroll_remaining_base_units,
      matches_won: row.matches_won,
      matches_lost: row.matches_lost,
      opened_at: row.opened_at.toISOString(),
      last_match_at: row.last_match_at ? row.last_match_at.toISOString() : null,
    }));

    return reply.code(200).send({ players });
  });
}
