# RPOW Pool — design spec

**Date:** 2026-05-11
**Status:** approved
**Authors:** fred + claude

## 1. Summary

RPOW Pool is an experimental **game-grade** automated market maker (AMM) that lets users trade RPOW against USDC. It is **not a financial product or exchange** — it is a casual hobby project built on top of the RPOW tribute token, with an explicit warning UX and no support guarantees.

Implementation strategy: USDC becomes a second database-tracked asset (alongside RPOW). All AMM operations (buy, sell, add liquidity, remove liquidity) are pure database transactions wrapped in `withTx`. The only Solana-side flows are USDC deposits (Solana → DB credit) and withdrawals (DB → Solana SPL transfer). Those are isolated, decoupled from the AMM math, and shipped as the last two slices.

## 2. Goals / non-goals

**In scope (V1):**
- Singleton USDC/RPOW pool with Uniswap V2-style constant-product math (`x × y = k`) and 0.3% LP fee.
- Database-tracked USDC balance per user.
- Buy, sell, add liquidity, remove liquidity — all atomic, all signed for audit.
- Risk acceptance flow with prominent "game / no responsibility" copy.
- USDC deposit via a shared Solana wallet + per-user memo.
- USDC withdrawal to a user-specified Solana address.
- Per-op ed25519 signature for audit (same pattern as gladiator flips / trivia matches).
- Front-end at `/swap` + `/pool` on rpow2.com.

**Out of scope (V1):**
- Multi-pool / other pairs.
- Variable LP fee tier / governance over fees.
- Slippage-aware routing across multiple hops.
- Limit orders / time-weighted average price / oracles.
- LP rewards / yield-farming beyond fees-in-pool.
- Concentrated liquidity (Uni V3).
- Cross-margin with the wallet (USDC only used for the pool, not for general send).

## 3. Risk acceptance + framing

The "experimental game, no responsibility" framing is **central**, not an afterthought. Implementation:

- New column `users.amm_terms_accepted_at TIMESTAMPTZ NULL`.
- `POST /amm/accept-terms` — sets the column to `now()`. Idempotent.
- **Every** AMM endpoint (`/amm/buy`, `/amm/sell`, `/amm/lp/*`, `/amm/deposit-address`, `/amm/withdraw`) verifies the column is non-null. Returns `403 TERMS_NOT_ACCEPTED` otherwise.
- Frontend: a blocking modal on first visit to `/swap` or `/pool`, with the full warning text and a single `[ I UNDERSTAND, PROCEED ]` button. Once accepted, the modal does not re-appear.
- Persistent yellow banner across `/swap`, `/pool`, and the deposit page reading `⚠ GAME — funds at risk, limited support`.
- The USDC deposit confirmation step re-shows the full warning at the moment of irreversible action.
- The `/apps` tile description on rpow2.com reads: *"RPOW Pool — experimental game AMM, no support, deposit at your own risk"*.

**Warning text** (verbatim, used everywhere):

> ⚠ **EXPERIMENTAL GAME. NOT A FINANCIAL PRODUCT.**
>
> RPOW Pool is a hobbyist game with an unaudited automated market maker on top of a tribute token. It is **not** an exchange, brokerage, or investment vehicle. Treat it like a video game that happens to involve small real-world value.
>
> - USDC you deposit may be **permanently lost** through bugs, operator error, key compromise, or any other reason.
> - **Tech support is limited.** There is no help desk. Issues may take days, weeks, or never be resolved.
> - We take **no responsibility** for any loss.
> - Don't deposit more than you'd spend on a Steam game.
> - RPOW is a tribute token to Hal Finney's original, not a security or investment.
>
> By proceeding you accept these risks.

## 4. Asset model

USDC is held in `users.usdc_base_units BIGINT NOT NULL DEFAULT 0`. Stored at 6 decimals (Solana native — 1 USDC = 1,000,000 base units). RPOW continues to live in the existing `tokens` table; the AMM debits/credits RPOW by minting/burning tokens just like the existing send/gladiator flows.

