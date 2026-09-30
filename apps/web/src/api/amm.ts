const apiBase = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null;
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status, body });
  }
  return res.json();
}

export interface AmmConfig {
  usdc_mint: string;
  amm_wallet_pubkey: string;
  amm_wallet_ata: string;
}
export const getAmmConfig = () => req<AmmConfig>('/amm/config');

export interface WalletStatus { linked_pubkey: string | null; }
export const getWalletStatus = () => req<WalletStatus>('/amm/wallet/status');

export interface LinkChallenge { message: string; nonce_envelope: string; }
export const postLinkChallenge = () => req<LinkChallenge>('/amm/wallet/link-challenge', { method: 'POST' });

export interface LinkConfirmResult {
  linked_pubkey: string;
  retro_attributed: { count: number; total_base_units: string };
}
export const postLinkConfirm = (body: { pubkey: string; signature_b58: string; nonce_envelope: string }) =>
  req<LinkConfirmResult>('/amm/wallet/link-confirm', { method: 'POST', body: JSON.stringify(body) });

export const postUnlink = () =>
  req<{ unlinked_pubkey: string | null }>('/amm/wallet/unlink', { method: 'POST' });

export const postAcceptTerms = () => req<{ accepted_at: string }>('/amm/accept-terms', { method: 'POST' });
