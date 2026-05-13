import type { Pool } from 'pg';

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
