import type { FastifyInstance } from 'fastify';
import { randomUUID, randomBytes } from 'node:crypto';
import { readSession } from './auth.js';

export async function challengeRoutes(app: FastifyInstance) {
  app.post('/challenge', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const id = randomUUID();
    const noncePrefix = randomBytes(16);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const difficulty = Math.max(app.config.difficultyFloor, app.config.difficultyBits);
    await app.pool.query(
      'INSERT INTO challenges(id, user_email, nonce_prefix, difficulty_bits, expires_at) VALUES($1,$2,$3,$4,$5)',
      [id, s.email, noncePrefix, difficulty, expiresAt],
    );
    return {
      challenge_id: id,
      nonce_prefix: noncePrefix.toString('hex'),
      difficulty_bits: difficulty,
      expires_at: expiresAt.toISOString(),
    };
  });
}
