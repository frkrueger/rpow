import type { FastifyInstance } from 'fastify';
import { readSession } from './auth.js';

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const email = s.email;
    const [
      { rows: bal },
      { rows: minted },
      { rows: sent },
      { rows: recv },
      { rows: userRow },
      { rows: wrappedRow },
    ] = await Promise.all([
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM tokens WHERE owner_email=$1 AND state='VALID'`,
        [email],
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM tokens WHERE owner_email=$1 AND parent_token_id IS NULL`,
        [email],
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(amount),0)::text AS n FROM transfers WHERE sender_email=$1`,
        [email],
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(amount),0)::text AS n FROM transfers WHERE recipient_email=$1`,
        [email],
      ),
      app.pool.query<{ solana_wallet: string | null }>(
        'SELECT solana_wallet FROM users WHERE email=$1', [email],
      ),
      app.pool.query<{ n: string }>(
        `SELECT coalesce(sum(value),0)::text AS n FROM tokens WHERE owner_email=$1 AND state='WRAPPED'`,
        [email],
      ),
    ]);
    return {
      email,
      balance_base_units: bal[0]!.n,
      minted_base_units: minted[0]!.n,
      sent_base_units: sent[0]!.n,
      received_base_units: recv[0]!.n,
      wrap_allowed: app.wrapAllowlist.has(email.toLowerCase()),
      solana_wallet: userRow[0]?.solana_wallet ?? null,
      srpow_supply_owned_base_units: wrappedRow[0]?.n ?? '0',
    };
  });
}
