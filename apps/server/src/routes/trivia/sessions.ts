import type { FastifyInstance } from 'fastify';

const NOT_IMPLEMENTED = { error: 'NOT_IMPLEMENTED', message: 'trivia slice 1' };

export async function sessionsRoutes(app: FastifyInstance) {
  app.post('/api/trivia/sessions', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
  app.post('/api/trivia/sessions/:id/close', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
}
