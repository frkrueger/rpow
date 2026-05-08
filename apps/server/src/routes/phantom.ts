import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readSession } from './auth.js';

const NONCE_TTL_MS = 5 * 60 * 1000;

export async function phantomRoutes(app: FastifyInstance) {
  app.post('/phantom/challenge', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const nonce = randomUUID();
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
    await app.pool.query(
      'INSERT INTO phantom_challenges(nonce, user_email, expires_at) VALUES($1,$2,$3)',
      [nonce, s.email, expiresAt],
    );
    return { nonce, message: `rpow2.com bind: ${nonce}`, expires_at: expiresAt.toISOString() };
  });
}