Constants:
- `USDC_BASE_PER_USDC = 1_000_000n`
- `RPOW_BASE_PER_RPOW = 1_000_000_000n`

## 5. Pool data model

Singleton pool:

```sql
CREATE TABLE amm_pool (
  id                       TEXT PRIMARY KEY DEFAULT 'main',
  rpow_reserve_base_units  BIGINT NOT NULL CHECK (rpow_reserve_base_units > 0),
  usdc_reserve_base_units  BIGINT NOT NULL CHECK (usdc_reserve_base_units > 0),
  total_lp_supply          BIGINT NOT NULL CHECK (total_lp_supply > 0),
  fee_bps                  INT NOT NULL DEFAULT 30 CHECK (fee_bps BETWEEN 0 AND 1000),
  seeded_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 'main')
);

CREATE TABLE amm_lp_balances (
  account_email TEXT PRIMARY KEY REFERENCES users(email),
  lp_balance    BIGINT NOT NULL CHECK (lp_balance >= 0)
);

CREATE TABLE amm_swaps (
  id                    UUID PRIMARY KEY,
  account_email         TEXT NOT NULL REFERENCES users(email),
  direction             TEXT NOT NULL CHECK (direction IN ('BUY','SELL')),
  rpow_delta_base_units BIGINT NOT NULL,
  usdc_delta_base_units BIGINT NOT NULL,
  fee_base_units        BIGINT NOT NULL,
  pool_rpow_after       BIGINT NOT NULL,
  pool_usdc_after       BIGINT NOT NULL,
  signature             BYTEA NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX amm_swaps_account_idx ON amm_swaps(account_email, created_at DESC);
CREATE INDEX amm_swaps_recent_idx  ON amm_swaps(created_at DESC);

CREATE TABLE amm_lp_events (
  id                     UUID PRIMARY KEY,
  account_email          TEXT NOT NULL REFERENCES users(email),
  type                   TEXT NOT NULL CHECK (type IN ('ADD','REMOVE')),
  rpow_delta_base_units  BIGINT NOT NULL,
  usdc_delta_base_units  BIGINT NOT NULL,
  lp_delta_base_units    BIGINT NOT NULL,
  pool_rpow_after        BIGINT NOT NULL,
  pool_usdc_after        BIGINT NOT NULL,
  total_lp_after         BIGINT NOT NULL,
  signature              BYTEA NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX amm_lp_events_account_idx ON amm_lp_events(account_email, created_at DESC);

CREATE TABLE usdc_deposits (
  id                 UUID PRIMARY KEY,
  account_email      TEXT NOT NULL REFERENCES users(email),
  amount_base_units  BIGINT NOT NULL CHECK (amount_base_units > 0),
  solana_signature   TEXT NOT NULL UNIQUE,
  memo               TEXT NOT NULL,
  credited_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE usdc_withdrawals (
  id                  UUID PRIMARY KEY,
  account_email       TEXT NOT NULL REFERENCES users(email),
  amount_base_units   BIGINT NOT NULL CHECK (amount_base_units > 0),
  solana_destination  TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('PENDING','SENT','FAILED')),
  solana_signature    TEXT,
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ
);
CREATE INDEX usdc_withdrawals_pending_idx ON usdc_withdrawals(created_at) WHERE state = 'PENDING';
```

`amm_lp_balances` doesn't include the permanently-burned MIN_LIQUIDITY units. The math: `total_lp_supply = MIN_LIQUIDITY + sum(amm_lp_balances.lp_balance)`. We never credit the MIN_LIQUIDITY units to any user, which guarantees the pool can never be 100% drained even by a sole LP removing everything.

## 6. Pool math (Uniswap V2, 0.3% fee)

**Constants:**
- `FEE_NUM = 997n` (1000 - fee_bps_to_complement, hardcoded for 30 bps)
- `FEE_DEN = 1000n`
- `MIN_LIQUIDITY = 1000n` (LP base units permanently locked at seed)

