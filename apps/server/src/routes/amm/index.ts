import type { FastifyInstance } from 'fastify';
import { termsRoutes } from './terms.js';
import { adminRoutes } from './admin.js';
import { seedRoutes } from './seed.js';
import { poolReadRoutes } from './pool.js';

export async function ammRoutes(app: FastifyInstance) {
  await termsRoutes(app);
  await adminRoutes(app);
  await seedRoutes(app);
  await poolReadRoutes(app);
}
