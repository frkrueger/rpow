import type { FastifyInstance } from 'fastify';
import { roomsRoutes } from './rooms.js';

export async function chatRoutes(app: FastifyInstance) {
  await roomsRoutes(app);
}