**Spot price (no slippage, no fee):**
- `price_usdc_per_rpow = R_usdc / R_rpow`

**Swap output (given input):**
- Buy (USDC in, RPOW out): `Δrpow_out = (R_rpow × Δusdc_in × FEE_NUM) / (R_usdc × FEE_DEN + Δusdc_in × FEE_NUM)`
- Sell (RPOW in, USDC out): `Δusdc_out = (R_usdc × Δrpow_in × FEE_NUM) / (R_rpow × FEE_DEN + Δrpow_in × FEE_NUM)`
- New reserves: `R_in' = R_in + Δin (full)`, `R_out' = R_out - Δout`. Fee stays in `R_in'`, growing the pool.

**Invariant assertion** (after every swap): `R_rpow' × R_usdc' ≥ R_rpow × R_usdc`. Strict `>` for fee-positive swaps; equality for zero-fee swaps. Implementation throws if this fails.

**Slippage protection:**
- Buy: caller passes `min_rpow_out`. If computed `Δrpow_out < min_rpow_out`, throw `SLIPPAGE_EXCEEDED`.
- Sell: caller passes `min_usdc_out`. Same.

**Pool seeding (admin only):**
- `POST /amm/seed { rpow_base_units, usdc_base_units }` — first call only.
- Verifies pool row doesn't exist (or has zero reserves). 409 `POOL_ALREADY_SEEDED` otherwise.
- Verifies caller is in `AMM_ADMIN_EMAILS` allowlist (env var).
- Verifies caller has the RPOW + USDC balance.
- `withTx`: burn RPOW + USDC from caller, INSERT pool row with reserves = inputs, mint `sqrt(rpow × usdc) - MIN_LIQUIDITY` LP tokens to caller's `amm_lp_balances`, set `total_lp_supply = sqrt(rpow × usdc)`.
- `sqrt` of BigInt: Newton's method (integer square root), tested separately.

**Add liquidity:**
- `POST /amm/lp/add { rpow_base_units, usdc_base_units, min_lp_out }`
- The amounts must match the current ratio (within a small tolerance — we don't auto-balance like Uniswap V2's `addLiquidity`; we reject if the ratio is off). Tolerance: ±1% (passed as `max_ratio_drift_bps` in the body, default 100). Alternative: take the lesser side and return the excess (Uniswap V2 style). **Decision: V2 style.** Take the lesser side. The user inputs both amounts; we accept `min(usdc_in × R_rpow / R_usdc, rpow_in)` of RPOW and proportional USDC. Excess of one side is returned to the user's balance (no burn).
- LP minted: `min(rpow_used × total_lp / R_rpow, usdc_used × total_lp / R_usdc)`. If `< min_lp_out`: throw `SLIPPAGE_EXCEEDED`.
- Updates `amm_lp_balances` (UPSERT), `amm_pool` reserves + total_lp_supply.

**Remove liquidity:**
- `POST /amm/lp/remove { lp_base_units, min_rpow_out, min_usdc_out }`
- LP held must be ≥ `lp_base_units`.
- Returns: `rpow_out = lp × R_rpow / total_lp_supply`, `usdc_out = lp × R_usdc / total_lp_supply`. Floor division — leftover dust stays in the pool, slightly increasing reserve-per-LP for everyone else.
- Slippage checks. Update balances.

## 7. API surface

