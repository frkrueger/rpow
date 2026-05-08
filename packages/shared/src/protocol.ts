// Wire-format types used by both server and web.

export interface AuthRequestBody { email: string; turnstile_token?: string }
export interface AuthRequestResponse { ok: true; cooldown_seconds: number }

export interface MeResponse {
  email: string;
  balance: number;
  minted: number;
  sent: number;
  received: number;
}

export interface ChallengeResponse {
  challenge_id: string;
  nonce_prefix: string; // hex
  difficulty_bits: number;
  expires_at: string;   // iso8601
}

export interface MintRequestBody {
  challenge_id: string;
  solution_nonce: string; // decimal string of u64
}
export interface MintResponse { token: TokenSummary }

export interface TokenSummary {
  id: string;
  value: number;
  issued_at: string;
}

export interface SendRequestBody {
  recipient_email: string;
  amount: number;
  idempotency_key: string;
}
export interface SendResponse {
  ok: true;
  transferred: number;
  recipient_email: string;
  transfer_id: string;
  /** True when the recipient had no rpow2 account; an email was sent for them to claim. */
  pending?: boolean;
}

export type PendingTransferStatus = 'pending' | 'expired' | 'claimed' | 'canceled';

export interface PendingTransferSummary {
  id: string;
  recipient_email: string;
  amount: number;
  status: PendingTransferStatus;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  canceled_at: string | null;
}

export interface PendingTransfersResponse {
  pending_transfers: PendingTransferSummary[];
}

export interface PendingTransferActionResponse extends PendingTransferSummary {
  ok: true;
  reclaimed?: number;
}

export type ClaimStatus = 'pending' | 'expired' | 'claimed' | 'canceled';

export interface ClaimStatusResponse {
  ok: true;
  sender_email: string;
  recipient_email: string;
  amount: number;
  expires_at: string;
  status: ClaimStatus;
  claimed_at: string | null;
  canceled_at: string | null;
}

export interface ClaimRequestBody {
  token: string;
}

export interface ClaimResponse {
  ok: true;
  recipient_email: string;
  amount: number;
}

export type ApiErrorCode =
  | 'RECIPIENT_NOT_FOUND'
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_CLAIM'
  | 'ALREADY_CLAIMED'
  | 'CLAIM_EXPIRED'
  | 'CLAIM_CANCELED'
  | 'CLAIM_UNAVAILABLE'
  | 'INVALID_SOLUTION'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_ALREADY_CLAIMED'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'INTERNAL';

export interface ApiError { error: ApiErrorCode; message: string; retry_after?: number }

export interface ActivityEntry {
  type: 'mint' | 'send' | 'receive';
  amount: number;
  counterparty_email?: string;
  at: string; // iso8601
}
export type ActivityResponse = ActivityEntry[];

export interface LedgerResponse {
  total_minted: number;
  total_transferred: number;
  circulating_supply: number;
  current_difficulty_bits: number;
  user_count: number;
  max_supply: number;
  epoch: number;
  epoch_size: number;
  next_milestone_at: number;
  coins_until_next_milestone: number;
  next_difficulty_bits: number;
  is_capped: boolean;
  signing_public_key: string;
  public_key_pem_url: string;
  latest_token: {
    id: string;
    parent_token_id: string | null;
    owner_email_hash: string;
    value: number;
    issued_at: string;
    server_sig: string;
  } | null;
}
