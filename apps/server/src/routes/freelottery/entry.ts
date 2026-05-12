import type { FastifyInstance } from 'fastify';

export async function entryRoutes(app: FastifyInstance) {
  app.post('/api/freelottery/entry/start', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });

  app.post('/api/freelottery/entry/verify', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });
}
