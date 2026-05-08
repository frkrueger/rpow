# SRPOW Wrap — Design Spec

**Status:** Draft, awaiting user review.
**Date:** 2026-05-08.
**Scope:** v1 — wrap rpow → SRPOW SPL token on Solana mainnet, gated by allowlist. Unwrap is **out of scope** for v1, sketched as future work.

## Goal

Let an allowlisted rpow user move N rpow from the centralized server-side ledger into N SRPOW tokens on Solana mainnet, custodied in their Phantom wallet. The two systems together never represent more than 21,000,000 RPOW.

## Non-goals (v1)

- Unwrap (SRPOW → rpow). Sketched at the end.
- Multi-wallet binding per user (one wallet per email, period).
- Background retry workers — auto-refund on failure is the recovery path.
- Public/general rollout — pilot is allowlist-only.
- Transfer fees on rpow `/send`. Fees on rpow stay zero; the satoshi allocation (below) is the only operator-side allocation.

## Values baked in

- **Disclosed satoshi allocation, no further claims.** A one-time pre-allocation of 1,100,000 SRPOW (5.24% of the 21M cap) is minted at launch to a founder-held wallet, vested linearly over 1 year via the Streamflow protocol on Solana. After that allocation, **no further mint authority is exercised by the operator outside the wrap protocol**: the bridge keypair's mint authority is used only by `/srpow/wrap` Phase 2 minting. No transfer fees on rpow, no bridge fees on SRPOW. Stated explicitly on the About page.
- **No warranty.** This is a centralized system; if the server is breached, lost, or seized, tokens may be lost. Stated explicitly on the About page and the WrapPage.
- **Hard 21M cap, never exceeded.** Mineable budget on rpow drops to 19,900,000 to absorb the 1.1M satoshi allocation; total user-visible RPOW (rpow + SRPOW) remains ≤ 21M. See proof in the data-model section.
- **Bitcoin-style halving issuance.** Mining produces fractional rewards in base units (9 decimals, matching SRPOW). Difficulty is fixed at **24 trailing-zero bits** forever. The reward starts at **1/128 RPOW per successful PoW** (= 7,812,500 base units). The reward halves every time `app_counters.minted_supply` crosses a 1,000,000-RPOW boundary: 1/128 → 1/256 → 1/512 → … . Issuance is asymptotic toward the 21M cap; the schedule terminates either at the cap or when the reward-in-base-units drops below 1 (~22 halvings). All amount-bearing endpoints (`/me`, `/send`, `/srpow/wrap`, `/ledger`) operate in base units; the UI formats with 9 decimals. Stated on the About page as "halving issuance, never inflated."

## Architecture

### Decisions baseline

| Decision | Choice |
|---|---|
| Data model | Reuse token-row schema; new `tokens.state` values `LOCKED_FOR_BRIDGE`, `WRAPPED`; new `srpow_wrap_events` log; new `phantom_challenges` table |
| Network | Solana mainnet from day 1 |
| Gating | `WRAP_ALLOWED_EMAILS` env allowlist; initial = `frk314@gmail.com` only |
| SPL mint creation | One-shot script `create-srpow-mint.ts` |
| Decimals | 9 (Solana convention; 1 RPOW = 10⁹ base units of SRPOW) |
| Freeze authority | **Renounced (null)**. Operator cannot freeze SRPOW even in a recovery scenario. Credibility anchor. |
| Mint authority | Bridge keypair only |
| Recovery | Auto-refund on Phase 2 mint failure (60s timeout, no retry worker). One-shot crash-recovery scan at server boot. |
| Wallet binding | Persistent 1:1 (`users.solana_wallet`), set after Phantom signMessage |
| Wrap unit | Integer RPOW only |
| Wrap response | **Synchronous** — HTTP 200 only after Solana confirms or refund completes |
| Solana commitment | **`confirmed`** (~1s); env-tunable to `finalized` (~13s) via `SRPOW_COMMITMENT` |

### New files

