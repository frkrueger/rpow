import type { FastifyInstance } from 'fastify';

const NOT_IMPLEMENTED = { error: 'NOT_IMPLEMENTED', message: 'trivia slice 1' };

export async function meRoutes(app: FastifyInstance) {
  app.get('/api/trivia/me', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
}
