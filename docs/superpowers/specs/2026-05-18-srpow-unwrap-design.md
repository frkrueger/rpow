# SRPOW Unwrap — design spec

**Date:** 2026-05-18
**Status:** draft
**Authors:** fred + claude

## 1. Summary

Add a reverse path to the existing SRPOW wrap: let users burn SRPOW on Solana and receive RPOW credit in the off-chain ledger DB. A **5% fee** is taken on every unwrap, swapped inline from SRPOW → SOL via Jupiter, and accumulated in the existing bridge wallet.

Design rules:
- **Sequenced on-chain** (three Solana txs per unwrap), mirroring the existing wrap pattern. No atomic single-tx with partial signing.
- **Inline swap**: the SRPOW → SOL conversion happens within the unwrap request, before the user's RPOW is credited.
- **Swap first, burn last**: gives a clean abort window — if the swap fails we still hold the user's full SRPOW and can refund it.
- **Reuse `srpow_wrap_events`**: the table already has `direction='UNWRAP'` in its CHECK constraint.
- **Reuse the wrap allowlist**: anyone who can wrap can unwrap.

## 2. Goals / non-goals

**In scope:**
- `POST /srpow/unwrap` — user submits an SPL transfer signature and gets RPOW credit (minus 5% fee).
- `GET /srpow/config` — public endpoint exposing the bridge wallet pubkey + mint + min unwrap + slippage cap.
- Migration `035_srpow_unwrap.sql` for two new sig columns and a partial UNIQUE index.
- `UnwrapForm` React component on `/wrap`, gated by `me.wrap_allowed`.
- `BridgeClient` interface extensions: `verifyInboundTransfer`, `swapSrpowForSol`, `burnSrpow` (+ `FakeBridgeClient` mirror).
- Inline Jupiter v6 swap integration.
- Reconcile worker `reconcilePendingUnwraps` at server boot.
- New optional counter `unwrap_fee_burned_srpow_base_units` for accounting visibility.

**Out of scope:**
- Atomic single-tx unwrap (partial signing + Jupiter instruction-level).
- Configurable fee % per user / per amount.
- Withdrawing accumulated SOL to a cold wallet (manual ops handles this for now).
- Multi-asset unwrap (SOL/USDC/etc. only RPOW↔SRPOW).
- Removing the 1/UTC-day rate limit.

## 3. User flow

1. User navigates to `/wrap` and clicks the **Unwrap** tab.
2. Web fetches `GET /srpow/config` for the bridge pubkey and parameters.
3. User enters an amount (in SRPOW). Live preview shows `→ receive 0.95X RPOW (0.05X SRPOW fee, ~$Y in SOL to treasury)`.
4. User clicks **Unwrap**. Phantom prompts to sign an SPL transfer of `X` SRPOW from user's bound wallet to the bridge wallet.
5. Web submits the tx, gets the signature back.
6. Web POSTs `{ signature, amount_base_units, idempotency_key }` to `/srpow/unwrap`.
7. Server verifies the transfer is `finalized`, sender matches `users.solana_wallet`, amount matches, and inbound sig hasn't been used.
8. Server executes (in order): Jupiter swap of `0.05X` SRPOW → SOL → burn of `0.95X` SRPOW → DB tx (credit user `0.95X` RPOW + counter updates) → mark event `CONFIRMED`.
9. Web polls or receives a final result and displays: success + Solscan links, OR failure + reason (and, if applicable, "your X SRPOW was returned").

## 4. Architecture

### 4.1 Flow diagram

Happy path:

```
client                          server                                      Solana
  |                               |                                            |
  | POST /srpow/unwrap            |                                            |
  | { sig, amount, idempotency }  |                                            |
  |------------------------------>|                                            |
  |                               | validate body, allowlist, daily quota      |
  |                               | acquire advisory lock per user             |
  |                               | INSERT srpow_wrap_events                   |
  |                               |   (PENDING, dir=UNWRAP, sig=<inbound>)     |
  |                               |   — UNIQUE on (solana_signature) for       |
  |                               |     direction=UNWRAP catches replay        |
  |                               |                                            |
  |                               | verifyInboundTransfer(sig)                 |
  |                               |------------------------------------------->|
  |                               |<------------------- 'confirmed' (finalized)|
  |                               |                                            |
  |                               | swapSrpowForSol(0.05X)                     |
  |                               |------------------------------------------->|
  |                               |<------------------------- swap_sig         |
  |                               | UPDATE event SET swap_signature=swap_sig   |
  |                               |                                            |
  |                               | burnSrpow(0.95X)                           |
  |                               |------------------------------------------->|
  |                               |<------------------------- burn_sig         |
  |                               | UPDATE event SET burn_signature=burn_sig   |
  |                               |                                            |
  |                               | withTx: INSERT VALID token (0.95X)         |
  |                               |          decrement wrapped_supply (0.95X)  |
  |                               |          UPDATE event status=CONFIRMED     |
  |<------- { CONFIRMED, ... } ---|                                            |
```

