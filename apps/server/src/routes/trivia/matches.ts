import type { FastifyInstance } from 'fastify';

const NOT_IMPLEMENTED = { error: 'NOT_IMPLEMENTED', message: 'trivia slice 1' };

export async function matchesRoutes(app: FastifyInstance) {
  app.post('/api/trivia/matches/start', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
  app.get('/api/trivia/matches/active', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
  app.get('/api/trivia/matches/recent', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
  app.get('/api/trivia/matches/history', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
  app.post('/api/trivia/matches/:id/answer', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
  // Note: register the parameterized GET LAST so the string-literal routes
  // (start/active/recent/history) match before this catch-all does.
  app.get('/api/trivia/matches/:id', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
}
