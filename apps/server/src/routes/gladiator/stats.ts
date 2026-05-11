import type { FastifyInstance } from 'fastify';

export async function statsRoutes(app: FastifyInstance) {
  app.get('/api/gladiator/stats', async (_req, reply) => {
    const [{ rows: flipRows }, { rows: userRows }, { rows: openRows }] = await Promise.all([
      app.pool.query<{ total_flips: string; total_volume_base_units: string }>(
        // total_volume = sum of bet × 2 (winner takes both sides) across every flip ever.
        `SELECT
           COUNT(*)::text AS total_flips,
           COALESCE(SUM(bet_base_units * 2), 0)::text AS total_volume_base_units
         FROM gladiator_flips`,
      ),
      app.pool.query<{ total_verified_users: string }>(
        `SELECT COUNT(*)::text AS total_verified_users
         FROM users
         WHERE x_handle IS NOT NULL`,
      ),
      app.pool.query<{ open_gladiators: string }>(
        `SELECT COUNT(*)::text AS open_gladiators
         FROM gladiator_sessions
         WHERE status = 'OPEN'`,
      ),
    ]);

    return reply.code(200).send({
      total_flips: parseInt(flipRows[0]?.total_flips ?? '0', 10),
      total_volume_base_units: flipRows[0]?.total_volume_base_units ?? '0',
      total_verified_users: parseInt(userRows[0]?.total_verified_users ?? '0', 10),
      open_gladiators: parseInt(openRows[0]?.open_gladiators ?? '0', 10),
    });
  });
}
