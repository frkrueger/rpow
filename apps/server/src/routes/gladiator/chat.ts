import type { FastifyInstance } from 'fastify';

const NOT_IMPLEMENTED = { error: 'NOT_IMPLEMENTED', message: 'gladiator slice 1' };

export async function chatRoutes(app: FastifyInstance) {
  app.get('/api/gladiator/chat', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.post('/api/gladiator/chat', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
}