**Non-happy paths from the same entry point:**

- `verifyInboundTransfer` returns `pending` → respond `202 { event_id, status: 'PENDING' }`. Row stays PENDING. Reconcile worker re-checks on boot, or client may re-POST with same idempotency_key (returns same event row).
- `verifyInboundTransfer` returns `not_found` / `failed` → UPDATE event status=FAILED with failure_reason, respond 400.
- `verifyInboundTransfer` returns `mismatch` (wrong sender / amount / mint) → UPDATE event status=FAILED, respond 400/403.
- Replay POST with same inbound sig but different idempotency_key → INSERT fails on partial UNIQUE index, respond 409 `INBOUND_SIG_REUSED`.
- Replay POST with same idempotency_key, same params → returns the existing event row (200/202/503 depending on its current status).

### 4.2 Why swap first, burn last

The 5% swap is the only step that has a meaningful failure surface (slippage exceeded, Jupiter outage, liquidity gone). The burn — using our own mint authority — is only ever blocked by transient RPC failures, which retry resolves.

Running swap before burn means: a swap failure leaves the user's full `X` SRPOW in the bridge wallet untouched. We can transfer it back to the user, mark the event REFUNDED, and the on-chain SRPOW supply is unchanged. No invariant violation.

If we burned first, a subsequent swap failure would leave us with 0.95X SRPOW destroyed and no way to give the user back their SRPOW. We'd have to either retry the swap indefinitely (blocking the user) or buy SRPOW back from the open market (unacceptable).

### 4.3 Reconcile worker

`reconcilePendingUnwraps(pool, bridge)` runs at boot alongside `reconcilePendingWraps`. For each `srpow_wrap_events` row with `status='PENDING' AND direction='UNWRAP'`:

