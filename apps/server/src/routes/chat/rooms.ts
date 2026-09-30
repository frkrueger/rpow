import type { FastifyInstance } from 'fastify';
import { listRooms } from '../../chat/store.js';

export async function roomsRoutes(app: FastifyInstance) {
  app.get('/api/chat/rooms', async () => {
    const rooms = await listRooms(app.pool);
    return { rooms };
  });
}