```
packages/solana-bridge/
  src/
    constants.ts               // SRPOW decimals, default commitment
    mint.ts                    // SplMintClient: createMint, mintTo, ATA, signature build
    wallet-verify.ts           // Phantom signMessage signature verification
    index.ts
  tests/
    mint.test.ts
    wallet-verify.test.ts
  package.json

apps/server/
  migrations/
    007_srpow_wrap.sql         // tokens.state, users.solana_wallet, srpow_wrap_events,
                               //   phantom_challenges, tokens.wrap_event_id
  src/
    routes/
      phantom.ts               // POST /phantom/challenge, POST /phantom/bind
      srpow.ts                 // POST /srpow/wrap, GET /srpow/events, GET /srpow/events/:id
    wrap-allowlist.ts          // parse WRAP_ALLOWED_EMAILS once at boot
    bridge-keys.ts             // load BRIDGE_KEYPAIR_BASE58
    srpow-reconcile.ts         // boot-time scan of PENDING events
  scripts/
    create-srpow-mint.ts       // one-shot mainnet mint creation
  tests/
    phantom.test.ts
    srpow-wrap.test.ts
    helpers.ts                 // updated to seed allowlist + bridge keys

apps/web/
  src/
    pages/
      WrapPage.tsx             // gated on me.wrap_allowed
    components/
      ConnectPhantom.tsx       // bind handshake (challenge → signMessage → bind)
      WrapForm.tsx             // amount input + wrap action
      WrapHistory.tsx          // list from GET /srpow/events
    hooks/
      usePhantom.ts            // window.solana detection + signMessage
      useSrpow.ts              // wrap action + events list
```

### Modified files

- `apps/server/src/env.ts` — add `SOLANA_RPC_URL`, `SRPOW_MINT_ADDRESS`, `BRIDGE_KEYPAIR_BASE58`, `WRAP_ALLOWED_EMAILS`, `SRPOW_COMMITMENT` (default `confirmed`), `SRPOW_WRAP_TIMEOUT_MS` (default 60000).
- `apps/server/src/buildApp.ts` — register `phantom` and `srpow` route plugins.
- `apps/server/src/server.ts` — call `reconcilePendingWraps()` after migrations, before `listen`.
- `apps/server/src/routes/me.ts` — add `wrap_allowed: boolean`, `solana_wallet: string|null`, `srpow_supply_owned: number` to `/me` response.
- `apps/web/src/{api.ts, App.tsx, package.json}` — add `@solana/web3.js`, `@solana/spl-token`, `bs58`; add `/wrap` route; add typed client methods.

## Data model

### Migration `007_srpow_wrap.sql`

```sql
-- Expand tokens.state.
ALTER TABLE tokens DROP CONSTRAINT tokens_state_check;
ALTER TABLE tokens ADD CONSTRAINT tokens_state_check
  CHECK (state IN ('VALID','INVALIDATED','LOCKED_FOR_BRIDGE','WRAPPED'));

-- Phantom binding (1:1).
ALTER TABLE users ADD COLUMN solana_wallet TEXT UNIQUE;

-- Wrap/unwrap event log.
CREATE TABLE srpow_wrap_events (
  id UUID PRIMARY KEY,
  user_email TEXT NOT NULL,
  solana_wallet TEXT NOT NULL,
  amount INT NOT NULL CHECK (amount > 0),
  direction TEXT NOT NULL CHECK (direction IN ('WRAP','UNWRAP')),
  status TEXT NOT NULL CHECK (status IN ('PENDING','CONFIRMED','FAILED','REFUNDED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  solana_signature TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX srpow_wrap_events_user_idx ON srpow_wrap_events(user_email);
CREATE INDEX srpow_wrap_events_pending_idx ON srpow_wrap_events(status)
  WHERE status='PENDING';

-- Link tokens to the wrap event that put them in their current state.
ALTER TABLE tokens ADD COLUMN wrap_event_id UUID REFERENCES srpow_wrap_events(id);
CREATE INDEX tokens_wrap_event_idx ON tokens(wrap_event_id) WHERE wrap_event_id IS NOT NULL;

-- Phantom challenge nonces.
CREATE TABLE phantom_challenges (
  nonce UUID PRIMARY KEY,
  user_email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX phantom_challenges_user_idx ON phantom_challenges(user_email);
```

### State machine

```
                       /send / /claim
   VALID  ──────────────────────────►  INVALIDATED   (terminal, audit-only)

                      /srpow/wrap (Phase 1: lock)
   VALID  ──────────────────────────►  LOCKED_FOR_BRIDGE
                                                │
                            Phase 2 mint OK     │     mint failed/timeout
                          ┌─────────────────────┤───────────────────┐
                          ▼                     │                   ▼
                       WRAPPED        ◄─────────┴────────         VALID
                                       (refund: clear wrap_event_id)
```

