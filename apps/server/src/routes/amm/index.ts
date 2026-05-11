import type { FastifyInstance } from 'fastify';
import { termsRoutes } from './terms.js';
import { adminRoutes } from './admin.js';

export async function ammRoutes(app: FastifyInstance) {
  await termsRoutes(app);
  await adminRoutes(app);
}
