import type {
  AuthRequestBody, AuthRequestResponse, MeResponse,
  ChallengeResponse, MintRequestBody, MintResponse,
  SendRequestBody, SendResponse, ActivityResponse, LedgerResponse, ApiError,
  PhantomChallengeResponse, PhantomBindResponse, WrapResponse, WrapEvent,
} from '@rpow/shared';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method, credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let err: ApiError;
    try { err = await res.json(); } catch { err = { error: 'INTERNAL', message: res.statusText }; }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// --- AMM types (local to this file; not yet in @rpow/shared) -----------------

export type AmmPoolResponse =
  | { seeded: false }
  | {
      seeded: true;
      reserves: { rpow_base_units: string; usdc_base_units: string };
      total_lp_supply: string;
      fee_bps: number;
      spot_price_usdc_per_rpow_e9: string;
      seeded_at: string;
      your_lp_balance?: string;
    };

export type AmmMeResponse = {
  email: string;
  usdc_base_units: string;
  lp_balance: string;
  terms_accepted_at: string | null;
  spot_price_usdc_per_rpow_e9: string | null;
  your_pool_share_bps: string | null;
};

export type AmmQuoteBuyResponse = {
  rpow_out: string;
  fee_base_units: string;
  price_impact_bps: string;
  spot_price_usdc_per_rpow_e9: string;
};

export type AmmQuoteSellResponse = {
  usdc_out: string;
  fee_base_units: string;
  price_impact_bps: string;
  spot_price_usdc_per_rpow_e9: string;
};

export type AmmSwapResult = {
  swap_id: string;
  output_base_units: string;
  fee_base_units: string;
  pool_rpow_after: string;
  pool_usdc_after: string;
  signature_hex: string;
  server_time: string;
};

export type AmmLpAddResult = {
  event_id: string;
  lp_minted: string;
  rpow_consumed: string;
  usdc_consumed: string;
  signature_hex: string;
  server_time: string;
};

export type AmmLpRemoveResult = {
  event_id: string;
  rpow_received: string;
  usdc_received: string;
  signature_hex: string;
  server_time: string;
};

export type AmmRecentSwap = {
  id: string;
  x_handle: string | null;
  direction: 'BUY' | 'SELL';
  rpow_delta_base_units: string;
  usdc_delta_base_units: string;
  fee_base_units: string;
  pool_rpow_after: string;
  pool_usdc_after: string;
  created_at: string;
};

export type AmmSwapsRecentResponse = { swaps: AmmRecentSwap[] };

export type AmmAcceptTermsResponse = { accepted_at: string };

// --- API surface -------------------------------------------------------------

export const api = {
  authRequest: (b: AuthRequestBody) => call<AuthRequestResponse>('POST', '/auth/request', b),
  me: () => call<MeResponse>('GET', '/me'),
  logout: () => call<{ ok: true }>('POST', '/auth/logout'),
  challenge: () => call<ChallengeResponse>('POST', '/challenge'),
  mint: (b: MintRequestBody) => call<MintResponse>('POST', '/mint', b),
  send: (b: SendRequestBody) => call<SendResponse>('POST', '/send', b),
  activity: () => call<ActivityResponse>('GET', '/activity'),
  ledger: () => call<LedgerResponse>('GET', '/ledger'),
  phantomChallenge: () => call<PhantomChallengeResponse>('POST', '/phantom/challenge'),
  phantomBind: (b: { nonce: string; wallet_address: string; signature_base58: string }) =>
    call<PhantomBindResponse>('POST', '/phantom/bind', b),
  srpowWrap: (b: { amount_base_units: string; idempotency_key: string }) =>
    call<WrapResponse>('POST', '/srpow/wrap', b),
  srpowEvents: () => call<WrapEvent[]>('GET', '/srpow/events'),
  amm: {
    pool: () => call<AmmPoolResponse>('GET', '/amm/pool'),
    me: () => call<AmmMeResponse>('GET', '/amm/me'),
    quoteBuy: (usdc_base_units: string) =>
      call<AmmQuoteBuyResponse>('GET', `/amm/quote/buy?usdc_base_units=${encodeURIComponent(usdc_base_units)}`),
    quoteSell: (rpow_base_units: string) =>
      call<AmmQuoteSellResponse>('GET', `/amm/quote/sell?rpow_base_units=${encodeURIComponent(rpow_base_units)}`),
    buy: (b: { usdc_base_units: string; min_rpow_out: string }) =>
      call<AmmSwapResult>('POST', '/amm/buy', b),
    sell: (b: { rpow_base_units: string; min_usdc_out: string }) =>
      call<AmmSwapResult>('POST', '/amm/sell', b),
    lpAdd: (b: { rpow_base_units: string; usdc_base_units: string; min_lp_out: string }) =>
      call<AmmLpAddResult>('POST', '/amm/lp/add', b),
    lpRemove: (b: { lp_base_units: string; min_rpow_out: string; min_usdc_out: string }) =>
      call<AmmLpRemoveResult>('POST', '/amm/lp/remove', b),
    acceptTerms: () => call<AmmAcceptTermsResponse>('POST', '/amm/accept-terms', {}),
    swapsRecent: () => call<AmmSwapsRecentResponse>('GET', '/amm/swaps/recent'),
  },
};
