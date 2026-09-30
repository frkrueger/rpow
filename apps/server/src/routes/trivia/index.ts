import type { FastifyInstance } from 'fastify';
import { sessionsRoutes } from './sessions.js';
import { matchesRoutes } from './matches.js';
import { lobbyRoutes } from './lobby.js';
import { chatRoutes } from './chat.js';
import { statsRoutes } from './stats.js';
import { meRoutes } from './me.js';

export async function triviaRoutes(app: FastifyInstance) {
  await meRoutes(app);
  await sessionsRoutes(app);
  await matchesRoutes(app);
  await lobbyRoutes(app);
  await chatRoutes(app);
  await statsRoutes(app);
}
