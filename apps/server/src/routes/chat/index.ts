import type { FastifyInstance } from 'fastify';
import { roomsRoutes } from './rooms.js';
import { messagesRoutes } from './messages.js';
import { streamRoutes } from './stream.js';

export async function chatRoutes(app: FastifyInstance) {
  await roomsRoutes(app);
  await messagesRoutes(app);
  await streamRoutes(app);
}
