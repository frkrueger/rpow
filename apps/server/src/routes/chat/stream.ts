import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { subscribe } from '../../chat/hub.js';
import { listMessages, getRoomLanguage } from '../../chat/store.js';

const HEARTBEAT_INTERVAL_MS = 25_000;
// Cap how many rooms a single SSE stream can subscribe to so a misbehaving
// client can't pin our event listeners across the entire directory.
const MAX_ROOMS_PER_STREAM = 12;
// Cap how many missed messages we'll replay on reconnect. Anything beyond
// this and the client should just fetch /messages and snap to live.
const MAX_RESUME_REPLAY = 100;

export async function streamRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { rooms?: string };
  }>('/api/chat/stream', async (req: FastifyRequest, reply: FastifyReply) => {
    const roomsParam = (req.query as { rooms?: string }).rooms ?? '';
    const requested = roomsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (requested.length === 0) {
      return reply.code(400).send({ error: 'NO_ROOMS' });
    }
    if (requested.length > MAX_ROOMS_PER_STREAM) {
      return reply.code(400).send({ error: 'TOO_MANY_ROOMS', limit: MAX_ROOMS_PER_STREAM });
    }

    // Validate every requested slug exists + isn't disabled.
    const valid: string[] = [];
    for (const slug of requested) {
      const lang = await getRoomLanguage(app.pool, slug);
      if (lang !== null) valid.push(slug);
    }
    if (valid.length === 0) {
      return reply.code(404).send({ error: 'NO_VALID_ROOMS' });
    }

    // SSE headers. `no-transform` discourages CDNs from buffering.
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Flush the initial response so the browser EventSource fires `open`.
    reply.raw.write(': hi\n\n');

    // Resume: replay messages newer than the Last-Event-Id the client sent
    // (the browser auto-attaches it on reconnect). Cap replay size — clients
    // far behind should hit /messages and snap to live.
    const lastEventIdHeader = req.headers['last-event-id'];
    const lastId =
      typeof lastEventIdHeader === 'string' && /^\d+$/.test(lastEventIdHeader)
        ? lastEventIdHeader
        : null;
    if (lastId) {
      for (const slug of valid) {
        const replays = await listMessages(app.pool, {
          roomSlug: slug,
          limit: MAX_RESUME_REPLAY,
          // listMessages takes a `before` cursor (older than). We want NEWER
          // than lastId — easiest path is fetch the last N, then filter.
        });
        for (const m of replays) {
          if (BigInt(m.id) <= BigInt(lastId)) continue;
          writeSseEvent(reply, {
            event: 'room_message',
            id: m.id,
            data: JSON.stringify({
              room: m.roomSlug,
              id: m.id,
              x_handle: m.xHandle,
              avatar: m.xAvatarUrl,
              body: m.body,
              at: m.createdAt,
            }),
          });
        }
      }
    }

    // Live subscriptions.
    const unsubscribers = valid.map(slug =>
      subscribe(`room:${slug}`, evt => writeSseEvent(reply, evt)),
    );

    // Heartbeat. Prevents idle-disconnect at edge proxies + Cloudflare.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': heartbeat\n\n');
      } catch {
        // Connection already torn down; cleanup handler will fire.
      }
    }, HEARTBEAT_INTERVAL_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      for (const off of unsubscribers) off();
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });
}

function writeSseEvent(reply: FastifyReply, evt: { event: string; id: string; data: string }) {
  try {
    reply.raw.write(`id: ${evt.id}\nevent: ${evt.event}\ndata: ${evt.data}\n\n`);
  } catch {
    // Stream closed mid-write. The req.raw 'close' handler will clean up.
  }
}
