import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readSession } from '../auth.js';
import {
  deleteOwnMessage,
  getMessageMeta,
  getRoomLanguage,
  insertMessage,
  listMessages,
} from '../../chat/store.js';
import { publish } from '../../chat/hub.js';
import { allowPost } from '../../chat/rateLimit.js';

const MAX_BODY = 2000;
const MIN_BODY = 1;

const postBodySchema = z.object({
  room: z.string().min(1).max(40),
  body: z.string().min(MIN_BODY).max(MAX_BODY),
});

interface UserAuthRow {
  email: string;
  x_handle: string | null;
  banned: boolean;
}

/** Resolve the caller from the rpow_session cookie, then load their x_handle
 *  + ban state in one query. Returns null when the request is anonymous; the
 *  caller decides whether that's allowed. */
async function loadCaller(app: FastifyInstance, req: { cookies: Record<string, string | undefined>; headers?: { cookie?: string | string[] } }): Promise<UserAuthRow | null> {
  const session = readSession(req, app.config.sessionSecret);
  if (!session) return null;
  const { rows } = await app.pool.query<{ x_handle: string | null; banned: boolean }>(
    `SELECT u.x_handle,
            (SELECT count(*) FROM chat_bans b WHERE b.user_email = u.email) > 0 AS banned
       FROM users u
       WHERE u.email = $1`,
    [session.email],
  );
  if (!rows[0]) return null;
  return { email: session.email, x_handle: rows[0].x_handle, banned: rows[0].banned };
}

export async function messagesRoutes(app: FastifyInstance) {
  // ---- POST /api/chat/messages -----------------------------------------
  app.post('/api/chat/messages', async (req, reply) => {
    const parsed = postBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: parsed.error.message });
    }
    const { room, body } = parsed.data;

    const caller = await loadCaller(app, req);
    if (!caller) return reply.code(401).send({ error: 'NOT_SIGNED_IN' });
    if (!caller.x_handle) return reply.code(412).send({ error: 'BIND_REQUIRED' });
    if (caller.banned) return reply.code(403).send({ error: 'BANNED' });

    const lang = await getRoomLanguage(app.pool, room);
    if (lang === null) return reply.code(404).send({ error: 'ROOM_NOT_FOUND' });

    const gate = allowPost(caller.email);
    if (!gate.ok) {
      reply.header('retry-after', Math.ceil(gate.retryAfterMs / 1000));
      return reply.code(429).send({ error: 'RATE_LIMITED', retry_after_ms: gate.retryAfterMs });
    }

    const msg = await insertMessage(app.pool, { roomSlug: room, userEmail: caller.email, body });

    // Fan out to live subscribers. Block-list filtering happens in the
    // stream handler (per-recipient), so we publish the raw event here.
    publish(`room:${room}`, {
      event: 'room_message',
      id: msg.id,
      data: JSON.stringify({
        room: msg.roomSlug,
        id: msg.id,
        x_handle: msg.xHandle,
        avatar: msg.xAvatarUrl,
        body: msg.body,
        at: msg.createdAt,
      }),
    });

    return reply.code(201).send({
      id: msg.id,
      room: msg.roomSlug,
      x_handle: msg.xHandle,
      avatar: msg.xAvatarUrl,
      body: msg.body,
      at: msg.createdAt,
    });
  });

  // ---- DELETE /api/chat/messages/:id -----------------------------------
  app.delete<{ Params: { id: string } }>('/api/chat/messages/:id', async (req, reply) => {
    const caller = await loadCaller(app, req);
    if (!caller) return reply.code(401).send({ error: 'NOT_SIGNED_IN' });

    const meta = await getMessageMeta(app.pool, req.params.id);
    if (!meta) return reply.code(404).send({ error: 'MESSAGE_NOT_FOUND' });
    if (meta.userEmail !== caller.email) return reply.code(403).send({ error: 'FORBIDDEN' });

    const id = await deleteOwnMessage(app.pool, { messageId: req.params.id, userEmail: caller.email });
    if (!id) return reply.code(404).send({ error: 'ALREADY_DELETED' });

    publish(`room:${meta.roomSlug}`, {
      event: 'room_message_deleted',
      id: `del:${id}`,
      data: JSON.stringify({ room: meta.roomSlug, id }),
    });

    return reply.code(204).send();
  });

  // ---- GET /api/chat/rooms/:slug/messages -------------------------------
  app.get<{
    Params: { slug: string };
    Querystring: { limit?: string; before?: string };
  }>('/api/chat/rooms/:slug/messages', async (req, reply) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    if (Number.isNaN(limit) || limit < 1) {
      return reply.code(400).send({ error: 'BAD_LIMIT' });
    }
    const lang = await getRoomLanguage(app.pool, req.params.slug);
    if (lang === null) return reply.code(404).send({ error: 'ROOM_NOT_FOUND' });

    const messages = await listMessages(app.pool, {
      roomSlug: req.params.slug,
      limit,
      before: req.query.before,
    });
    return { messages };
  });
}
