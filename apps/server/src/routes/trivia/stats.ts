import type { FastifyInstance } from 'fastify';

const NOT_IMPLEMENTED = { error: 'NOT_IMPLEMENTED', message: 'trivia slice 1' };

export async function statsRoutes(app: FastifyInstance) {
  app.get('/api/trivia/stats', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
}
