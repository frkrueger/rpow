# AMM Slice 5 — USDC deposit (Phantom-link + indexer) design

**Date:** 2026-05-11
**Status:** approved
**Authors:** fred + claude
**Parent spec:** [RPOW Pool design](./2026-05-11-amm-design.md) §9

## 1. Summary

Slice 5 lets a user move USDC from a Solana wallet they control into their RPOW DB balance, and ships the polling indexer that watches on-chain for those deposits.

The original parent spec §9 assumed a **shared deposit wallet + per-user memo** attribution model. This design intentionally **diverges** from that approach. After working through wallet-UX implications, we settled on **sender-pubkey attribution**: a one-time `signMessage` ceremony binds the user's Solana wallet to their RPOW account, after which the indexer attributes any incoming USDC by the structural `authority` field of the SPL transfer instruction — no memo, no possibility of a user "forgetting a step" and losing funds.

Phantom-connect is **mandatory**. Deposits from non-linked wallets (CEX withdrawals, hardware-wallet flows users haven't connected) are recorded but not auto-credited; admin reconciliation handles them as an explicit edge case.

## 2. Goals / non-goals

**In scope:**
- One-time wallet-linking flow (`signMessage` proof of pubkey ownership).
- `/usdc/deposit` page: Phantom/Solflare connect + in-browser deposit tx signing.
- Polling Solana indexer that watches the AMM hot wallet's USDC ATA and credits attributed deposits.
- Retro-attribution: linking a wallet auto-credits any prior unattributed deposits from it.
- Admin endpoint to manually claim unattributed deposits.
- Terms-acceptance modal gating the page (re-uses the slice 1 endpoint, the modal component is new — reusable by slice 4).

**Out of scope:**
- Withdrawal — that's slice 6.
- Multi-wallet linking per user — V1 is exactly one linked pubkey at a time.
- Memo-based attribution.
- Background webhook subscriptions (we use polling; Helius webhook upgrade is a future perf optimization, not V1).
- Manual address copy-paste UX with Solana Pay QR — explicitly removed in favor of mandatory Phantom-connect.
- Per-user deposit rate limits or caps — there is no rate-limitable surface on the *deposit* side (we just observe what lands on-chain).

## 3. Divergence from parent spec §9

The parent AMM design spec calls for:
- Shared wallet + per-user memo
- `POST /amm/deposit-address` returning `{ wallet, memo }`
- `usdc_deposits.memo` column
- A `users.amm_deposit_memo` reverse-lookup column (implied)

Slice 5 **replaces** all of these with:
- Single shared hot wallet, no per-user memo
- `POST /amm/wallet/link-challenge` + `POST /amm/wallet/link-confirm` + `GET /amm/wallet/status` + `POST /amm/wallet/unlink`
- `users.solana_pubkey TEXT UNIQUE NULL` (linked pubkey, set lazily)
- `usdc_deposits.sender_pubkey TEXT NOT NULL` (no `memo` column)

The parent spec's `/amm/deposit-address` endpoint is **not implemented**.

## 4. Architecture & data flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│ USER'S BROWSER  —  /usdc/deposit                                          │
│                                                                            │
│  first time only:                                                          │
│    ① Connect Phantom                                                      │
│    ② GET  /amm/wallet/link-challenge → { message, nonce_envelope }       │
│       signMessage(message) ── Phantom popup                              │
│    ③ POST /amm/wallet/link-confirm { pubkey, signature, nonce_envelope } │
│       server verifies → sets users.solana_pubkey                          │
│       retro-credits any usdc_unattributed_deposits from this pubkey       │
│                                                                            │
│  every deposit:                                                            │
│    ④ enter amount → build USDC transferChecked tx (sender ATA → AMM ATA) │
│    ⑤ signTransaction → broadcast → UI polls /amm/me                       │
└────────────────────────────────────────┬───────────────────────────────────┘
                                         ▼
                       SOLANA — AMM wallet's USDC ATA (9wVg…xxSp)
                                         │
                                         ▼  every 15s (env tunable)
┌──────────────────────────────────────────────────────────────────────────┐
│ VPS  —  systemd unit `rpow-usdc-indexer` (separate from API workers)      │
│                                                                            │
│   1. getSignaturesForAddress(ATA, { until: cursor, commitment: finalized })│
│   2. for each sig → getParsedTransaction → extract SPL transfers to us    │
│      (top-level instructions AND inner instructions / CPI transfers)      │
│   3. authority = sender wallet pubkey  ── from parsed instruction info    │
│   4. SELECT email FROM users WHERE solana_pubkey = authority              │
│        hit  →  withTx: INSERT usdc_deposits + UPDATE users.usdc_base     │
│        miss →  INSERT usdc_unattributed_deposits                          │
│   5. UPDATE amm_indexer_state.last_signature = sig (monotonic forward)    │
└──────────────────────────────────────────────────────────────────────────┘
```

## 5. Database schema — migration `028_amm_deposits.sql`

```sql
-- Slice 5: USDC deposit indexer schema.

ALTER TABLE users
  ADD COLUMN solana_pubkey TEXT UNIQUE NULL;
-- NULL until the user runs the link flow. UNIQUE prevents two accounts
-- from claiming the same on-chain wallet.

CREATE TABLE usdc_deposits (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_email      TEXT NOT NULL REFERENCES users(email),
  amount_base_units  BIGINT NOT NULL CHECK (amount_base_units > 0),
  solana_signature   TEXT NOT NULL UNIQUE,
  sender_pubkey      TEXT NOT NULL,
  block_time         TIMESTAMPTZ,
  credited_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usdc_deposits_account_idx
  ON usdc_deposits(account_email, credited_at DESC);

CREATE TABLE usdc_unattributed_deposits (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_base_units  BIGINT NOT NULL CHECK (amount_base_units > 0),
  solana_signature   TEXT NOT NULL UNIQUE,
  sender_pubkey      TEXT NOT NULL,
  block_time         TIMESTAMPTZ,
  observed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by_email   TEXT NULL REFERENCES users(email),
  claimed_at         TIMESTAMPTZ NULL
);
CREATE INDEX usdc_unattributed_unclaimed_idx
  ON usdc_unattributed_deposits(observed_at DESC)
  WHERE claimed_by_email IS NULL;

CREATE TABLE amm_indexer_state (
  key                TEXT PRIMARY KEY,
  last_signature     TEXT,
  last_run_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO amm_indexer_state(key) VALUES ('usdc_deposits') ON CONFLICT DO NOTHING;
```

**Idempotency invariant:** `solana_signature` is UNIQUE in **both** `usdc_deposits` and `usdc_unattributed_deposits` (in their own tables). The admin claim endpoint enforces cross-table uniqueness at promotion time by doing the INSERT-into-deposits and the UPDATE-of-unattributed in one `withTx`. Replaying the indexer over any sig range is safe because the indexer uses `ON CONFLICT (solana_signature) DO NOTHING`.

## 6. Wallet-link endpoints

All under `/amm/wallet/*`. All require session auth + the existing `requireAmmAllowed` and `requireTermsAccepted` middleware.

### `GET /amm/wallet/status`
```ts
returns: { linked_pubkey: string | null }
```

### `POST /amm/wallet/link-challenge`
```ts
returns: { message: string, nonce_envelope: string }
```
Stateless — no DB table needed. Server generates:
- `nonce` = 16 random bytes, base64url
- `expires_at` = now + 5 min (ISO 8601)
- `message`: human-readable, ends with the nonce and expiry
  ```
  RPOW Pool — link Solana wallet to account

  Email: <session.email>
  Nonce: <nonce>
  Expires: <expires_at>

  Signing this proves you control this wallet.
  No transaction is sent, no fees are paid.
  ```
- `nonce_envelope` = base64url(`email|nonce|expires_at|HMAC-SHA256(AMM_LINK_HMAC_SECRET, email|nonce|expires_at)`)

Frontend passes `message` to `signMessage`, echoes `nonce_envelope` back on confirm.

### `POST /amm/wallet/link-confirm`
```ts
body: {
  pubkey:           string,   // base58
  signature_b58:    string,
  nonce_envelope:   string,
}
returns: {
  linked_pubkey:    string,
  retro_attributed: { count: number, total_base_units: string },
}
errors: CHALLENGE_EXPIRED | BAD_SIGNATURE | ALREADY_LINKED | PUBKEY_IN_USE | INVALID_PUBKEY
```

Steps:
1. Decode envelope, verify HMAC, verify `email == session.email`, verify not expired → else `CHALLENGE_EXPIRED`.
2. Rebuild canonical `message` from envelope's nonce + expiry.
3. `nacl.sign.detached.verify(messageBytes, sig, pubkeyBytes)` → else `BAD_SIGNATURE`.
4. Validate pubkey is a parseable Solana address (`new PublicKey(s)`) → else `INVALID_PUBKEY`.
5. `withTx`:
   - `SELECT solana_pubkey FROM users WHERE email=$1 FOR UPDATE` — if already non-NULL → `ALREADY_LINKED` (force `unlink` first).
   - `UPDATE users SET solana_pubkey=$pubkey WHERE email=$1` — UNIQUE violation → `PUBKEY_IN_USE`.
   - **Retro-attribute:** `SELECT … FROM usdc_unattributed_deposits WHERE sender_pubkey=$pubkey AND claimed_by_email IS NULL FOR UPDATE`. For each: INSERT into `usdc_deposits` (same sig), mark unattributed row `claimed_by_email=$email, claimed_at=now()`, accumulate total. Then a single `UPDATE users SET usdc_base_units = usdc_base_units + $total`.
   - Return `{ linked_pubkey, retro_attributed: { count, total_base_units } }`.

### `POST /amm/wallet/unlink`
```ts
body: {}
returns: { unlinked_pubkey: string | null }
```
Clears `users.solana_pubkey`. Does not touch `usdc_deposits` history. After unlink, subsequent deposits from the same on-chain wallet land in `usdc_unattributed_deposits` (correct — the link no longer exists).

### `POST /amm/admin/claim-unattributed`  (admin only)
```ts
body:    { solana_signature: string, target_email: string }
returns: { credited_email: string, amount_base_units: string }
errors:  NOT_FOUND | ALREADY_CLAIMED | NOT_ADMIN | USER_NOT_FOUND
```
Admin allowlist = `AMM_ADMIN_EMAILS` (slice 1). One `withTx`:
- `SELECT … FOR UPDATE WHERE solana_signature=$1 AND claimed_by_email IS NULL`
- INSERT `usdc_deposits`
- UPDATE `users.usdc_base_units`
- UPDATE the unattributed row (`claimed_by_email`, `claimed_at`) — preserved as an audit trail, never deleted.

### `GET /amm/config`
```ts
returns: {
  usdc_mint:           string,
  amm_wallet_pubkey:   string,
  amm_wallet_ata:      string,
}
```
Public, cacheable (`Cache-Control: public, max-age=300`), no auth. Lets the frontend avoid build-time constants.

## 7. Indexer process

### Files
```
apps/server/src/amm/usdc-indexer-main.ts         — systemd entrypoint
apps/server/src/amm/usdc-indexer.ts              — tick() + helpers (pure-ish, testable)
apps/server/src/amm/usdc-indexer-classifier.ts   — extractUsdcTransfersTo (pure)
```

### Env vars (new in this slice)
| Var | Default | Notes |
|---|---|---|
| `SOLANA_RPC_URL` | required | Helius mainnet URL. Also consumed by `apps/web` as `VITE_SOLANA_RPC_URL`. |
| `AMM_USDC_WALLET_PUBKEY` | required | Set when `gen-amm-hot-wallet.ts --init-keys` ran. |
| `AMM_USDC_WALLET_ATA` | derived | If unset, indexer derives via `getAssociatedTokenAddress` once at boot. Set explicitly in prod. |
| `USDC_MINT_ADDRESS` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | Env-ized so tests can target devnet. |
| `INDEXER_POLL_INTERVAL_MS` | `15000` | |
| `INDEXER_BOOTSTRAP_LIMIT` | `1000` | Max historical sigs to fetch on first run (empty cursor). |
| `AMM_LINK_HMAC_SECRET` | required | 32+ random bytes hex. Used by the API for wallet-link nonce envelopes. |

### Main loop
```ts
async function tick(deps: IndexerDeps) {
  const { pool, rpc, log, ammAta } = deps;
  const cursor = await loadCursor(pool);
  const sigs   = await fetchNewSignatures(rpc, ammAta, cursor);
  if (sigs.length === 0) { await touchCursorTimestamp(pool); return; }

  // sigs are newest-first from RPC; process oldest-first.
  for (const sigInfo of sigs.reverse()) {
    if (sigInfo.err) { log.debug({ sig: sigInfo.signature }, 'skip: failed tx'); continue; }

    const tx = await rpc.getParsedTransaction(sigInfo.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'finalized',
    });
    if (!tx) {
      // RPC inconsistency. Don't advance cursor past this sig; retry next tick.
      log.warn({ sig: sigInfo.signature }, 'parsed tx missing — will retry');
      break;
    }

    for (const t of extractUsdcTransfersTo(tx, ammAta)) {
      await persistTransfer(pool, {
        sig: sigInfo.signature,
        blockTime: sigInfo.blockTime,
        ...t,
      }, log);
    }

    await advanceCursor(pool, sigInfo.signature);
  }
}
```

### Classifier — `extractUsdcTransfersTo(tx, ammAta)`
Pure function. Walks both `tx.transaction.message.instructions` AND `tx.meta.innerInstructions` (CPI). Yields `{ amount: bigint, authority: string }` for each instruction where:
- `program === 'spl-token'` OR `program === 'spl-token-2022'`
- `parsed.type` is `'transfer'` OR `'transferChecked'`
- `parsed.info.destination === ammAta`
- For `transferChecked`: `parsed.info.mint === USDC_MINT_ADDRESS` (sanity guard)

`authority` is the parsed `info.authority` (always present on SPL transfer parsed instructions — the signer that approved the move).

### Persistence — `persistTransfer`
```ts
await withTx(pool, async tx => {
  const user = await tx.queryOne<{ email: string }>(
    'SELECT email FROM users WHERE solana_pubkey = $1 FOR UPDATE',
    [authority]
  );
  if (user) {
    const ins = await tx.query(`
      INSERT INTO usdc_deposits(account_email, amount_base_units, solana_signature, sender_pubkey, block_time)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (solana_signature) DO NOTHING
      RETURNING id
    `, [user.email, amount, sig, authority, blockTime]);
    if (ins.rowCount > 0) {
      await tx.query(
        'UPDATE users SET usdc_base_units = usdc_base_units + $1 WHERE email = $2',
        [amount, user.email]
      );
    }
    return;
  }
  await tx.query(`
    INSERT INTO usdc_unattributed_deposits(amount_base_units, solana_signature, sender_pubkey, block_time)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (solana_signature) DO NOTHING
  `, [amount, sig, authority, blockTime]);
});
```

The `RETURNING id` + rowCount guard ensures we only bump the balance when the deposit row was actually inserted (not a replay).

### Failure handling
- RPC 429 / network error: caller catches, logs warn, returns early. Cursor not advanced. Next tick retries.
- `getParsedTransaction` returns null: log warn, **break** out of the loop without advancing the cursor past this sig. Next tick retries.
- DB error inside `withTx`: rolls back; cursor not advanced past the failing sig.
- A signature that consistently fails to parse after N retries: log error, advance cursor anyway to avoid permanent stall. N is tracked in memory only (not persisted) because the failure mode is almost always transient RPC weirdness.

### Bootstrap (empty cursor)
First run: `getSignaturesForAddress(ata, { limit: INDEXER_BOOTSTRAP_LIMIT })` — no `until`. Process the lot. Wallet is brand-new, so this finishes in one tick.

### Deployment
New systemd unit `rpow-usdc-indexer.service` (file `ops/systemd/rpow-usdc-indexer.service`):
```
[Unit]
Description=RPOW USDC deposit indexer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rpow
WorkingDirectory=/opt/rpow
EnvironmentFile=/etc/rpow/.env
ExecStart=/usr/bin/node --enable-source-maps /opt/rpow/apps/server/dist/amm/usdc-indexer-main.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

## 8. Frontend `/usdc/deposit`

### New deps in `apps/web`
```
@solana/wallet-adapter-base
@solana/wallet-adapter-react
@solana/wallet-adapter-react-ui
@solana/wallet-adapter-phantom
@solana/wallet-adapter-solflare
@solana/spl-token
```
`@solana/web3.js` already present.

### Bundle isolation
The AMM page is lazy-loaded so non-AMM users don't pay for ~150KB of wallet-adapter:
```tsx
const UsdcDepositPage = lazy(() => import('./pages/UsdcDeposit'));
```
The wallet-adapter `ConnectionProvider` + `WalletProvider` live **inside** the lazy chunk (`AmmWalletProviders.tsx`), not at the app root.

### State machine
```
NOT_CONNECTED
  ├─ Connect Phantom ────► CONNECTING
                              ├─ status.linked_pubkey === connected ──► LINKED_READY
                              ├─ status.linked_pubkey === null      ──► NEEDS_LINK
                              └─ mismatch                            ──► PUBKEY_MISMATCH
NEEDS_LINK
  ├─ Link this wallet ─► (link-challenge → signMessage → link-confirm) ─► LINKED_READY
LINKED_READY
  ├─ enter amount, Deposit ─► DEPOSITING ─► AWAITING_CRED ─► CREDITED
TERMS_NOT_ACCEPTED  (orthogonal pre-gate, blocks the whole page)
  ├─ accept ─► (POST /amm/accept-terms) ─► continue
```

### Files
```
apps/web/src/pages/UsdcDeposit.tsx           — the page (lazy entrypoint)
apps/web/src/amm/AmmWalletProviders.tsx      — ConnectionProvider + WalletProvider
apps/web/src/amm/TermsModal.tsx              — reusable by slice 4
apps/web/src/amm/useAmmDeposit.ts            — build + sign + broadcast hook
apps/web/src/amm/useWalletLink.ts            — challenge + signMessage + confirm hook
apps/web/src/api/amm.ts                      — typed fetch helpers
```

### Deposit tx construction
```ts
const conn = useConnection().connection;
const { publicKey, signTransaction } = useWallet();
const config = useAmmConfig();   // from GET /amm/config, cached

const userAta = await getAssociatedTokenAddress(new PublicKey(config.usdc_mint), publicKey);
const ammAta  = new PublicKey(config.amm_wallet_ata);
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();

const ix = createTransferCheckedInstruction(
  userAta, new PublicKey(config.usdc_mint), ammAta, publicKey,
  amountBaseUnits, 6,
);
const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash }).add(ix);
const signed = await signTransaction(tx);
const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
```

After confirm: UI polls `/amm/me` every 4 seconds for up to 90 seconds. When `usdc_base_units` increases by ≥ the deposited amount, transition to CREDITED and show a success line.

### Error UX
- User has 0 SOL: tx fails preflight → toast "Wallet needs a small amount of SOL to pay the network fee (~0.001 SOL)."
- User has 0 USDC: deposit button disabled.
- Connected Phantom pubkey ≠ linked pubkey: warning banner "This wallet isn't the one linked to your account. Disconnect or unlink first."
- Tx fails on chain: toast with the error; nothing in our DB changes.
- Indexer is slow: after 90s, page shows "Indexer is taking longer than expected. Your tx is on-chain at <sig>; the credit will appear automatically when the indexer catches up. Refresh later."

## 9. Tests

| Test file | Coverage |
|---|---|
| `apps/server/tests/ammSlice5Schema.test.ts` | Migration 028 applies; tables and indexes exist; UNIQUE constraints reject duplicates |
| `apps/server/tests/ammWalletLink.test.ts` | Challenge/confirm happy path; expired envelope; tampered HMAC; bad signature; `ALREADY_LINKED`; `PUBKEY_IN_USE`; **retro-attribution credits prior unattributed deposits in one tx** |
| `apps/server/tests/ammWalletUnlink.test.ts` | Unlink clears pubkey; deposit history untouched; re-link to a new pubkey succeeds |
| `apps/server/tests/usdcIndexerClassifier.test.ts` | Pure classifier: top-level SPL transfers, CPI inner-instruction transfers, `transferChecked` mint guard, transfers to other ATAs ignored, failed txs ignored, token-2022 program handled |
| `apps/server/tests/usdcIndexerPersist.test.ts` | ATTRIBUTED + UNATTRIBUTED paths; replay-safe (same sig twice → one credit); concurrent ticks |
| `apps/server/tests/usdcIndexerLoop.test.ts` | Mocked RPC client, full tick: cursor monotonic advance, pagination, RPC failure leaves cursor unchanged, bootstrap with NULL cursor |
| `apps/server/tests/ammAdminClaim.test.ts` | Admin claim: not-admin rejected, atomic promotion, double-claim rejected, audit-trail row preserved |
| `apps/server/tests/ammConfigEndpoint.test.ts` | `/amm/config` returns expected JSON, public, no auth |
| `apps/web/src/pages/UsdcDeposit.test.tsx` | RTL state-machine traversal; terms modal flow; pubkey-mismatch warning; deposit hook with mocked `useWallet` + `fetch` |

Indexer tests stub the RPC at the `Connection` interface (same pattern as `packages/solana-bridge/src/bridge-client.test.ts`). No real Solana calls in CI.

## 10. Deployment runbook

One step at a time on the VPS.

1. Append env vars to `/etc/rpow/.env`:
   ```
   SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
   AMM_USDC_WALLET_PUBKEY=4dqpFtkMJjtt94egCLVESYWxnZm9f7icLLMC3qTzzpdU
   AMM_USDC_WALLET_ATA=9wVgJE1iKnBS8FiSnHc7jXv5Lz6uD819UYxwu7QAxxSp
   AMM_LINK_HMAC_SECRET=<openssl rand -hex 32>
   ```
2. Deploy the new code via the normal deploy path. Migration 028 runs automatically from the API primary at boot.
3. Install the indexer unit:
   ```
   sudo cp ops/systemd/rpow-usdc-indexer.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now rpow-usdc-indexer
   sudo journalctl -u rpow-usdc-indexer -f
   ```
4. Verify the bootstrap log line: `bootstrap fetched=N`, followed by `tick processed=N (attributed=0 unattributed=1)`.
5. Confirm in DB:
   ```sql
   SELECT solana_signature, sender_pubkey, amount_base_units
     FROM usdc_unattributed_deposits;
   -- expect: today's 10 USDC test deposit
   ```
6. Reclaim the 10 USDC. Two equivalent paths:
   - **Easiest:** open `/usdc/deposit`, connect the Phantom wallet that sent the 10 USDC, click "Link this wallet", sign the message. The `retro_attributed` field in the link-confirm response returns `{ count: 1, total_base_units: "10000000" }`. `/me` shows 10 USDC.
   - **Admin path:** `POST /amm/admin/claim-unattributed { solana_signature, target_email }`. Preserves the audit row.

## 11. Files added

```
apps/server/migrations/028_amm_deposits.sql
apps/server/src/amm/usdc-indexer-main.ts
apps/server/src/amm/usdc-indexer.ts
apps/server/src/amm/usdc-indexer-classifier.ts
apps/server/src/amm/wallet-link.ts
apps/server/src/routes/amm/wallet.ts
apps/server/src/routes/amm/config.ts
apps/server/src/routes/amm/admin.ts                  — append claim-unattributed
apps/server/src/routes/amm/index.ts                  — register wallet, config
apps/server/src/env.ts                               — add new env vars
apps/server/src/buildApp.ts                          — wire env → AppConfig
ops/systemd/rpow-usdc-indexer.service
apps/web/src/pages/UsdcDeposit.tsx
apps/web/src/amm/AmmWalletProviders.tsx
apps/web/src/amm/TermsModal.tsx
apps/web/src/amm/useAmmDeposit.ts
apps/web/src/amm/useWalletLink.ts
apps/web/src/api/amm.ts
apps/web/src/App.tsx                                 — lazy route for /usdc/deposit
+ all `*.test.ts(x)` files from §9
```

## 12. Out-of-scope edges, documented

- **Multiple deposits in one tx.** A single Solana tx can contain multiple SPL transfers (e.g. a smart contract batching). The classifier yields one record per matching instruction, so we credit each separately. UNIQUE on `solana_signature` would block the second one — therefore the UNIQUE is **on `solana_signature` only**, and a tx with two transfers to our ATA from two different senders would currently be processed as one row (the first matching instruction's amount + authority). This is acceptable for V1 because real-world deposits are single-instruction Phantom transfers; the failure mode for the unusual case is "the second sender gets nothing", which is conservative (no over-credit). If this comes up in practice, slice 5.1 adds `solana_signature + instruction_index` as the composite key.
- **Reorg risk.** The indexer uses `commitment: 'finalized'` for both `getSignaturesForAddress` and `getParsedTransaction`. Finalized means 32+ confirmations, ~13s; reorg risk is effectively zero. We accept the small confirmation latency in exchange for no rollback logic.
- **Indexer ↔ API split-brain.** Wallet-link writes `users.solana_pubkey` from the API; indexer reads it. If a user links a wallet between two indexer ticks, the deposit they make right after linking will be ATTRIBUTED (the SELECT runs at tick time, not at tx broadcast). If a user *un*links between deposit broadcast and indexer tick, that deposit becomes UNATTRIBUTED — acceptable, user can re-claim via admin.