`INVALIDATED` is unchanged and untouched by the SRPOW system. `WRAPPED` rpow rows are never selectable by `/send` or `/mint` (already filtered by `state='VALID'`).

### Hard 21M cap proof

Define:
- `R_total` = total root rpow rows (count where `parent_token_id IS NULL`)
- `R_valid` = count of state=VALID rpow rows
- `R_locked` = count of state=LOCKED_FOR_BRIDGE rpow rows
- `R_wrapped` = count of state=WRAPPED rpow rows
- `S` = SRPOW supply on Solana (sum of all token-account balances for the SRPOW mint, divided by 10⁹)
- `K = 1,100,000` = the one-time satoshi allocation, minted at launch (vested over 1 year via Streamflow on Solana)

Invariants enforced by construction:
1. Wrap is a state change only: `R_total` is unchanged by `/srpow/wrap`.
2. SRPOW is minted in exactly two ways: (a) the one-time satoshi allocation of `K` at launch, and (b) inside Phase 2 of `/srpow/wrap`, in 1:1 ratio with `LOCKED_FOR_BRIDGE → WRAPPED` transitions. Therefore: **`S = K + R_wrapped`**.
3. The cap counter (`app_counters.minted_supply`) is bumped only by `/mint` and `/claim`, both with hard checks against `MINT_MAX_SUPPLY = 19,900,000` (= 21M − K). Wrap doesn't touch it.

Therefore: user-visible RPOW supply (rpow `VALID` + SRPOW on Solana) = `R_valid + S = R_valid + K + R_wrapped ≤ R_total + K ≤ minted_supply + K ≤ 19,900,000 + 1,100,000 = 21,000,000`. ∎

