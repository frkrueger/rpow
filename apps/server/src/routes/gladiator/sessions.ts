import type { FastifyInstance } from 'fastify';

const NOT_IMPLEMENTED = { error: 'NOT_IMPLEMENTED', message: 'gladiator slice 1' };

export async function sessionsRoutes(app: FastifyInstance) {
  app.post('/api/gladiator/sessions', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.post('/api/gladiator/sessions/:id/close', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
}
