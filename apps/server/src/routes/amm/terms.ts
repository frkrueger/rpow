import type { FastifyInstance } from 'fastify';
import { readSession } from '../auth.js';
import { isAllowed, readTermsAcceptedAt } from './allowlist.js';

export async function termsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------
  // POST /amm/accept-terms
  // Idempotent: sets users.amm_terms_accepted_at = now() the first time;
  // subsequent calls return the existing timestamp untouched.
  // ---------------------------------------------------------------
  app.post('/amm/accept-terms', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    if (!isAllowed(app.config.ammAllowedEmails, s.email)) {
      return reply.code(403).send({ error: 'NOT_ALLOWED', message: 'AMM access not enabled for your account' });
    }

    const existing = await readTermsAcceptedAt(app, s.email);
    if (existing) {
      return reply.code(200).send({ accepted_at: existing.toISOString() });
    }

    const res = await app.pool.query<{ amm_terms_accepted_at: Date }>(
      `UPDATE users
       SET amm_terms_accepted_at = now()
       WHERE email = $1
       RETURNING amm_terms_accepted_at`,
      [s.email],
    );
    if (res.rows.length === 0) {
      // Should never happen — every authed user has a row — but cover it.
      return reply.code(500).send({ error: 'INTERNAL', message: 'user row missing' });
    }
    return reply.code(200).send({ accepted_at: res.rows[0].amm_terms_accepted_at.toISOString() });
  });
}