All endpoints under `/amm/`. Session auth required (no API-key auth for V1). All also require `terms_accepted_at` set (403 `TERMS_NOT_ACCEPTED`).

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET`  | `/amm/pool` | — | Public reserves + spot price + total LP + your LP balance (if authed) |
| `GET`  | `/amm/quote/buy?usdc=N` | — | `{ rpow_out, fee_paid, price_impact_bps }` |
| `GET`  | `/amm/quote/sell?rpow=N` | — | `{ usdc_out, fee_paid, price_impact_bps }` |
| `POST` | `/amm/accept-terms` | — | `{ accepted_at }` |
| `POST` | `/amm/buy`  | `{ usdc_base_units, min_rpow_out }` | `{ swap_id, rpow_received, signature }` |
| `POST` | `/amm/sell` | `{ rpow_base_units, min_usdc_out }` | `{ swap_id, usdc_received, signature }` |
| `POST` | `/amm/lp/add` | `{ rpow_base_units, usdc_base_units, min_lp_out }` | `{ lp_minted, rpow_used, usdc_used, rpow_refunded, usdc_refunded, signature }` |
| `POST` | `/amm/lp/remove` | `{ lp_base_units, min_rpow_out, min_usdc_out }` | `{ rpow_received, usdc_received, signature }` |
| `POST` | `/amm/seed` (admin) | `{ rpow_base_units, usdc_base_units }` | `{ initial_lp, signature }` |
| `GET`  | `/amm/me` | — | `{ usdc_balance, lp_balance, terms_accepted_at, recent_swaps, recent_lp_events }` |
| `GET`  | `/amm/swaps/recent` | — | Public — last 50 swaps for the marquee |
| `POST` | `/amm/deposit-address` | — | `{ wallet, memo }` — the shared Solana wallet + this user's deposit memo |
| `POST` | `/amm/withdraw` | `{ amount_base_units, solana_destination }` | `{ withdrawal_id, state: 'PENDING' }` |

**Error codes** (uniform): `BAD_REQUEST`, `UNAUTHORIZED`, `TERMS_NOT_ACCEPTED`, `INSUFFICIENT_BALANCE` (RPOW), `INSUFFICIENT_USDC`, `POOL_NOT_SEEDED`, `POOL_ALREADY_SEEDED`, `SLIPPAGE_EXCEEDED`, `INVALID_AMOUNT`, `RATE_LIMITED`, `NOT_ADMIN`.

## 8. Signed audit payloads

Each swap and LP event signs an ed25519 payload (mirrors `FlipPayload` / `MatchPayload`):

```ts
interface SwapPayload {
  id: string;
  account_email_hash: string;
  direction: 'BUY' | 'SELL';
  rpow_delta_base_units: bigint;
  usdc_delta_base_units: bigint;
  fee_base_units: bigint;
  pool_rpow_after: bigint;
  pool_usdc_after: bigint;
  created_at: string;
}

