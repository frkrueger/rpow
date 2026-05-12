import type { FastifyInstance } from 'fastify';
import { readSession } from '../auth.js';
import { isAllowed, readTermsAcceptedAt } from './allowlist.js';

async function gate(app: FastifyInstance, req: any, reply: any): Promise<string | null> {
  const s = readSession(req, app.config.sessionSecret);
  if (!s) { reply.code(401).send({ error: 'UNAUTHORIZED' }); return null; }
  if (!isAllowed(app.config.ammAllowedEmails, s.email)) {
    reply.code(403).send({ error: 'NOT_ALLOWED' }); return null;
  }
  if (!(await readTermsAcceptedAt(app, s.email))) {
    reply.code(403).send({ error: 'TERMS_NOT_ACCEPTED' }); return null;
  }
  return s.email;
}

export async function walletRoutes(app: FastifyInstance) {
  app.get('/amm/wallet/status', async (req, reply) => {
    const email = await gate(app, req, reply); if (!email) return;
    const r = await app.pool.query<{ solana_pubkey: string | null }>(
      `SELECT solana_pubkey FROM users WHERE email = $1`,
      [email],
    );
    reply.code(200).send({ linked_pubkey: r.rows[0]?.solana_pubkey ?? null });
  });

  app.post('/amm/wallet/unlink', async (req, reply) => {
    const email = await gate(app, req, reply); if (!email) return;
    const prior = await app.pool.query<{ solana_pubkey: string | null }>(
      `SELECT solana_pubkey FROM users WHERE email = $1`,
      [email],
    );
    const priorPk = prior.rows[0]?.solana_pubkey ?? null;
    await app.pool.query(`UPDATE users SET solana_pubkey = NULL WHERE email = $1`, [email]);
    reply.code(200).send({ unlinked_pubkey: priorPk });
  });
}
