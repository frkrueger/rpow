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

export interface SessionRow {
  id: string;
  bet_base_units: string;
  bankroll_initial_base_units: string;
  bankroll_remaining_base_units: string;
  matches_won: number;
  matches_lost: number;
  status: 'OPEN' | 'CLOSED';
  opened_at: string;
  last_match_at: string | null;
}

export interface TriviaProfile {
  email: string;
  x_handle: string | null;
  x_handle_verified_at: string | null;
  x_avatar_url: string | null;
  open_session: SessionRow | null;
  career: { wins: number; losses: number };
}

export interface LobbyEntry {
  session_id: string;
  account_email: string;
  x_handle: string;
  x_avatar_url: string | null;
  bet_base_units: string;
  bankroll_remaining_base_units: string;
  matches_won: number;
  matches_lost: number;
  opened_at: string;
  last_match_at: string | null;
  is_favorite: boolean;
}

export interface RecentMatch {
  id: string;
  offerer_email: string;
  challenger_email: string;
  offerer_x_handle: string | null;
  challenger_x_handle: string | null;
  bet_base_units: string;
  winner_email: string;
  offerer_choice_idx: number | null;
  challenger_choice_idx: number | null;
  question_id: string;
  created_at: string;
  resolved_at: string;
}

export interface ChatMessage {
  id: string;
  account_email: string | null;
  x_handle: string | null;
  kind: 'USER' | 'SYSTEM';
  body: string;
  created_at: string;
}

export interface TriviaStats {
  total_matches: number;
  total_volume_base_units: string;
  total_verified_users: number;
  open_arena_count: number;
}

export interface XHandleStartResponse {
  code: string;
  tweet_intent_url: string;
  expires_at: string;
}

export interface MatchPollPayload {
  id: string;
  state: 'ACTIVE' | 'RESOLVED';
  offerer_email: string;
  challenger_email: string;
  offerer_x_handle: string | null;
  challenger_x_handle: string | null;
  bet_base_units: string;
  question_id: string;
  question: string;
  choices: string[];
  correct_choice_idx: number | null;
  offerer_choice_idx: number | null;
  offerer_answered: boolean;
  offerer_answered_at: string | null;
  challenger_choice_idx: number | null;
  challenger_answered: boolean;
  challenger_answered_at: string | null;
  winner_email: string | null;
  signature_hex: string | null;
  deadline_at: string;
  created_at: string;
  resolved_at: string | null;
}

export interface MatchStartResponse {
  match_id: string;
  question_id: string;
  question: string;
  choices: string[];
  bet_base_units: string;
  deadline_at: string;
}

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch(`${API_BASE}/me`, { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`me ${res.status}`);
  return res.json();
}

export async function fetchTriviaMe(): Promise<TriviaProfile | null> {
  const res = await fetch(`${API_BASE}/api/trivia/me`, { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`trivia/me ${res.status}`);
  return res.json();
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

export async function fetchLobby(): Promise<LobbyEntry[]> {
  const res = await fetch(`${API_BASE}/api/trivia/lobby`, { credentials: 'include' });
  if (!res.ok) return [];
  const body = await res.json();
  return body.players ?? [];
}

export async function fetchRecentMatches(): Promise<RecentMatch[]> {
  const res = await fetch(`${API_BASE}/api/trivia/matches/recent`, { credentials: 'include' });
  if (!res.ok) return [];
  const body = await res.json();
  return body.matches ?? [];
}

export async function fetchChat(before?: string): Promise<ChatMessage[]> {
  const url = before
    ? `${API_BASE}/api/trivia/chat?before=${encodeURIComponent(before)}`
    : `${API_BASE}/api/trivia/chat`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return [];
  const body = await res.json();
  return body.messages ?? [];
}

export async function postChat(body: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/trivia/chat`, {
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

export async function fetchTriviaStats(): Promise<TriviaStats | null> {
  const res = await fetch(`${API_BASE}/api/trivia/stats`, { credentials: 'omit' });
  if (!res.ok) return null;
  return res.json();
}

export async function enterArena(bankrollBaseUnits: string, betBaseUnits: string): Promise<{
  session_id: string;
  bet_base_units: string;
  bankroll_initial_base_units: string;
  bankroll_remaining_base_units: string;
  status: 'OPEN';
  opened_at: string;
}> {
  const res = await fetch(`${API_BASE}/api/trivia/sessions`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bankroll_base_units: bankrollBaseUnits, bet_base_units: betBaseUnits }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `enterArena ${res.status}`);
  }
  return res.json();
}

export async function closeSession(sessionId: string): Promise<{ status: string; closed_at: string; refunded_base_units: string }> {
  const res = await fetch(`${API_BASE}/api/trivia/sessions/${sessionId}/close`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `closeSession ${res.status}`);
  }
  return res.json();
}

export async function startMatch(sessionId: string): Promise<MatchStartResponse> {
  const res = await fetch(`${API_BASE}/api/trivia/matches/start`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `start ${res.status}`);
  }
  return res.json();
}

export async function submitAnswer(matchId: string, choiceIdx: number): Promise<{ answered_at: string; both_answered: boolean }> {
  const res = await fetch(`${API_BASE}/api/trivia/matches/${matchId}/answer`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ choice_idx: choiceIdx }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `answer ${res.status}`);
  }
  return res.json();
}

export async function fetchActiveMatch(sessionId: string): Promise<MatchPollPayload | null> {
  const res = await fetch(`${API_BASE}/api/trivia/matches/active?session_id=${encodeURIComponent(sessionId)}`, {
    credentials: 'include',
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.match ?? null;
}

export async function fetchMatch(matchId: string): Promise<MatchPollPayload | null> {
  const res = await fetch(`${API_BASE}/api/trivia/matches/${matchId}`, {
    credentials: 'include',
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.match ?? null;
}

export interface FavoriteRow {
  x_handle: string;
  x_avatar_url: string | null;
  created_at: string;
}

export async function fetchFavorites(): Promise<FavoriteRow[]> {
  const res = await fetch(`${API_BASE}/api/favorites`, { credentials: 'include' });
  if (!res.ok) return [];
  const body = await res.json();
  return body.favorites ?? [];
}

export async function addFavorite(xHandle: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/favorites`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x_handle: xHandle }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `favorite ${res.status}`);
  }
}

export async function removeFavorite(xHandle: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/favorites/${encodeURIComponent(xHandle)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `unfavorite ${res.status}`);
  }
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
