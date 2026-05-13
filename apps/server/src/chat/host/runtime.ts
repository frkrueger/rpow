import type { Pool } from 'pg';
import { publish } from '../hub.js';
import { mentionsHost } from './detect.js';
import { runHostTurn } from './llm.js';

const RECENT_MESSAGES_LIMIT = 30;
// Hard cap how often a single host can post in a room — even if many users
// @-mention it back-to-back, the host stays at most one post every 5 minutes.
// Keeps the host from dominating a busy room.
const HOST_MIN_INTERVAL_MS = 5 * 60_000;
const lastPostAt = new Map<string, number>();

/** Called from the POST handler after a user message is persisted. If the
 *  message @-mentions the room's host and we have an API key, the host
 *  computes a reply, persists it, and fans out via the existing SSE hub.
 *
 *  Runs asynchronously — the POST returns 201 immediately. Errors are
 *  swallowed (logged) so a host outage never blocks user posting. */
export async function maybeRunHost(args: {
  pool: Pool;
  apiKey: string | undefined;
  roomSlug: string;
  triggerMessageBody: string;
  triggerXHandle: string;
}): Promise<void> {
  if (!args.apiKey) return;

  const { rows } = await args.pool.query<{
    host_name: string;
    host_persona: string;
    host_enabled: boolean;
    language: string;
  }>(
    `SELECT host_name, host_persona, host_enabled, language
       FROM chat_rooms
       WHERE slug = $1 AND disabled = false`,
    [args.roomSlug],
  );
  const room = rows[0];
  if (!room) return;
  if (!room.host_enabled) return;
  if (!mentionsHost(args.triggerMessageBody, room.host_name, args.roomSlug)) return;

  const now = Date.now();
  const last = lastPostAt.get(args.roomSlug) ?? 0;
  if (now - last < HOST_MIN_INTERVAL_MS) return;
  lastPostAt.set(args.roomSlug, now);

  // Pull recent context (last N non-deleted messages, oldest first).
  const { rows: ctx } = await args.pool.query<{
    x_handle: string;
    body: string;
    is_host: boolean;
  }>(
    `SELECT x_handle, body, is_host
       FROM chat_room_messages
       WHERE room_slug = $1 AND deleted_at IS NULL
       ORDER BY id DESC
       LIMIT $2`,
    [args.roomSlug, RECENT_MESSAGES_LIMIT],
  );
  const recentMessages = ctx.reverse();

  const reply = await runHostTurn({
    apiKey: args.apiKey,
    persona: room.host_persona,
    language: room.language,
    hostName: room.host_name,
    roomSlug: args.roomSlug,
    recentMessages,
    mode: 'reply',
  });
  if (!reply) return;

  // Persist as a host-authored message. user_email is the seeded system
  // sentinel '__host__:<slug>' so the FK is satisfied; is_host=true so the
  // frontend renders the row distinctively.
  const ins = await args.pool.query<{
    id: string;
    created_at: string;
  }>(
    `INSERT INTO chat_room_messages
       (room_slug, user_email, x_handle, x_avatar_url, body, is_host)
     VALUES ($1, $2, $3, NULL, $4, true)
     RETURNING id::text AS id, created_at::text AS created_at`,
    [args.roomSlug, `__host__:${args.roomSlug}`, room.host_name, reply],
  );
  const row = ins.rows[0];
  if (!row) return;

  publish(`room:${args.roomSlug}`, {
    event: 'room_message',
    id: row.id,
    data: JSON.stringify({
      room: args.roomSlug,
      id: row.id,
      x_handle: room.host_name,
      avatar: null,
      body: reply,
      at: row.created_at,
      is_host: true,
    }),
  });
}