| `solana_signature` | `swap_signature` | `burn_signature` | Action |
|---|---|---|---|
| null | — | — | mark `FAILED` (defensive — should never happen because the row is inserted with this column populated) |
| present, status=pending | — | — | leave PENDING; next boot retries |
| present, status=not_found/failed | — | — | mark `FAILED` (transfer didn't actually land) |
| confirmed | null | — | resume from swap step |
| confirmed | present, status=pending/not_found | — | retry swap step |
| confirmed | present, status=failed | — | refund: transfer X SRPOW back to user; mark `REFUNDED` |
| confirmed | confirmed | null | resume from burn step |
| confirmed | confirmed | present, status=pending/not_found | retry burn step |
| confirmed | confirmed | present, status=failed | log + alert; do NOT auto-refund (swap is irreversible) |
| confirmed | confirmed | confirmed | check for credit token; if missing run DB credit step; mark `CONFIRMED` |

## 5. Data model

### 5.1 Migration `035_srpow_unwrap.sql`

```sql
-- Server-initiated sigs for each step of the unwrap flow.
-- solana_signature (already present) stores the user's inbound transfer sig.
ALTER TABLE srpow_wrap_events ADD COLUMN swap_signature TEXT;
ALTER TABLE srpow_wrap_events ADD COLUMN burn_signature TEXT;

-- Each inbound transfer sig credits at most one unwrap.
CREATE UNIQUE INDEX srpow_unwrap_inbound_sig_unique
  ON srpow_wrap_events(solana_signature)
  WHERE direction='UNWRAP' AND solana_signature IS NOT NULL;

-- Optional accounting counter for the burned (95%) portion of unwrap volume.
-- 128 shards to match the supply counters' contention profile.
INSERT INTO app_counters (name, value, shard)
SELECT 'unwrap_fee_burned_srpow_base_units', 0, gs FROM generate_series(0, 127) AS gs
ON CONFLICT (name, shard) DO NOTHING;
```

### 5.2 Event row semantics for `direction='UNWRAP'`

| column | meaning |
|---|---|
| `id` | event UUID |
| `user_email` | the unwrapping user |
| `solana_wallet` | user's bound wallet (also the `from` of the inbound transfer) |
| `amount` | full inbound `X` in SRPOW base units (= RPOW base units, 1:1) |
| `direction` | `UNWRAP` |
| `status` | `PENDING` → `CONFIRMED` / `REFUNDED` / `FAILED` |
| `idempotency_key` | client-supplied; reuses existing UNIQUE constraint |
| `solana_signature` | user's inbound SPL transfer signature (REQUIRED for UNWRAP) |
| `swap_signature` | Jupiter swap sig (filled in during step 2) |
| `burn_signature` | SRPOW burn sig (filled in during step 3) |
| `failure_reason` | populated on REFUNDED / FAILED |
| `created_at`, `updated_at` | timestamps |

The user RPOW credit amount = `0.95 * amount`, computed not stored. The 5% fee = `amount - 0.95 * amount`.

### 5.3 Credit token

On `CONFIRMED`, a fresh row is inserted into `tokens`:
- `id = randomUUID()`
- `owner_email = user_email`
- `value = floor(amount * 95 / 100)` (integer math; 5% goes to the fee)
- `state = 'VALID'`
- `issued_at = now()`
- `server_sig = signTokenPayload({ id, owner_email_hash, value, issued_at }, signingPrivateKeyHex)`
- `wrap_event_id = event.id` (audit linkage)
- `is_change = FALSE`

The existing trigger on `tokens` (migrations 023/026) increments `circulating_supply_base_units` automatically.

## 6. Supply accounting invariants

After a CONFIRMED unwrap of `X`:
- On-chain SRPOW supply decreases by `0.95X` (burn).
- DB `wrapped_supply_base_units` decreases by `0.95X` (manual decrement; sharded UPDATE matching the trigger's pattern).
- DB `circulating_supply_base_units` increases by `0.95X` (trigger fires on the new VALID token INSERT).
- DB `unwrap_fee_burned_srpow_base_units` increases by `0.05X` (manual, sharded).
- The 0.05X SRPOW swapped via Jupiter is now held by some buyer / LP — still circulating on Solana, still counted in `wrapped_supply_base_units`. The invariant on-chain-supply == DB-wrapped is preserved.

The manual `wrapped_supply` decrement does NOT route through the tokens trigger because no specific `tokens` row "represents" the SRPOW being unwrapped — SRPOW is fungible on-chain. Picking a random user's WRAPPED row to INVALIDATE would be misleading audit data. The cost of two writes (one trigger, one manual) is worth the honesty.

Both writes happen in the same `withTx` so they're atomic.

## 7. API surface

### 7.1 `POST /srpow/unwrap`

**Request body:**
```json
{
  "signature": "<base58 inbound SPL transfer sig>",
  "amount_base_units": "<bigint as string>",
  "idempotency_key": "<string, 8-80 chars>"
}
```

**Validation:**
- Session required (`readSession`).
- `isAllowed(app.wrapAllowlist, s.email)` — 403 if not.
- Daily quota: `SELECT count(*) FROM srpow_wrap_events WHERE user_email=$1 AND direction='UNWRAP' AND status NOT IN ('REFUNDED','FAILED') AND created_at::date = current_date AT TIME ZONE 'UTC'` ≥ 1 → 429.
- `amount_base_units` ≥ `SRPOW_UNWRAP_MIN_BASE_UNITS` (default `10^10` = 10 RPOW) and ≤ `10^18`.
- `idempotency_key` matches WrapBody's regex.

**Responses:**
- `200 { ok, event_id, status: 'CONFIRMED', credit_base_units, inbound_signature, swap_signature, burn_signature }`
- `202 { event_id, status: 'PENDING', message }` — inbound sig not yet finalized; client retries
- `400 { error: 'BAD_REQUEST' | 'INSUFFICIENT_AMOUNT' | 'AMOUNT_MISMATCH' | 'TRANSFER_NOT_LANDED' }`
- `403 { error: 'FORBIDDEN' | 'WRONG_SENDER' }`
- `409 { error: 'DUP_DIFFERENT_PARAMS' | 'INBOUND_SIG_REUSED' }`
- `429 { error: 'DAILY_UNWRAP_LIMIT' }`
- `503 { error: 'BRIDGE_FAILED', status: 'REFUNDED', failure_reason }`

### 7.2 `GET /srpow/config`

Returns public unwrap configuration. No auth required.

```json
{
  "bridge_wallet_pubkey": "<base58>",
  "srpow_mint_address": "<base58>",
  "fee_bps": 500,
  "min_unwrap_base_units": "10000000000",
  "max_unwrap_base_units": "1000000000000000000",
  "slippage_bps": 1000
}
```

### 7.3 Existing endpoints

`GET /srpow/events` and `GET /srpow/events/:id` — extend response to include `swap_signature`, `burn_signature` when present. No schema break.

## 8. Bridge client extensions

```ts
export interface VerifyTransferArgs {
  signature: string;
  expectedFrom: string;        // user's bound wallet (base58)
  expectedTo: string;          // bridge wallet (base58)
  expectedAmount: bigint;      // SRPOW base units
  mint: string;                // SRPOW mint pubkey
}
export type VerifyTransferResult =
  | { status: 'confirmed' }     // finalized, all fields match
  | { status: 'pending' }       // known but below finalized
  | { status: 'not_found' }     // unknown to cluster
  | { status: 'failed'; reason: string }
  | { status: 'mismatch'; reason: 'wrong_from' | 'wrong_to' | 'wrong_amount' | 'wrong_mint' };

export type SwapResult =
  | { status: 'confirmed'; signature: string; sol_received_lamports: bigint }
  | { status: 'slippage_exceeded'; quoted_slippage_bps: number }
  | { status: 'failed'; signature: string | null; failureReason: string };

export type BurnResult =
  | { status: 'confirmed'; signature: string }
  | { status: 'failed'; signature: string | null; failureReason: string };

export interface BridgeClient {
  // Existing:
  mintTo(args: MintToArgs, onSignaturePrepared: OnSignaturePrepared): Promise<MintToResult>;
  getSignatureStatus(signature: string): Promise<SignatureStatus>;
  // New:
  verifyInboundTransfer(args: VerifyTransferArgs): Promise<VerifyTransferResult>;
  swapSrpowForSol(
    amountBaseUnits: bigint,
    maxSlippageBps: number,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<SwapResult>;
  burnSrpow(
    amountBaseUnits: bigint,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<BurnResult>;
  // For the refund path:
  transferSrpowFromBridge(
    recipientWallet: string,
    amountBaseUnits: bigint,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<MintToResult>;
}
```

`SolanaBridgeClient` implements all four with the existing `onSignaturePrepared` pattern (pre-persist sig before submit). `FakeBridgeClient` queues responses per-method, exposing per-call assertions.

### 8.1 Jupiter integration

`swapSrpowForSol` uses Jupiter v6:
1. `GET https://quote-api.jup.ag/v6/quote?inputMint=<SRPOW>&outputMint=So11111111111111111111111111111111111111112&amount=<units>&slippageBps=<bps>`
2. If quote shows slippage > `maxSlippageBps`: return `{ status: 'slippage_exceeded' }`
3. `POST https://quote-api.jup.ag/v6/swap` with `userPublicKey=<bridge>`, `wrapAndUnwrapSol=true`
4. Sign + submit the returned tx, await confirmation with the existing timeout pattern, persist sig via callback.

Jupiter routes auto-discover liquidity (likely SRPOW/SOL or SRPOW/USDC/SOL). If no route exists at unwrap-time: treat as `failed` → refund path.

## 9. Configuration / env vars

New (all optional with sane defaults):
- `SRPOW_UNWRAP_MIN_BASE_UNITS` — default `10000000000` (10 RPOW)
- `SRPOW_UNWRAP_SLIPPAGE_BPS` — default `1000` (10%)
- `SRPOW_UNWRAP_FEE_BPS` — default `500` (5%); design assumes a one-knob flat fee
- `JUPITER_API_BASE` — default `https://quote-api.jup.ag`

Reused:
- `WRAP_ALLOWED_EMAILS` — same allowlist controls unwrap.
- `BRIDGE_KEYPAIR_BASE58`, `SRPOW_MINT_ADDRESS`, `SOLANA_RPC_URL` — same wallet, mint, RPC.

## 10. Rate limits + amount bounds

- **1 unwrap per UTC day per account**. Refunded/failed events do not consume the quota.
- **Minimum 10 RPOW** (= `10^10` base units). Configurable; rationale = avoid losing money to Jupiter slippage on dust.
- **Maximum 10^18 base units** (same as wrap).
- **Slippage cap 1000 bps** on the 5% swap. Above this → refund.
- **Same allowlist as wrap** (`WRAP_ALLOWED_EMAILS=*` in prod).

## 11. UI surface

### 11.1 `/wrap` page changes

- Wrap | Unwrap tab toggle at the top of the page (default Wrap).
- `WrapHistory` already reads `direction` — no changes needed. UNWRAP rows render with a different label/color.

### 11.2 New `UnwrapForm.tsx`

Layout mirrors `WrapForm.tsx`:
- **SRPOW balance**: read user's SRPOW ATA via Solana RPC (existing `/solana-rpc` proxy).
- **Amount input** (in SRPOW, displayed in RPOW units).
- **Live preview**:
  ```
  Unwrap 1,000 SRPOW
  → Receive 950 RPOW
  → 50 SRPOW fee swapped to SOL (~$X)
  ```
- **Unwrap button**: builds & sends an SPL transfer via Phantom, then POSTs the sig.
- **Status display**: spinner with per-step labels (verifying → swapping → burning → crediting → done), driven by 1-2s polling of `GET /srpow/events/:id`.
- **Outcome**: success shows the credit + Solscan links to all three sigs. Failure shows the reason and, for REFUNDED, "X SRPOW returned to your wallet" with a link.

### 11.3 `GET /srpow/config` client wiring

New hook `useSrpowConfig()` fetches once per session and caches in React context.

## 12. Testing strategy

Unit + integration tests run against test Postgres + `FakeBridgeClient`.

**Happy path:**
1. User has bound wallet, no daily quota used.
2. POST unwrap with valid inbound sig.
3. `FakeBridgeClient` returns confirmed for verify/swap/burn.
4. Assert: VALID token of `0.95X` inserted, counters moved, event CONFIRMED.

**Failure paths:**
1. **Swap fails (slippage)** → bridge transfers X SRPOW back; event REFUNDED; no daily quota consumed.
2. **Swap fails (Jupiter API error)** → same refund path.
3. **Server crash after swap, before burn** → reboot reconcile resumes burn → eventual CONFIRMED.
4. **Server crash after burn, before DB credit** → reboot reconcile runs the credit step (idempotent on `wrap_event_id`).
5. **Inbound sig still pending** at submit time → 202; second POST after finalize → proceeds normally.
6. **Inbound sig already used** (different idempotency key) → 409 `INBOUND_SIG_REUSED`.
7. **Inbound sig sender mismatch** → 403 `WRONG_SENDER`.
8. **Inbound sig amount mismatch** → 400 `AMOUNT_MISMATCH`.
9. **Below minimum** → 400 `INSUFFICIENT_AMOUNT`.
10. **Above max** → 400 `BAD_REQUEST`.
11. **Daily quota hit** → 429.
12. **Allowlist deny** → 403.
13. **Replay** with same `idempotency_key` and same params → returns existing event (200 if CONFIRMED, 202 if PENDING, 503 if REFUNDED/FAILED).
14. **Replay** with same `idempotency_key` and different params → 409 `DUP_DIFFERENT_PARAMS`.
15. **Burn fails permanently** → operational alert; does NOT auto-refund.
16. **Supply counters** correct after CONFIRMED: `circulating_supply +=0.95X`, `wrapped_supply -=0.95X`.

## 13. Operational considerations

- **Bridge SOL balance**: each unwrap costs ~3 Solana fee payments (~$0.002 in SOL). Monitor via existing healthcheck; alert if balance drops below threshold.
- **Jupiter outage**: design assumes Jupiter is online. If down, unwraps fail at the swap step → refund path → users see a graceful "try again later" message.
- **SRPOW liquidity**: if there's no Jupiter route for SRPOW → SOL at submit time, unwraps fail → refund. This is acceptable; an opaque slow-degrade is preferable to taking on liquidity provision ourselves.
- **Manual SOL sweep**: accumulated SOL in the bridge wallet can be swept by operator to a cold wallet via existing ops procedures. Out of scope for this design.

## 14. Out of scope / future work

- Atomic single-tx unwrap (partial signing with Jupiter instructions).
- Per-user / per-amount fee tiers.
- Withdraw RPOW to SRPOW with a non-1:1 conversion (e.g., if game outcomes change the exchange rate).
- Multi-asset unwrap.
- Removing the daily quota or making it user-tunable.
- Direct SOL withdrawal from the bridge to user wallets (currently a manual process).
