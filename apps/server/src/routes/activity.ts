import type { FastifyInstance } from 'fastify';
import { readAuth } from './auth.js';

const SINCE_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

interface Row {
  type: string;
  amount: string;
  counterparty_email: string | null;
  at: Date;
}

function rowToEntry(r: Row) {
  return {
    type: r.type,
    amount_base_units: r.amount,
    counterparty_email: r.counterparty_email ?? undefined,
    at: r.at.toISOString(),
  };
}

export async function activityRoutes(app: FastifyInstance) {
  app.get('/activity', async (req, reply) => {
    const s = await readAuth(req, app);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const since = (req.query as Record<string, string | undefined>).since;

    if (since !== undefined) {
      const sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid since (expect iso8601)' });
      }
      // ASC order, capped, filter at > since.
      // amount/value columns are BIGINT base units; cast to text for string return.
      const sql = `
        SELECT 'mint' AS type, value::text AS amount, NULL::text AS counterparty_email, issued_at AS at
        FROM tokens WHERE owner_email=$1 AND parent_token_id IS NULL AND issued_at > $2
        UNION ALL
        SELECT 'send' AS type, amount::text AS amount, recipient_email AS counterparty_email, created_at AS at
        FROM transfers WHERE sender_email=$1 AND created_at > $2
        UNION ALL
        SELECT 'receive' AS type, amount::text AS amount, sender_email AS counterparty_email, created_at AS at
        FROM transfers WHERE recipient_email=$1 AND created_at > $2
        ORDER BY at ASC LIMIT ${SINCE_LIMIT}`;
      const { rows } = await app.pool.query<Row>(sql, [s.email, sinceDate]);
      const entries = rows.map(rowToEntry);
      const next_cursor = entries.length > 0 ? entries[entries.length - 1].at : null;
      return { entries, next_cursor };
    }

    // Existing behavior: bare array, DESC, latest 100
    const sql = `
      SELECT 'mint' AS type, value::text AS amount, NULL::text AS counterparty_email, issued_at AS at
      FROM tokens WHERE owner_email=$1 AND parent_token_id IS NULL
      UNION ALL
      SELECT 'send' AS type, amount::text AS amount, recipient_email AS counterparty_email, created_at AS at
      FROM transfers WHERE sender_email=$1
      UNION ALL
      SELECT 'receive' AS type, amount::text AS amount, sender_email AS counterparty_email, created_at AS at
      FROM transfers WHERE recipient_email=$1
      ORDER BY at DESC LIMIT ${DEFAULT_LIMIT}`;
    const { rows } = await app.pool.query<Row>(sql, [s.email]);
    return rows.map(rowToEntry);
  });
}
