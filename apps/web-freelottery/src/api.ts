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

export interface Me {
  email: string;
  balance_base_units: string;
  x_handle: string | null;
  x_avatar_url: string | null;
}

export interface FreelotteryStatus {
  enabled: boolean;
  startUtcDate: string | null;
  totalDays: number;
  prizeBaseUnits: string;
  drawHourUtc: number;
  dayIndex: number | null;
  currentDayUtc: string | null;
  nextDrawAt: string | null;
  ended: boolean;
}

export interface StartResponse {
  code: string;
  tweet_intent_url: string;
  expires_at: string;
  day_utc: string;
}

export interface VerifyResponse {
  ok: true;
  ticket_count: 1 | 2;
  day_utc: string;
  balance_base_units_at_entry: string;
}

export interface XHandleStartResponse {
  code: string;
  tweet_intent_url: string;
  expires_at: string;
}

export interface XHandleVerifyResponse {
  x_handle: string;
  x_handle_verified_at: string;
  x_avatar_url: string;
}

export const api = {
  me: () => jsonFetch<Me>('/me'),
  status: () => jsonFetch<FreelotteryStatus>('/api/freelottery/status'),
  startEntry: () => jsonFetch<StartResponse>('/api/freelottery/entry/start', { method: 'POST', body: '{}' }),
  verifyEntry: (tweet_url: string) =>
    jsonFetch<VerifyResponse>('/api/freelottery/entry/verify', {
      method: 'POST',
      body: JSON.stringify({ tweet_url }),
    }),
};

// Named bindings to match the X-handle bind modal copied verbatim from web-gladiator.
export const startXVerification = (handle: string) =>
  jsonFetch<XHandleStartResponse>('/api/gladiator/x-handle/start', {
    method: 'POST',
    body: JSON.stringify({ handle }),
  });

export const verifyXTweet = (tweet_url: string) =>
  jsonFetch<XHandleVerifyResponse>('/api/gladiator/x-handle/verify', {
    method: 'POST',
    body: JSON.stringify({ tweet_url }),
  });
