const API_BASE = (() => {
  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    return 'http://localhost:8080';
  }
  return 'https://api.rpow2.com';
})();

export interface Me {
  email: string;
  balance_base_units: string;
}

export interface GladiatorProfile {
  email: string;
  x_handle: string | null;
  x_handle_verified_at: string | null;
  x_avatar_url: string | null;
  open_session: any | null;
  career: { wins: number; losses: number };
}

export interface LobbyEntry {
  session_id: string;
  account_email: string;
  x_handle: string;
  x_avatar_url: string | null;
  bet_base_units: string;
  bankroll_remaining_base_units: string;
  flips_won: number;
  flips_lost: number;
  opened_at: string;
  last_flip_at: string | null;
}

export interface RecentFlip {
  id: string;
  offerer_email: string;
  challenger_email: string;
  offerer_x_handle: string | null;
  challenger_x_handle: string | null;
  bet_base_units: string;
  winner_email: string;
  random_value_hex: string;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  account_email: string | null;
  x_handle: string | null;
  kind: 'USER' | 'SYSTEM';
  body: string;
  created_at: string;
}

export interface XHandleStartResponse {
  code: string;
  tweet_intent_url: string;
  expires_at: string;
}

/**
 * Fetch with retry-on-transient-error. Retries on network failure or 5xx
 * responses with exponential backoff. Returns the final Response (which may
 * still be a 5xx if all retries exhausted). The caller decides what to do
 * with 4xx — those are NOT retried because they're authoritative answers
 * (401 = not signed in, 404 = no such resource, etc.).
 *
 * Why: api.rpow2.com can be under heavy mining load and return 502/504/timeout
 * on /me. A single failed fetch was dropping signed-in users to the spectator
 * state. Three short retries lets us ride through the typical spike.
 */
async function fetchWithRetry(url: string, init?: RequestInit, retries = 3): Promise<Response> {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 && attempt < retries) {
        await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt)));
        attempt++;
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt)));
      attempt++;
    }
  }
}

export async function fetchMe(): Promise<Me | null> {
  const res = await fetchWithRetry(`${API_BASE}/me`, { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`me ${res.status}`);
  return res.json();
}

export async function fetchGladiatorMe(): Promise<GladiatorProfile | null> {
  const res = await fetchWithRetry(`${API_BASE}/api/gladiator/me`, { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`gladiator/me ${res.status}`);
  return res.json();
}

export async function fetchLobby(): Promise<LobbyEntry[]> {
  const res = await fetch(`${API_BASE}/api/gladiator/lobby`, { credentials: 'include' });
  if (!res.ok) return [];
  const body = await res.json();
  return body.gladiators ?? [];
}

export async function fetchRecentFlips(): Promise<RecentFlip[]> {
  const res = await fetch(`${API_BASE}/api/gladiator/flips/recent`, { credentials: 'include' });
  if (!res.ok) return [];
  const body = await res.json();
  return body.flips ?? [];
}

export async function fetchChat(before?: string): Promise<ChatMessage[]> {
  const url = before
    ? `${API_BASE}/api/gladiator/chat?before=${encodeURIComponent(before)}`
    : `${API_BASE}/api/gladiator/chat`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return [];
  const body = await res.json();
  return body.messages ?? [];
}

export async function postChat(body: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/gladiator/chat`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `chat ${res.status}`);
  }
}

export async function startXVerification(handle: string): Promise<XHandleStartResponse> {
  const res = await fetch(`${API_BASE}/api/gladiator/x-handle/start`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `x-handle/start ${res.status}`);
  }
  return res.json();
}

export async function verifyXTweet(tweetUrl: string): Promise<{ x_handle: string; x_handle_verified_at: string; x_avatar_url: string }> {
  const res = await fetch(`${API_BASE}/api/gladiator/x-handle/verify`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tweet_url: tweetUrl }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `x-handle/verify ${res.status}`);
  }
  return res.json();
}

export function formatRpow(baseUnitsStr: string): string {
  const big = BigInt(baseUnitsStr);
  const sign = big < 0n ? '-' : '';
  const abs = big < 0n ? -big : big;
  const denom = 1_000_000_000n;
  const whole = abs / denom;
  const frac = abs % denom;
  if (frac === 0n) return `${sign}${whole}`;
  return `${sign}${whole}.${frac.toString().padStart(9, '0').replace(/0+$/, '')}`;
}
