import { api, type ChatMessage } from './api.js';

/** Module-level scrollback cache shared between RoomView (reads/writes on
 *  mount + live events) and Sidebar (prefetches on hover). Lives for the
 *  page session; dropped on full reload. */
export const scrollbackCache = new Map<string, ChatMessage[]>();

const inflight = new Map<string, Promise<void>>();

/** Fetch the room's scrollback into the cache. No-op if already cached or in
 *  flight. Errors are swallowed (best-effort prefetch). */
export function prefetchScrollback(room: string): void {
  if (scrollbackCache.has(room) || inflight.has(room)) return;
  const p = api.scrollback(room, 50)
    .then(r => {
      const fresh: ChatMessage[] = r.messages.map(m => ({
        id: m.id,
        room: m.roomSlug,
        x_handle: m.xHandle,
        avatar: m.xAvatarUrl,
        body: m.body,
        at: m.createdAt,
        is_host: m.isHost,
      }));
      scrollbackCache.set(room, fresh);
    })
    .catch(() => { /* best-effort; RoomView will retry on mount */ })
    .finally(() => { inflight.delete(room); });
  inflight.set(room, p);
}