(`R_locked` rpow rows transiently exist during a wrap but are not user-visible — they're "in flight" and resolve to either `VALID` or `WRAPPED` within 60s.)

## Wrap flow

### Phantom binding (one-time per user)

```
POST /phantom/challenge        (auth: session)
  → 200 { nonce, message, expires_at }
  message = `rpow2.com bind: ${nonce}`   (exact UTF-8 bytes user signs)

POST /phantom/bind             (auth: session)
  body: { nonce, wallet_address, signature_base58 }
  → 200 { ok: true, solana_wallet }
  → 400 BAD_SIGNATURE | NONCE_EXPIRED | NONCE_INVALID | WALLET_TAKEN
```

- 5-min nonce TTL, single-use (`used_at` stamped on bind).
- Verify with ed25519 over UTF-8 of the message string (Solana's `signMessage` path).
- `users.solana_wallet` is `UNIQUE` → second user signing with the same wallet gets `WALLET_TAKEN`.
- **Rebinding (changing wallet for an existing user) is not supported in v1.** Out of scope; would require manual DB intervention if absolutely necessary.

### Wrap endpoint

```
POST /srpow/wrap               (auth: session, allowlist-gated, sync)
  body: { amount: int>0, idempotency_key: string<8..80> }
  → 200  { ok: true, event_id, status: 'CONFIRMED', solana_signature }
  → 400  INSUFFICIENT_BALANCE | NO_WALLET_BOUND | BAD_REQUEST
  → 403  FORBIDDEN  (not in WRAP_ALLOWED_EMAILS)
  → 503  BRIDGE_FAILED { event_id, status: 'REFUNDED', failure_reason }
```

**Phase 1 — DB transaction (lock):**
1. Idempotency check on `srpow_wrap_events.idempotency_key`. Same key + same params → return existing event. Same key + different params → 409.
2. `pg_advisory_xact_lock` keyed on user_email (serializes a single user's wraps; doesn't bottleneck globally).
3. `SELECT ... FROM tokens WHERE owner_email=$1 AND state='VALID' ORDER BY issued_at ASC LIMIT $amount FOR UPDATE SKIP LOCKED`.
4. If returned rows < amount → `INSUFFICIENT_BALANCE`.
5. `INSERT srpow_wrap_events` with `status='PENDING'`, `direction='WRAP'`.
6. `UPDATE tokens SET state='LOCKED_FOR_BRIDGE', wrap_event_id=$event_id WHERE id = ANY(...)`.
7. `COMMIT`.

**Phase 2 — Solana mint (outside DB tx, ≤60s budget):**
1. Build `mintTo` instruction (+ `createAssociatedTokenAccount` if missing) for `solana_wallet`, amount × 10⁹ base units.
2. Sign locally with bridge keypair. Compute the tx signature deterministically from the signed message.
3. `UPDATE srpow_wrap_events SET solana_signature=$sig WHERE id=$event_id` **before** submit.
4. Submit, await `confirmed` commitment with `SRPOW_WRAP_TIMEOUT_MS` deadline.
5. **Success:** tx { `UPDATE event SET status='CONFIRMED'`; `UPDATE tokens SET state='WRAPPED' WHERE wrap_event_id=$event_id` }. Return 200.
6. **Failure / timeout:** one final `getSignatureStatus` check using the stored signature.
   - If actually confirmed → treat as success (path 5).
   - Else: tx { `UPDATE event SET status='REFUNDED', failure_reason=$reason`; `UPDATE tokens SET state='VALID', wrap_event_id=NULL WHERE wrap_event_id=$event_id` }. Return 503.

### Crash recovery

`reconcilePendingWraps()` runs once at server boot, after migrations, before `app.listen`:
- `WHERE status='PENDING' AND solana_signature IS NULL` → auto-refund (tx never submitted before crash).
- `WHERE status='PENDING' AND solana_signature IS NOT NULL` → `getSignatureStatus`, resolve to `CONFIRMED` or `REFUNDED`.
- One-shot, not a background loop. If reconciliation itself fails, we log and continue (operator can re-run via service restart).

### Read endpoints

```
GET /srpow/events              (auth)  → [{event}, ...] for user, newest first
GET /srpow/events/:id          (auth, owner-scoped) → single event or 404

event = {
  event_id: string,
  direction: 'WRAP' | 'UNWRAP',
  amount: number,
  status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REFUNDED',
  solana_signature: string | null,
  failure_reason: string | null,
  created_at: string,            // ISO8601
  updated_at: string,
}
```

### `/me` additions

```ts
{
  email: string,
  // ... existing fields ...
  wrap_allowed: boolean,           // email is in WRAP_ALLOWED_EMAILS
  solana_wallet: string | null,    // bound Phantom wallet, or null
  srpow_supply_owned: number,      // count of WRAPPED rpow rows owned
}
```

## Frontend

### Routing

`/wrap` route in `App.tsx`. Hidden from nav unless `me.wrap_allowed === true`. Direct navigation by an unallowed user shows "Not enabled for your account" with no further info.

### `WrapPage.tsx` layout

```
┌──────────────────────────────────────────┐
│  WRAP TO SOLANA (SRPOW)                   │
│                                            │
│  Centralized → on-chain. Once SRPOW is     │
│  minted to your wallet, you control it via │
│  Phantom. The operator takes no fee and    │
│  no warranty is provided. Treat with care. │
├──────────────────────────────────────────┤
│  Phantom: [Connect] | <addr…XYZ>           │
│  RPOW available: 47                        │
│  SRPOW you've wrapped: 3                   │
├──────────────────────────────────────────┤
│  Amount to wrap: [   ]    [ Wrap ]         │
├──────────────────────────────────────────┤
│  RECENT WRAPS                              │
│  2026-05-08  3 RPOW → SRPOW  CONFIRMED ⤴︎  │
│  2026-05-08  1 RPOW → SRPOW  REFUNDED      │
└──────────────────────────────────────────┘
```

### Components

- `ConnectPhantom.tsx` — detects `window.solana`. Click → `connect()` → `POST /phantom/challenge` → `signMessage(message)` → `POST /phantom/bind` → refresh `/me`. Disabled with explainer if Phantom not installed.
- `WrapForm.tsx` — amount input, generates client-side `idempotency_key = randomUUID()`, calls `useSrpow().wrap()`. Inline success or refund banner.
- `WrapHistory.tsx` — list from `GET /srpow/events`. Each `CONFIRMED` row links to `https://solscan.io/tx/<signature>`.

### Hooks

- `usePhantom()` — `connect()`, `disconnect()`, `signMessage()`. Returns `{ wallet: string | null, ready: boolean, installed: boolean }`.
- `useSrpow()` — `wrap(amount): Promise<WrapResult>`, `events: WrapEvent[]`, `refresh()`.

## Mint script

`apps/server/scripts/create-srpow-mint.ts`. Two-step, run **once** locally before any wrap goes live:

**Step 1 — `--init-keys`:**
- Generates a fresh bridge keypair.
- Prints to stdout:
  ```
  BRIDGE_PUBKEY=<base58>           # fund this address on mainnet
  BRIDGE_KEYPAIR_BASE58=<base58>   # save this securely — needed for Step 2 and prod env
  ```
- No on-chain action. Safe to re-run (just generates a new keypair).

**Operator action between steps:** send ≥ 0.05 SOL from a personal Phantom to `BRIDGE_PUBKEY`. This covers the mint creation (~0.002 SOL), 25 first-wrap ATA creations (~0.002 SOL each), and many thousands of subsequent wraps (~5 µSOL each).

**Step 2 — default mode** (requires `BRIDGE_KEYPAIR_BASE58` env from Step 1, and `SOLANA_RPC_URL`):
- Pre-flight: queries the bridge pubkey balance; refuses to run if < 0.005 SOL.
- Refuses to run if `SRPOW_MINT_ADDRESS` is already set in env (prevents duplicate mints from a stray re-run).
- Calls `createMint(connection, payer=bridge, mintAuthority=bridge.publicKey, freezeAuthority=null, decimals=9)`.
- Prints to stdout:
  ```
  SRPOW_MINT_ADDRESS=<base58>
  ```

After the mint exists, the satoshi allocation script (`mint-satoshi-allocation.ts`) is run **once** to mint the 1.1M tribute to the founder-held wallet.

## Satoshi allocation script

`apps/server/scripts/mint-satoshi-allocation.ts`. Hardcoded amount: 1,100,000 SRPOW (= 1.1M × 10⁹ base units). Recipient pubkey via env: `SATOSHI_RECIPIENT_PUBKEY`.

Behavior:
- Pre-flight: queries `getTokenSupply(mint)`. Refuses to run if supply > 0 (i.e., something was already minted — prevents accidental double-allocation).
- Derives the recipient ATA via `getOrCreateAssociatedTokenAccount` (paid by bridge keypair).
- Calls `mintTo(connection, payer=bridge, mint, recipientAta, mintAuthority=bridge, baseUnits=1_100_000n × 10⁹n, ..., {commitment: 'confirmed'})`.
- Prints the tx signature and a Solscan link.

Operator action **after** running this script: open `https://streamflow.finance`, connect the recipient wallet, create a 1-year linear-vesting stream depositing the 1.1M SRPOW. Streamflow handles all vesting math; nothing in our codebase imports the Streamflow SDK.

## Rollout sequence

1. Sign up for a Solana RPC provider (Helius/QuickNode/Triton) and get a mainnet URL.
2. Run `create-srpow-mint.ts --init-keys` locally → record `BRIDGE_PUBKEY` and `BRIDGE_KEYPAIR_BASE58`.
3. Send 0.05 SOL from a personal Phantom to `BRIDGE_PUBKEY`.
4. Run `create-srpow-mint.ts` (default mode) with `BRIDGE_KEYPAIR_BASE58` and `SOLANA_RPC_URL` in env → record `SRPOW_MINT_ADDRESS`. Verify on Solscan: decimals 9, freeze authority null, mint authority = bridge pubkey, supply 0.
5. Run `mint-satoshi-allocation.ts` with `SATOSHI_RECIPIENT_PUBKEY=DG2S4KC3GFFVYGipSZeHDYoWyU8dhkeUqW2bvZcy8DZo` (and `BRIDGE_KEYPAIR_BASE58`, `SOLANA_RPC_URL`, `SRPOW_MINT_ADDRESS` in env). Verify on Solscan: SRPOW supply = 1,100,000.000000000.
6. Open `https://streamflow.finance`, connect the recipient wallet, create a 1-year linear-vesting stream for the 1.1M SRPOW. (Operator action — not scripted.)
7. **Token metadata:**
   1. Upload `apps/web/public/srpow-logo.png` to Arweave (via `irys` CLI paid by bridge keypair, or via app.ardrive.io). Record the Arweave image URL.
   2. Edit `apps/web/public/srpow-token-metadata.template.json`, replace `REPLACE_WITH_ARWEAVE_IMAGE_URL` with the URL from the previous step.
   3. Upload that JSON file to Arweave the same way. Record the Arweave metadata URL.
   4. Run `set-srpow-metadata.ts` with `SRPOW_METADATA_URI=<Arweave metadata URL>` (plus the existing env). Verify on Solscan that `https://solscan.io/token/<SRPOW_MINT_ADDRESS>` now shows the SRPOW name, symbol, and logo.
8. **Update VPS env: change `MINT_MAX_SUPPLY=19900000`** in `/etc/rpow/server.env` (= 21M − 1.1M satoshi allocation).
9. Set the rest of the VPS env (`/etc/rpow/server.env`):
   - `SOLANA_RPC_URL=https://...`
   - `SRPOW_MINT_ADDRESS=<from step 4>`
   - `BRIDGE_KEYPAIR_BASE58=<from step 2>`
   - `WRAP_ALLOWED_EMAILS=frk314@gmail.com`
   - `SRPOW_COMMITMENT=confirmed`
10. Push `srpow-wrap` branch to `main`, run RUNBOOK deploy command, restart `rpow-server`. Migration `007` runs on startup; reconcile worker runs once.
11. Pilot test as `frk314@gmail.com`: bind Phantom, wrap 1 RPOW, verify mint tx on Solscan, verify SRPOW shows up in Phantom **with the correct name, symbol, and logo**.
12. Soak time before broadening the allowlist. No deadline.

## Operational notes

- **Bridge SOL balance.** Monitor manually for v1. Add a follow-up alarm: cron checks balance < 0.01 SOL → email operator. Out of scope for this spec.
- **Solana RPC failure.** Bubbles up as a refund. User sees a refund banner with the failure reason. No silent retries.
- **Bridge keypair compromise.** Worst-case: attacker can mint unbacked SRPOW. Detection: SRPOW Solana supply > count of WRAPPED rpow rows. No automated check in v1; future work to add a ledger-side reconciliation alarm. Mitigation: keypair lives on the VPS (`/etc/rpow/server.env`, mode 0640, owner root:rpow); same blast radius as the database.

## Errors and edge cases

| Scenario | Behavior |
|---|---|
| User not in allowlist | `POST /srpow/wrap` → 403 FORBIDDEN. Frontend hides the `/wrap` route. |
| User has no bound wallet | `POST /srpow/wrap` → 400 NO_WALLET_BOUND. Frontend disables Wrap button until ConnectPhantom completes. |
| Insufficient rpow balance | 400 INSUFFICIENT_BALANCE. |
| Idempotency-key reuse, same params | Returns existing event (no double-wrap). |
| Idempotency-key reuse, different params | 409 BAD_REQUEST. |
| Phantom signMessage canceled by user | Bind handshake aborts client-side; nonce expires unused. No server state created. |
| Solana RPC timeout / mint failure | Auto-refund. Tokens return to `VALID`. Event status `REFUNDED` with reason. User sees inline banner. |
| Server crash mid-Phase-2 | Boot-time `reconcilePendingWraps()` resolves: signature-less PENDING → REFUND; signature-present PENDING → query Solana, resolve. |
| User already has a Phantom wallet bound | Rebinding not supported in v1; manual DB intervention required if necessary. |
| Two users try to bind the same wallet | Second one gets 400 WALLET_TAKEN (UNIQUE constraint on `users.solana_wallet`). |
| Same user re-binds the same wallet they already have | No-op success (idempotent). |

## Future work (sketched, not in v1)

- **Unwrap (`POST /srpow/unwrap`).** Burn SRPOW on Solana (user signs the burn tx via Phantom; server verifies signature on-chain), then `WRAPPED → VALID` server-side. Mirror state machine and error handling of wrap.
- **Bridge-balance alarm.** Cron job on the VPS that pages the operator when bridge SOL drops below threshold.
- **Reconciliation alarm.** Periodic check that SRPOW Solana supply equals count of WRAPPED rpow rows; alert on divergence (would catch a bridge-keypair compromise).
- **Multi-wallet rebinding.** With audit log, possibly with cooldown.

## Open follow-ups (not blockers, recorded for traceability)

- `/claim` mints "root" tokens that prematurely consume `app_counters.minted_supply` in the send-to-new-user round-trip. Doesn't break this design (cap math is conservative), but worth a clean fix before broad rollout. Separate spec/PR.
