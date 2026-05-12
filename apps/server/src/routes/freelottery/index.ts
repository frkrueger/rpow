import type { FastifyInstance } from 'fastify';
import { entryRoutes } from './entry.js';
import { publicRoutes } from './public.js';
import { statusRoutes } from './status.js';

export async function freelotteryRoutes(app: FastifyInstance) {
  await entryRoutes(app);
  await publicRoutes(app);
  await statusRoutes(app);
}
