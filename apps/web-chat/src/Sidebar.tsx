import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type ChatRoom } from './api.js';
import { prefetchScrollback } from './scrollbackCache.js';

export function Sidebar() {
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { slug } = useParams<{ slug?: string }>();

  useEffect(() => {
    let cancelled = false;
    api.rooms()
      .then(r => {
        if (cancelled) return;
        setRooms(r.rooms);
        // Warm the scrollback cache for every room in the background, so
        // clicking any sidebar entry is a cache hit. Fires in chunks to
        // avoid hammering the API with 21 simultaneous requests.
        const CHUNK = 4;
        const list = r.rooms.map(x => x.slug);
        let i = 0;
        const tick = () => {
          if (cancelled || i >= list.length) return;
          for (let k = 0; k < CHUNK && i < list.length; k++, i++) {
            prefetchScrollback(list[i]!);
          }
          setTimeout(tick, 80);
        };
        tick();
      })
      .catch(e => { if (!cancelled) setError(e.message ?? String(e)); });
    return () => { cancelled = true; };
  }, []);

  // Server already sorts by category, sort_order, slug — preserve that.
  const grouped = useMemo(() => {
    if (!rooms) return null;
    const map = new Map<string, ChatRoom[]>();
    for (const r of rooms) {
      const arr = map.get(r.category) ?? [];
      arr.push(r);
      map.set(r.category, arr);
    }
    return Array.from(map.entries());
  }, [rooms]);

  return (
    <aside className="chat-sidebar">
      {error && <div className="error-banner">{error}</div>}
      {!rooms && !error && <div className="chat-sidebar-loading">Loading rooms…</div>}
      {grouped && grouped.map(([category, list]) => (
        <div className="chat-sidebar-group" key={category}>
          <div className="chat-sidebar-section-head">{category}</div>
          {list.map(r => (
            <Link
              key={r.slug}
              className={`chat-sidebar-room${slug === r.slug ? ' active' : ''}`}
              to={`/r/${r.slug}`}
              title={r.description}
              onMouseEnter={() => prefetchScrollback(r.slug)}
              onFocus={() => prefetchScrollback(r.slug)}
            >
              {r.title}
            </Link>
          ))}
        </div>
      ))}
    </aside>
  );
}
