import type { FastifyInstance } from 'fastify';

const NOT_IMPLEMENTED = { error: 'NOT_IMPLEMENTED', message: 'trivia slice 1' };

export async function chatRoutes(app: FastifyInstance) {
  app.get('/api/trivia/chat', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
  app.post('/api/trivia/chat', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
}
