import type { Pool } from 'pg';
import { publish } from '../hub.js';
import { runHostTurn } from './llm.js';

/** Per-room cool-downs (ms). Tuned so the host is a guide, not a participant.
 *  A warm room gets nudged at most hourly. A cold room gets ~2 posts/day. */
const QUIET_AFTER_MS = 30 * 60 * 1000;        // only post if quiet > 30 min
const HOST_MIN_INTERVAL_MS = 60 * 60 * 1000;  // warm rooms: at most 1 idle/hour
const COLD_HOST_INTERVAL_MS = 12 * 60 * 60 * 1000; // cold rooms: at most 2/day
const RECENT_CONTEXT_LIMIT = 30;

/** Run one sweep across every host-enabled, non-disabled room. Schedules
 *  exactly one LLM call per qualifying room and publishes the reply
 *  through the existing SSE hub. Errors are isolated per room. */
export async function runIdleSweep(pool: Pool, apiKey: string | undefined): Promise<void> {
  if (!apiKey) return;

  const { rows: rooms } = await pool.query<{
    slug: string;
    language: string;
    host_name: string;
    host_persona: string;
  }>(
    `SELECT slug, language, host_name, host_persona
       FROM chat_rooms
       WHERE disabled = false AND host_enabled = true`,
  );

  for (const room of rooms) {
    try {
      await maybeIdleForRoom(pool, apiKey, room);
    } catch (e) {
      // Per-room failure mustn't block other rooms.
      // eslint-disable-next-line no-console
      console.error(`[chat/host/idle] room=${room.slug} error:`, e);
    }
  }
}

async function maybeIdleForRoom(
  pool: Pool,
  apiKey: string,
  room: { slug: string; language: string; host_name: string; host_persona: string },
): Promise<void> {
  // Time of most recent activity (any message, user or host) and most
  // recent host post. Both in epoch ms.
  const { rows } = await pool.query<{
    last_any_ms: string | null;
    last_user_ms: string | null;
    last_host_ms: string | null;
  }>(
    `SELECT
       (SELECT (EXTRACT(EPOCH FROM created_at) * 1000)::text
          FROM chat_room_messages
          WHERE room_slug = $1 AND deleted_at IS NULL
          ORDER BY id DESC LIMIT 1) AS last_any_ms,
       (SELECT (EXTRACT(EPOCH FROM created_at) * 1000)::text
          FROM chat_room_messages
          WHERE room_slug = $1 AND deleted_at IS NULL AND is_host = false
          ORDER BY id DESC LIMIT 1) AS last_user_ms,
       (SELECT (EXTRACT(EPOCH FROM created_at) * 1000)::text
          FROM chat_room_messages
          WHERE room_slug = $1 AND deleted_at IS NULL AND is_host = true
          ORDER BY id DESC LIMIT 1) AS last_host_ms`,
    [room.slug],
  );
  const stat = rows[0]!;
  const now = Date.now();
  const lastAny = stat.last_any_ms ? Number(stat.last_any_ms) : 0;
  const lastUser = stat.last_user_ms ? Number(stat.last_user_ms) : 0;
  const lastHost = stat.last_host_ms ? Number(stat.last_host_ms) : 0;

  // 1) Room must be quiet — no message at all for > QUIET_AFTER_MS.
  if (now - lastAny < QUIET_AFTER_MS) return;

  // 2) Cool-down on host posting. Tighter for "warm" rooms (had user
  //    activity in the last hour), looser for cold rooms.
  const isWarm = now - lastUser < 60 * 60 * 1000;
  const minInterval = isWarm ? HOST_MIN_INTERVAL_MS : COLD_HOST_INTERVAL_MS;
  if (now - lastHost < minInterval) return;

  // Pull recent context.
  const { rows: ctx } = await pool.query<{
    x_handle: string;
    body: string;
    is_host: boolean;
  }>(
    `SELECT x_handle, body, is_host
       FROM chat_room_messages
       WHERE room_slug = $1 AND deleted_at IS NULL
       ORDER BY id DESC
       LIMIT $2`,
    [room.slug, RECENT_CONTEXT_LIMIT],
  );
  const recentMessages = ctx.reverse();

  const reply = await runHostTurn({
    apiKey,
    persona: room.host_persona,
    language: room.language,
    hostName: room.host_name,
    roomSlug: room.slug,
    recentMessages,
    mode: 'idle',
  });
  if (!reply) return;

  const ins = await pool.query<{ id: string; created_at: string }>(
    `INSERT INTO chat_room_messages
       (room_slug, user_email, x_handle, x_avatar_url, body, is_host)
     VALUES ($1, $2, $3, NULL, $4, true)
     RETURNING id::text AS id, created_at::text AS created_at`,
    [room.slug, `__host__:${room.slug}`, room.host_name, reply],
  );
  const row = ins.rows[0];
  if (!row) return;

  publish(`room:${room.slug}`, {
    event: 'room_message',
    id: row.id,
    data: JSON.stringify({
      room: room.slug,
      id: row.id,
      x_handle: room.host_name,
      avatar: null,
      body: reply,
      at: row.created_at,
      is_host: true,
    }),
  });
}
