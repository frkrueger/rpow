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
export interface SpinResponse {
  id: string;
  outcome: 'WIN' | 'LOSE';
  net_user_change_base_units: string;
  new_balance_base_units: string;
  random_value_hex: string;
  signature: string;
  server_time: string;
}
export interface HistoryRow {
  id: string;
  stake_base_units: string;
  odds_choice: string;
  outcome: 'WIN' | 'LOSE';
  net_user_change_base_units: string;
  created_at: string;
}

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch(`${API_BASE}/me`, { credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`me ${res.status}`);
  return res.json();
}

export async function fetchAccess(): Promise<'allowed' | 'denied' | 'unauthenticated'> {
  const res = await fetch(`${API_BASE}/api/longshot/access`, { credentials: 'include' });
  if (res.status === 401) return 'unauthenticated';
  if (!res.ok) return 'denied';
  const body = await res.json();
  return body.access === 'allowed' ? 'allowed' : 'denied';
}

export async function spin(stakeBaseUnits: string, oddsChoice: string): Promise<SpinResponse> {
  const res = await fetch(`${API_BASE}/api/longshot/spin`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stake_base_units: stakeBaseUnits, odds_choice: oddsChoice }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: 'UNKNOWN' }));
    throw new Error(e.error || `spin ${res.status}`);
  }
  return res.json();
}

export async function fetchHistory(): Promise<HistoryRow[]> {
  const res = await fetch(`${API_BASE}/api/longshot/history?limit=20`, { credentials: 'include' });
  if (!res.ok) return [];
  const body = await res.json();
  return body.spins ?? [];
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
