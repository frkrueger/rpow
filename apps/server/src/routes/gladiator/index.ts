import type { FastifyInstance } from 'fastify';
import { xHandleRoutes } from './xHandle.js';
import { sessionsRoutes } from './sessions.js';
import { flipRoutes } from './flip.js';
import { lobbyRoutes } from './lobby.js';
import { chatRoutes } from './chat.js';
import { statsRoutes } from './stats.js';

export async function gladiatorRoutes(app: FastifyInstance) {
  await xHandleRoutes(app);
  await sessionsRoutes(app);
  await flipRoutes(app);
  await lobbyRoutes(app);
  await chatRoutes(app);
  await statsRoutes(app);
}