interface LpEventPayload {
  id: string;
  account_email_hash: string;
  type: 'ADD' | 'REMOVE';
  rpow_delta_base_units: bigint;
  usdc_delta_base_units: bigint;
  lp_delta_base_units: bigint;
  pool_rpow_after: bigint;
  pool_usdc_after: bigint;
  total_lp_after: bigint;
  created_at: string;
}
```

Signed and stored in the `signature` column on the respective table. Verifiable with `app.config.signingPublicKeyHex`.

## 9. USDC deposit (slice 5)

Shared Solana wallet `AMM_USDC_WALLET_PUBKEY` (env var). Each user gets a unique deposit memo — derived from `users.email` via HMAC truncation to a short opaque code (8 chars).

`POST /amm/deposit-address` returns:
```json
{ "wallet": "<solana_pubkey>", "memo": "abc12345" }
```

UI explicitly says: "Send USDC to this address with this memo. **You MUST include the memo or your deposit will be lost forever.**"

Indexer (a long-running worker `apps/server/src/amm/usdc-indexer.ts`):
- Polls Solana RPC for new signatures to `AMM_USDC_WALLET_PUBKEY` since the last cursor.
- For each tx: filter for SPL USDC transfers TO this wallet. Read the memo program instruction.
- Look up `account_email` from memo via HMAC reverse-lookup table OR by re-deriving the expected memo per user.
- INSERT `usdc_deposits`. UPDATE `users.usdc_base_units += amount`.
- If memo doesn't match any user: log + alert; funds sit unclaimed.
- Cursor advances after each successful batch.

Existential complexity addressed in slice 5 spec, not here.

## 10. USDC withdrawal (slice 6)

`POST /amm/withdraw { amount_base_units, solana_destination }`:
- Validates `solana_destination` is a valid Solana pubkey.
- Validates user has the balance.
- Debits `users.usdc_base_units`, inserts `usdc_withdrawals` row in state `PENDING`.
- Returns immediately.

Background worker `apps/server/src/amm/usdc-withdrawal-worker.ts`:
- Polls `usdc_withdrawals WHERE state = 'PENDING'`.
- For each: build + sign an SPL USDC transfer from the pool wallet to the destination.
- Update state `SENT`, record `solana_signature`.
- On error, set `FAILED` + `failure_reason`. Admin reviews + retries.

Withdrawal rate limits: 1 per minute per user; max 1000 USDC per day per user. Tunable env vars.

## 11. Frontend

New pages on `apps/web/`:
- `/swap` — buy/sell widget with quote preview, slippage settings, "your USDC balance" display.
- `/pool` — pool stats (reserves, total LP, your share, recent swaps marquee), add/remove liquidity forms.
- `/usdc/deposit` — shared address + memo, big warning, instructions.
- `/usdc/withdraw` — withdrawal form.

UI considerations:
- Slippage default 0.5% (encoded as 50 bps in `min_*_out` math).
- Quote refreshes on input change (debounced 300ms) + on pool poll (every 10s).
- Persistent yellow `⚠ GAME — funds at risk` banner above the main panel.
- A footer link on every AMM page: "What is RPOW Pool?" → modal explaining it's a game.

## 12. Slicing

1. **Multi-asset schema + admin USDC credit + terms acceptance** — `users.usdc_base_units`, `users.amm_terms_accepted_at`, `POST /amm/accept-terms`, admin endpoint `POST /amm/admin/credit-usdc { email, amount }` for testing. `/me` includes USDC balance.
2. **Pool + seed + buy/sell** — pool table, swap audit table, `/amm/pool`, `/amm/quote/*`, `/amm/buy`, `/amm/sell`, `/amm/seed` (admin), signed audit. Pure DB.
3. **LP add/remove** — LP balance table, LP event audit, `/amm/lp/add`, `/amm/lp/remove`, `/amm/me`.
4. **Frontend `/swap` + `/pool`** — buy/sell widget, pool page, terms acceptance modal, persistent banner.
5. **Solana USDC deposit indexer** — shared wallet, memo derivation, indexer worker, `/amm/deposit-address`, frontend `/usdc/deposit`.
6. **Solana USDC withdrawal** — `/amm/withdraw`, withdrawal worker, frontend `/usdc/withdraw`.

Each slice ships independently with its own tests + PR. Slices 1-4 are pure DB (zero Solana code), so the AMM can be alpha-tested with manually credited USDC well before the deposit/withdrawal flows are wired up.

## 13. Tests

- `ammMigration.test.ts` — schema sanity.
- `ammPoolMath.test.ts` — math primitives (`isqrt`, `buyOutput`, `sellOutput`, invariant assertions). Pure unit, no DB.
- `ammSeed.test.ts` — admin-only, idempotent, balance burns correctly.
- `ammBuy.test.ts` / `ammSell.test.ts` — happy path, slippage breach, insufficient balance, terms not accepted, pool not seeded.
- `ammLp.test.ts` — add + remove flows, balance accounting, total_lp invariant.
- `ammSigning.test.ts` — payload canonical form, signature roundtrip.
- `ammDeposit.test.ts`, `ammWithdrawal.test.ts` — slices 5 + 6.

## 14. Concurrency model

Every state-changing endpoint:
1. Opens `withTx`.
2. `SELECT ... FOR UPDATE` on `amm_pool WHERE id = 'main'`.
3. Validates inputs against locked reserves.
4. Computes outputs, validates slippage.
5. UPDATES pool reserves + balances + LP table.
6. INSERTs signed audit row.
7. Asserts invariant `R_rpow × R_usdc ≥ old_k`.
8. Commits.

Throw on any failure → withTx rolls back. No partial state.
