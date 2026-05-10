// Wire-format types used by both server and web.

export interface AuthRequestBody { email: string; turnstile_token?: string }
export interface AuthRequestResponse { ok: true; cooldown_seconds: number }

export interface MeResponse {
  email: string;
  balance_base_units: string;
  minted_base_units: string;
  sent_base_units: string;
  received_base_units: string;
  wrap_allowed: boolean;
  solana_wallet: string | null;
  srpow_supply_owned_base_units: string;
  /** Per-account UTC-day mint quota. Scales with the current halving reward. */
  daily_mint_cap_base_units: string;
  /** Amount this account has already minted in the current UTC day. */
  daily_minted_base_units: string;
  /** Convenience: cap - minted (clamped at 0). */
  daily_remaining_base_units: string;
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
  value_base_units: string;
  issued_at: string;
}

export interface SendRequestBody {
  recipient_email: string;
  amount_base_units: string;
  idempotency_key: string;
}
export interface SendResponse {
  ok: true;
  transferred_base_units: string;
  recipient_email: string;
  transfer_id: string;
  /** True when the recipient had no rpow2 account; an email was sent for them to claim. */
  pending?: boolean;
}

export type ApiErrorCode =
  | 'RECIPIENT_NOT_FOUND'
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_SOLUTION'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_ALREADY_CLAIMED'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'INTERNAL';

export interface ApiError { error: ApiErrorCode; message: string; retry_after?: number }

export interface ActivityEntry {
  type: 'mint' | 'send' | 'receive';
  amount_base_units: string;
  counterparty_email?: string;
  at: string; // iso8601
}
export type ActivityResponse = ActivityEntry[];

export interface LedgerResponse {
  total_minted_base_units: string;        // stringified bigint
  total_transferred_base_units: string;
  circulating_supply_base_units: string;
  minted_supply_counter_base_units: string; // mirrors app_counters.minted_supply
  max_supply_base_units: string;
  base_units_per_rpow: string;            // = "1000000000"
  current_difficulty_bits: number;
  current_reward_base_units: string;
  next_reward_base_units: string;
  next_halving_at_base_units: string;
  base_units_to_next_halving: string;
  halving_index: number;
  is_capped: boolean;
  user_count: number;
}

export type StatsHistoryWindow = '24h' | '7d' | '30d' | 'all';

export interface StatsBalanceHistogramBucket {
  bucket: string;
  min_balance_base_units: string;
  max_balance_base_units: string | null;
  holder_count: number;
  total_balance_base_units: string;
}

export interface StatsTopBalance {
  rank: number;
  balance_base_units: string;
}

export interface StatsSummaryResponse {
  sampled_at: string;
  ledger: LedgerResponse;
  activity: {
    mint_count_1h: number;
    mint_count_24h: number;
    minted_base_units_1h: string;
    minted_base_units_24h: string;
    transfer_count_1h: number;
    transfer_count_24h: number;
    transferred_base_units_1h: string;
    transferred_base_units_24h: string;
    active_challengers_15m: number;
    /** SRPOW wraps confirmed in the last 24h. */
    wrap_count_24h: number;
    /** Base-unit total of confirmed SRPOW wraps in the last 24h. */
    wrapped_base_units_24h: string;
    /** Users that have bound a Solana wallet via /phantom/bind. */
    bound_wallet_count: number;
  };
  holders: {
    holder_count: number;
    zero_balance_user_count: number;
    average_balance_base_units: string;
    balance_histogram: StatsBalanceHistogramBucket[];
    top_balances: StatsTopBalance[];
  };
}

export interface StatsHistoryPoint {
  bucket_start: string;
  total_minted_base_units: string;
  mint_count: number;
  minted_base_units: string;
  total_transferred_base_units: string;
  transfer_count: number;
  transferred_base_units: string;
  circulating_supply_base_units: string;
  user_count: number;
  new_users: number;
  current_difficulty_bits: number;
  current_reward_base_units: string;
  challenges: number;
  active_challengers: number;
}

export interface StatsHistoryResponse {
  window: StatsHistoryWindow;
  bucket_seconds: number;
  rows: StatsHistoryPoint[];
}

export interface PhantomChallengeResponse {
  nonce: string;
  message: string;
  expires_at: string;
}

export interface PhantomBindResponse {
  ok: true;
  solana_wallet: string;
}

export interface WrapResponse {
  ok: true;
  event_id: string;
  status: 'CONFIRMED';
  solana_signature: string | null;
}

export interface WrapEvent {
  event_id: string;
  direction: 'WRAP' | 'UNWRAP';
  amount_base_units: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REFUNDED';
  solana_signature: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}
