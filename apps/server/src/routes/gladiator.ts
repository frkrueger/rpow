import type { FastifyInstance } from 'fastify';

const NOT_IMPLEMENTED = { error: 'NOT_IMPLEMENTED', message: 'gladiator slice 1' };

export async function gladiatorRoutes(app: FastifyInstance) {
  // X handle verification
  app.post('/api/gladiator/x-handle/start', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.post('/api/gladiator/x-handle/verify', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  // Profile
  app.get('/api/gladiator/me', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  // Sessions
  app.post('/api/gladiator/sessions', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.post('/api/gladiator/sessions/:id/close', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  // Lobby (public)
  app.get('/api/gladiator/lobby', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  // Flips
  app.post('/api/gladiator/flip', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.get('/api/gladiator/flips/recent', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.get('/api/gladiator/flips/history', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  // Chat
  app.get('/api/gladiator/chat', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.post('/api/gladiator/chat', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  // Admin
  app.post('/api/gladiator/admin/verify-handle', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
}
