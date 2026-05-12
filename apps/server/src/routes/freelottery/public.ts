import type { FastifyInstance } from 'fastify';

export async function publicRoutes(app: FastifyInstance) {
  app.get('/api/freelottery/today', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });

  app.get('/api/freelottery/winners', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });
}
