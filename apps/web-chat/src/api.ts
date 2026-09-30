const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP_${res.status}` }));
    throw Object.assign(new Error(body?.message ?? `HTTP ${res.status}`), {
      status: res.status,
      code: body?.error,
    });
  }
  return res.json() as Promise<T>;
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

export interface ChatMessage {
  id: string;
  room: string;
  x_handle: string;
  avatar: string | null;
  body: string;
  at: string;
  is_host?: boolean;
}

export interface RoomsResponse {
  rooms: ChatRoom[];
}

export interface MessagesResponse {
  messages: Array<{
    id: string;
    roomSlug: string;
    xHandle: string;
    xAvatarUrl: string | null;
    body: string;
    createdAt: string;
    deletedAt: string | null;
    isHost: boolean;
  }>;
}

export interface Me {
  email: string;
  x_handle: string | null;
  x_avatar_url: string | null;
}

export interface PostMessageResponse extends ChatMessage {}

/** Absolute URL for the SSE endpoint — EventSource doesn't carry the
 *  default fetch credentials handling, so we need a fully-qualified URL
 *  that hits the API origin directly. */
export function streamUrl(rooms: string[]): string {
  const qs = `rooms=${rooms.map(encodeURIComponent).join(',')}`;
  return `${API_BASE}/api/chat/stream?${qs}`;
}

export const api = {
  rooms: () => jsonFetch<RoomsResponse>('/api/chat/rooms'),
  me: () => jsonFetch<Me>('/me'),
  scrollback: (slug: string, limit = 50) =>
    jsonFetch<MessagesResponse>(`/api/chat/rooms/${encodeURIComponent(slug)}/messages?limit=${limit}`),
  postMessage: (room: string, body: string) =>
    jsonFetch<PostMessageResponse>('/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify({ room, body }),
    }),
  deleteMessage: (id: string) =>
    jsonFetch<void>(`/api/chat/messages/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
