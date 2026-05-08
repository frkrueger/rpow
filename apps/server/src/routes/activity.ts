import type { FastifyInstance } from 'fastify';
import { readSession } from './auth.js';

export async function activityRoutes(app: FastifyInstance) {
  app.get('/activity', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    // amount/value columns are BIGINT base units; cast to text so node-postgres
     // returns them as strings (not implicit JS numbers) and surface as
     // amount_base_units in the response.
    const sql = `
      SELECT 'mint' AS type, value::text AS amount, NULL::text AS counterparty_email, issued_at AS at
      FROM tokens WHERE owner_email=$1 AND parent_token_id IS NULL
      UNION ALL
      SELECT 'send' AS type, amount::text AS amount, recipient_email AS counterparty_email, created_at AS at
      FROM transfers WHERE sender_email=$1
      UNION ALL
      SELECT 'receive' AS type, amount::text AS amount, sender_email AS counterparty_email, created_at AS at
      FROM transfers WHERE recipient_email=$1
      ORDER BY at DESC LIMIT 100`;
    const { rows } = await app.pool.query(sql, [s.email]);
    return rows.map(r => ({
      type: r.type,
      amount_base_units: r.amount,
      counterparty_email: r.counterparty_email ?? undefined,
      at: r.at.toISOString(),
    }));
  });
}
