import type { FastifyInstance } from 'fastify';

export async function statsRoutes(app: FastifyInstance) {
  app.get('/api/trivia/stats', async () => {
    const [matches, verified, open] = await Promise.all([
      app.pool.query<{ total_matches: string; total_volume: string }>(
        `SELECT
           COUNT(*)::text AS total_matches,
           COALESCE(SUM(bet_base_units * 2), 0)::text AS total_volume
         FROM trivia_matches
         WHERE state = 'RESOLVED'`,
      ),
      app.pool.query<{ total_verified_users: string }>(
        `SELECT COUNT(*)::text AS total_verified_users
         FROM users
         WHERE x_handle IS NOT NULL`,
      ),
      app.pool.query<{ open_arena_count: string }>(
        `SELECT COUNT(*)::text AS open_arena_count
         FROM trivia_sessions
         WHERE status = 'OPEN'`,
      ),
    ]);

    return {
      total_matches: parseInt(matches.rows[0].total_matches, 10),
      total_volume_base_units: matches.rows[0].total_volume,
      total_verified_users: parseInt(verified.rows[0].total_verified_users, 10),
      open_arena_count: parseInt(open.rows[0].open_arena_count, 10),
    };
  });
}
