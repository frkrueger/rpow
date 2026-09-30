import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { streamUrl, type ChatMessage } from './api.js';

/** Single owner of the EventSource for the whole chat app. Components
 *  subscribe to messages for a specific room via `useRoomStream(slug)`.
 *
 *  Slice 2b scope: room_message + room_message_deleted only. Presence,
 *  typing, DMs, and the host arrive in slice 3+. */

type Listener = (msg: RealtimeEvent) => void;

export type RealtimeEvent =
  | { type: 'message'; room: string; message: ChatMessage }
  | { type: 'message_deleted'; room: string; id: string };

interface Ctx {
  /** Subscribe to events for a single room. Returns an unsubscribe fn. */
  subscribe: (room: string, fn: Listener) => () => void;
  /** Connection state for UI hints. */
  status: 'connecting' | 'open' | 'closed';
}

const RealtimeContext = createContext<Ctx | null>(null);

export function RealtimeProvider({ rooms, children }: { rooms: string[]; children: ReactNode }) {
  const listenersRef = useRef<Map<string, Set<Listener>>>(new Map());
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');

  // Stable key for the rooms array so we only reopen the stream when the
  // actual set of subscribed rooms changes, not on every render.
  const roomsKey = useMemo(() => [...rooms].sort().join(','), [rooms]);

  useEffect(() => {
    if (rooms.length === 0) {
      setStatus('closed');
      return;
    }
    setStatus('connecting');
    const es = new EventSource(streamUrl(rooms), { withCredentials: true });

    const dispatch = (room: string, evt: RealtimeEvent) => {
      const subs = listenersRef.current.get(room);
      if (!subs) return;
      for (const fn of subs) {
        try {
          fn(evt);
        } catch {
          // Individual subscriber error mustn't break the stream.
        }
      }
    };

    es.addEventListener('open', () => setStatus('open'));
    es.addEventListener('error', () => {
      // EventSource auto-reconnects; just signal status to the UI.
      setStatus('connecting');
    });

    es.addEventListener('room_message', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as ChatMessage;
        dispatch(payload.room, { type: 'message', room: payload.room, message: payload });
      } catch {
        // ignore malformed events
      }
    });

    es.addEventListener('room_message_deleted', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as { room: string; id: string };
        dispatch(payload.room, { type: 'message_deleted', room: payload.room, id: payload.id });
      } catch {
        // ignore malformed events
      }
    });

    return () => {
      es.close();
      setStatus('closed');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomsKey]);

  const value = useMemo<Ctx>(() => ({
    subscribe(room, fn) {
      let set = listenersRef.current.get(room);
      if (!set) {
        set = new Set();
        listenersRef.current.set(room, set);
      }
      set.add(fn);
      return () => {
        const s = listenersRef.current.get(room);
        if (s) {
          s.delete(fn);
          if (s.size === 0) listenersRef.current.delete(room);
        }
      };
    },
    status,
  }), [status]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): Ctx {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return ctx;
}

export function useRoomStream(room: string, onEvent: Listener) {
  const { subscribe } = useRealtime();
  useEffect(() => subscribe(room, onEvent), [room, subscribe, onEvent]);
}
