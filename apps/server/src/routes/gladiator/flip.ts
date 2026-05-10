import type { FastifyInstance } from 'fastify';

const NOT_IMPLEMENTED = { error: 'NOT_IMPLEMENTED', message: 'gladiator slice 1' };

export async function flipRoutes(app: FastifyInstance) {
  app.post('/api/gladiator/flip', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.get('/api/gladiator/flips/recent', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.get('/api/gladiator/flips/history', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
}
