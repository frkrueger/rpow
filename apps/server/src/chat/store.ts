import type { Pool } from 'pg';

export interface ChatMessage {
  id: string;                  // BIGSERIAL serialized as string for safe transit
  roomSlug: string;
  xHandle: string;
  xAvatarUrl: string | null;
  body: string;
  createdAt: string;           // ISO timestamp
  deletedAt: string | null;
  isHost: boolean;             // true for AI host posts; UI renders distinctively
}

export interface ChatRoom {
  slug: string;
  title: string;
  description: string;
  category: string;
  sortOrder: number;
  language: string;
  hostName: string;
  hostAvatarUrl: string | null;
}

/** Returns enabled rooms grouped by category, ascending by sort_order within
 *  category (then by slug as a tiebreaker). Disabled rooms are filtered out
 *  at query time — public callers should never see them. `host_persona` is
 *  intentionally NOT returned; it's an internal system-prompt blurb. */
export async function listRooms(pool: Pool): Promise<ChatRoom[]> {
  const { rows } = await pool.query<{
    slug: string;
    title: string;
    description: string;
    category: string;
    sort_order: number;
    language: string;
    host_name: string;
    host_avatar_url: string | null;
  }>(
    `SELECT slug, title, description, category, sort_order, language, host_name, host_avatar_url
     FROM chat_rooms
     WHERE disabled = false
     ORDER BY category ASC, sort_order ASC, slug ASC`,
  );
  return rows.map(r => ({
    slug: r.slug,
    title: r.title,
    description: r.description,
    category: r.category,
    sortOrder: r.sort_order,
    language: r.language,
    hostName: r.host_name,
    hostAvatarUrl: r.host_avatar_url,
  }));
}

/** Returns null if the slug is unknown or the room is disabled. Callers
 *  should treat null as 404 + a system event for any subscribed client. */
export async function getRoomLanguage(pool: Pool, slug: string): Promise<string | null> {
  const { rows } = await pool.query<{ language: string }>(
    `SELECT language FROM chat_rooms WHERE slug = $1 AND disabled = false`,
    [slug],
  );
  return rows[0]?.language ?? null;
}

/** Insert a new room message authored by `userEmail`. Snapshots the user's
 *  current x_handle + x_avatar_url at write time so the row is self-contained
 *  even if the user later changes their handle. */
export async function insertMessage(
  pool: Pool,
  args: { roomSlug: string; userEmail: string; body: string },
): Promise<ChatMessage> {
  const { rows } = await pool.query<{
    id: string;
    room_slug: string;
    x_handle: string;
    x_avatar_url: string | null;
    body: string;
    created_at: string;
    deleted_at: string | null;
    is_host: boolean;
  }>(
    `WITH author AS (
       SELECT x_handle, x_avatar_url FROM users WHERE email = $1
     )
     INSERT INTO chat_room_messages
       (room_slug, user_email, x_handle, x_avatar_url, body)
     SELECT $2, $1, author.x_handle, author.x_avatar_url, $3
     FROM author
     WHERE author.x_handle IS NOT NULL
     RETURNING
       id::text AS id,
       room_slug,
       x_handle,
       x_avatar_url,
       body,
       created_at::text AS created_at,
       deleted_at::text AS deleted_at,
       is_host`,
    [args.userEmail, args.roomSlug, args.body],
  );
  const r = rows[0];
  if (!r) {
    // Either user doesn't exist or x_handle is null. Both are auth failures
    // the route layer should have caught — surface clearly.
    throw new Error('insertMessage: user has no verified x_handle');
  }
  return {
    id: r.id,
    roomSlug: r.room_slug,
    xHandle: r.x_handle,
    xAvatarUrl: r.x_avatar_url,
    body: r.body,
    createdAt: r.created_at,
    deletedAt: r.deleted_at,
    isHost: false,
  };
}

/** Returns the last N non-deleted messages for a room, oldest first. */
export async function listMessages(
  pool: Pool,
  args: { roomSlug: string; limit: number; before?: string },
): Promise<ChatMessage[]> {
  const limit = Math.min(Math.max(args.limit, 1), 200);
  const params: Array<string | number> = [args.roomSlug, limit];
  let cursor = '';
  if (args.before) {
    params.push(args.before);
    cursor = ` AND id < $3`;
  }
  const { rows } = await pool.query<{
    id: string;
    room_slug: string;
    x_handle: string;
    x_avatar_url: string | null;
    body: string;
    created_at: string;
    deleted_at: string | null;
    is_host: boolean;
  }>(
    `SELECT
       id::text AS id,
       room_slug,
       x_handle,
       x_avatar_url,
       body,
       created_at::text AS created_at,
       deleted_at::text AS deleted_at,
       is_host
     FROM chat_room_messages
     WHERE room_slug = $1 AND deleted_at IS NULL${cursor}
     ORDER BY id DESC
     LIMIT $2`,
    params,
  );
  // Server query is DESC for "newest N"; return oldest-first for natural
  // top-down rendering.
  return rows.reverse().map(r => ({
    id: r.id,
    roomSlug: r.room_slug,
    xHandle: r.x_handle,
    xAvatarUrl: r.x_avatar_url,
    body: r.body,
    createdAt: r.created_at,
    deletedAt: r.deleted_at,
    isHost: r.is_host,
  }));
}

/** Soft-delete (set deleted_at) the message if the caller is the author.
 *  Returns the message id when a row was actually affected, else null. */
export async function deleteOwnMessage(
  pool: Pool,
  args: { messageId: string; userEmail: string },
): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE chat_room_messages
       SET deleted_at = now()
     WHERE id = $1 AND user_email = $2 AND deleted_at IS NULL
     RETURNING id::text AS id`,
    [args.messageId, args.userEmail],
  );
  return rows[0]?.id ?? null;
}

/** Returns the message's room_slug, plus the author check the caller needs.
 *  Used by the DELETE route to figure out which room to fan the delete to. */
export async function getMessageMeta(
  pool: Pool,
  messageId: string,
): Promise<{ roomSlug: string; userEmail: string } | null> {
  const { rows } = await pool.query<{ room_slug: string; user_email: string }>(
    `SELECT room_slug, user_email FROM chat_room_messages WHERE id = $1`,
    [messageId],
  );
  const r = rows[0];
  return r ? { roomSlug: r.room_slug, userEmail: r.user_email } : null;
}
