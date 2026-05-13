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

export interface RoomsResponse {
  rooms: ChatRoom[];
}

export const api = {
  rooms: () => jsonFetch<RoomsResponse>('/api/chat/rooms'),
};
