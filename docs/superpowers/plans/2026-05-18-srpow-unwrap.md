# SRPOW Unwrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Spec: [`docs/superpowers/specs/2026-05-18-srpow-unwrap-design.md`](../specs/2026-05-18-srpow-unwrap-design.md).

**Goal:** Ship the reverse path — let users burn SRPOW on Solana and receive RPOW credit in the DB, with a 5% fee swapped inline from SRPOW → SOL via Jupiter and accumulated in the bridge wallet.

**Architecture:** Three sequenced Solana txs per unwrap (user inbound transfer + bridge swap + bridge burn) plus a DB credit. Swap-first/burn-last for clean refund semantics. Reuses `srpow_wrap_events` (direction='UNWRAP'), the `BridgeClient` interface (extended), and `WRAP_ALLOWED_EMAILS`.

**Tech Stack:** Postgres 17, Fastify 4, zod, vitest, @solana/web3.js, @solana/spl-token, bs58, React 18 + react-router-dom. Existing patterns: `withTx`, `makeTestApp` test harness, `FakeBridgeClient` for unit-level integration, `srpow-reconcile` for boot recovery, sharded `app_counters`.

---

## File structure

**Create — server:**
- `apps/server/migrations/035_srpow_unwrap.sql` — two new columns + partial UNIQUE index + counter rows
- `apps/server/src/routes/srpow-unwrap.ts` — `POST /srpow/unwrap`, `GET /srpow/config`
- `apps/server/src/srpow-unwrap-reconcile.ts` — boot-time reconcile for direction='UNWRAP'
- `apps/server/tests/srpowUnwrapSchema.test.ts`
- `apps/server/tests/srpowUnwrapValidation.test.ts`
- `apps/server/tests/srpowUnwrapHappyPath.test.ts`
- `apps/server/tests/srpowUnwrapFailure.test.ts`
- `apps/server/tests/srpowUnwrapReconcile.test.ts`
- `apps/server/tests/srpowConfigEndpoint.test.ts`

**Modify — server:**
- `apps/server/src/env.ts` — add `SRPOW_UNWRAP_MIN_BASE_UNITS`, `SRPOW_UNWRAP_SLIPPAGE_BPS`, `SRPOW_UNWRAP_FEE_BPS`, `JUPITER_API_BASE`
- `apps/server/src/buildApp.ts` — add fields to AppConfig + decorate, register `srpowUnwrapRoutes`
- `apps/server/src/server.ts` — boot `reconcilePendingUnwraps` alongside `reconcilePendingWraps`
- `apps/server/src/srpow-reconcile.ts` — narrow query to `direction='WRAP'` only
- `apps/server/src/routes/srpow.ts` — extend `/srpow/events` and `/srpow/events/:id` responses with `swap_signature` + `burn_signature`

**Create — solana-bridge:**
- `packages/solana-bridge/src/jupiter-swap.ts` — pure-ish Jupiter v6 quote + tx assembly
- `packages/solana-bridge/src/jupiter-swap.test.ts`

**Modify — solana-bridge:**
- `packages/solana-bridge/src/bridge-client.ts` — extend `BridgeClient` interface with `verifyInboundTransfer`, `swapSrpowForSol`, `burnSrpow`, `transferSrpowFromBridge`; extend `FakeBridgeClient` + `SolanaBridgeClient`
- `packages/solana-bridge/src/bridge-client.test.ts` — Fake methods tested
- `packages/solana-bridge/src/index.ts` — re-export new types

**Create — web:**
- `apps/web/src/components/UnwrapForm.tsx`
- `apps/web/src/hooks/useSrpowConfig.ts`
- `apps/web/src/lib/srpowBalance.ts` — read SRPOW ATA balance via Solana RPC proxy

**Modify — web:**
- `apps/web/src/pages/WrapPage.tsx` — Wrap | Unwrap tab toggle
- `apps/web/src/components/WrapHistory.tsx` — render UNWRAP rows with distinct label

---

## Conventions for every task

- **Run tests via npm workspaces** (the repo uses npm, NOT pnpm — `pnpm-workspace.yaml` does not exist):
  - Server: `TEST_DATABASE_URL="postgres://postgres:p@localhost:55432/postgres" npm --workspace @rpow/server run test -- <path-from-server-root>`
  - Bridge: `npm --workspace @rpow/solana-bridge run test -- <path-from-bridge-root>`
  - Web: `npm --workspace @rpow/web run test -- <path-from-web-root>`
  - Build: `npm --workspace @rpow/web run build` (no extra args)
  - Wherever this plan says `pnpm --filter X vitest run Y`, translate to the npm form above.
- **Postgres baseline**: server tests require Docker Postgres at `localhost:55432`. Start it with the README command if missing: `docker run --rm -d --name rpow-pg -e POSTGRES_PASSWORD=p -p 55432:5432 postgres:16`.
- **Pre-existing failing tests** in `apps/server/tests/srpow-wrap.test.ts` (4 failures from commit `6f63773` — daily-limit feature shipped without updating idempotency-replay tests). These failures predate this work. Do NOT try to fix them as part of these tasks. When a task touches this file (Task 11, Task 13), only verify the new tests you added pass.
- All server tests use `makeTestApp()` from `apps/server/tests/helpers.ts` which creates an isolated Postgres schema + runs all migrations.
- Commit at the end of each task with this footer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- Reuse: `readSession`, `isAllowed(app.wrapAllowlist, email)`, `withTx`, `signTokenPayload`. Don't reimplement.
- Counter writes use a random shard 0-127, matching the pattern in migration 023/026.

---

## Task 1: Migration 035 — schema for unwrap

**Files:**
- Create: `apps/server/migrations/035_srpow_unwrap.sql`
- Create: `apps/server/tests/srpowUnwrapSchema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/srpowUnwrapSchema.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('migration 035 — srpow_unwrap schema', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('adds swap_signature + burn_signature columns', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const r = await ctx.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='srpow_wrap_events'
          AND column_name IN ('swap_signature','burn_signature')
        ORDER BY column_name`,
    );
    expect(r.rows.map(x => x.column_name)).toEqual(['burn_signature', 'swap_signature']);
  });

  it('enforces UNIQUE on solana_signature for direction=UNWRAP only', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@x'),('b@x')`);

    // Same sig used twice for WRAP is allowed (partial index excludes it).
    await ctx.pool.query(`
      INSERT INTO srpow_wrap_events(id, user_email, solana_wallet, amount, direction, status, idempotency_key, solana_signature)
      VALUES ('00000000-0000-0000-0000-000000000001','a@x','PK1',100,'WRAP','CONFIRMED','k1','SIGX')
    `);
    await expect(ctx.pool.query(`
      INSERT INTO srpow_wrap_events(id, user_email, solana_wallet, amount, direction, status, idempotency_key, solana_signature)
      VALUES ('00000000-0000-0000-0000-000000000002','b@x','PK2',100,'WRAP','CONFIRMED','k2','SIGX')
    `)).resolves.toBeDefined();

    // Same sig for UNWRAP is unique.
    await ctx.pool.query(`
      INSERT INTO srpow_wrap_events(id, user_email, solana_wallet, amount, direction, status, idempotency_key, solana_signature)
      VALUES ('00000000-0000-0000-0000-000000000003','a@x','PK1',100,'UNWRAP','CONFIRMED','k3','SIGY')
    `);
    await expect(ctx.pool.query(`
      INSERT INTO srpow_wrap_events(id, user_email, solana_wallet, amount, direction, status, idempotency_key, solana_signature)
      VALUES ('00000000-0000-0000-0000-000000000004','b@x','PK2',100,'UNWRAP','CONFIRMED','k4','SIGY')
    `)).rejects.toThrow(/unique/i);
  });

  it('seeds 128 shards of unwrap_fee_burned_srpow_base_units at value=0', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const r = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app_counters WHERE name='unwrap_fee_burned_srpow_base_units'`,
    );
    expect(r.rows[0].n).toBe('128');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/server vitest run tests/srpowUnwrapSchema.test.ts`
Expected: FAIL — `column "swap_signature" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- apps/server/migrations/035_srpow_unwrap.sql
-- Adds per-step server-initiated signatures for the unwrap flow + a partial
-- UNIQUE index on the user-submitted inbound transfer sig.
--
-- See docs/superpowers/specs/2026-05-18-srpow-unwrap-design.md.

ALTER TABLE srpow_wrap_events ADD COLUMN swap_signature TEXT;
ALTER TABLE srpow_wrap_events ADD COLUMN burn_signature TEXT;

-- Each inbound transfer sig credits at most one unwrap.
CREATE UNIQUE INDEX srpow_unwrap_inbound_sig_unique
  ON srpow_wrap_events(solana_signature)
  WHERE direction='UNWRAP' AND solana_signature IS NOT NULL;

-- Accounting counter for total SRPOW burned via the unwrap path (excludes
-- the 5% fee portion that went through Jupiter). 128 shards to match the
-- supply counter contention profile.
INSERT INTO app_counters (name, value, shard)
SELECT 'unwrap_fee_burned_srpow_base_units', 0, gs FROM generate_series(0, 127) AS gs
ON CONFLICT (name, shard) DO NOTHING;
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/server vitest run tests/srpowUnwrapSchema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/migrations/035_srpow_unwrap.sql apps/server/tests/srpowUnwrapSchema.test.ts
git commit -m "$(cat <<'EOF'
feat(srpow): migration 035 — unwrap schema

Adds swap_signature + burn_signature columns, partial UNIQUE on
inbound transfer sig for direction=UNWRAP, and the
unwrap_fee_burned_srpow_base_units counter.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: BridgeClient interface + FakeBridgeClient extensions

**Files:**
- Modify: `packages/solana-bridge/src/bridge-client.ts`
- Modify: `packages/solana-bridge/src/bridge-client.test.ts`
- Modify: `packages/solana-bridge/src/index.ts`

- [ ] **Step 1: Write failing tests for FakeBridgeClient extensions**

Append to `packages/solana-bridge/src/bridge-client.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FakeBridgeClient } from './bridge-client.js';

describe('FakeBridgeClient.verifyInboundTransfer', () => {
  it('returns queued status for the given sig', async () => {
    const b = new FakeBridgeClient();
    b.queueInboundVerify({ status: 'confirmed' });
    const r = await b.verifyInboundTransfer({
      signature: 'SIG1', expectedFrom: 'A', expectedTo: 'B',
      expectedAmount: 100n, mint: 'M',
    });
    expect(r.status).toBe('confirmed');
  });
  it('throws if no result queued', async () => {
    const b = new FakeBridgeClient();
    await expect(b.verifyInboundTransfer({
      signature: 'SIG1', expectedFrom: 'A', expectedTo: 'B', expectedAmount: 100n, mint: 'M',
    })).rejects.toThrow(/no inbound verify queued/);
  });
});

describe('FakeBridgeClient.swapSrpowForSol', () => {
  it('returns confirmed swap with SOL received', async () => {
    const b = new FakeBridgeClient();
    b.queueSwapResult({ status: 'confirmed', signature: 'SWAP_SIG', sol_received_lamports: 12345n });
    let prepared: string | null = null;
    const r = await b.swapSrpowForSol(50n, 1000, async (sig) => { prepared = sig; });
    expect(r.status).toBe('confirmed');
    expect(prepared).toBe('SWAP_SIG');
    if (r.status === 'confirmed') {
      expect(r.sol_received_lamports).toBe(12345n);
    }
  });
});

describe('FakeBridgeClient.burnSrpow', () => {
  it('returns confirmed burn and calls onSignaturePrepared', async () => {
    const b = new FakeBridgeClient();
    b.queueBurnResult({ status: 'confirmed', signature: 'BURN_SIG' });
    let prepared: string | null = null;
    const r = await b.burnSrpow(95n, async (sig) => { prepared = sig; });
    expect(r.status).toBe('confirmed');
    expect(prepared).toBe('BURN_SIG');
  });
});

describe('FakeBridgeClient.transferSrpowFromBridge', () => {
  it('reuses the mintTo result queue for the refund path', async () => {
    const b = new FakeBridgeClient();
    b.queueResult({ signature: 'REFUND_SIG' });
    let prepared: string | null = null;
    const r = await b.transferSrpowFromBridge('USER_WALLET', 100n, async (sig) => { prepared = sig; });
    expect(r.status).toBe('confirmed');
    expect(prepared).toBe('REFUND_SIG');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/solana-bridge vitest run src/bridge-client.test.ts`
Expected: FAIL — `b.verifyInboundTransfer is not a function`.

- [ ] **Step 3: Extend the BridgeClient interface + implement Fake**

Edit `packages/solana-bridge/src/bridge-client.ts` — append the new types and methods:

```ts
// ---- Inbound transfer verification (unwrap step 1) -----------------------

export interface VerifyInboundTransferArgs {
  signature: string;
  expectedFrom: string;        // user's bound wallet (base58)
  expectedTo: string;          // bridge wallet (base58)
  expectedAmount: bigint;      // SRPOW base units
  mint: string;                // SRPOW mint pubkey (base58)
}

export type VerifyInboundTransferResult =
  | { status: 'confirmed' }
  | { status: 'pending' }
  | { status: 'not_found' }
  | { status: 'failed'; reason: string }
  | { status: 'mismatch'; reason: 'wrong_from' | 'wrong_to' | 'wrong_amount' | 'wrong_mint' };

// ---- SRPOW → SOL Jupiter swap (unwrap step 2) ----------------------------

export type SwapSrpowForSolResult =
  | { status: 'confirmed'; signature: string; sol_received_lamports: bigint }
  | { status: 'slippage_exceeded'; quoted_slippage_bps: number }
  | { status: 'failed'; signature: string | null; failureReason: string };

// ---- SRPOW burn (unwrap step 3) ------------------------------------------

export type BurnSrpowResult =
  | { status: 'confirmed'; signature: string }
  | { status: 'failed'; signature: string | null; failureReason: string };
```

Extend the `BridgeClient` interface (find the existing interface block and add):

```ts
export interface BridgeClient {
  // ... existing methods ...
  verifyInboundTransfer(args: VerifyInboundTransferArgs): Promise<VerifyInboundTransferResult>;
  swapSrpowForSol(
    amountBaseUnits: bigint,
    maxSlippageBps: number,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<SwapSrpowForSolResult>;
  burnSrpow(
    amountBaseUnits: bigint,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<BurnSrpowResult>;
  transferSrpowFromBridge(
    recipientWallet: string,
    amountBaseUnits: bigint,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<MintToResult>;
}
```

Extend `FakeBridgeClient`:

```ts
export class FakeBridgeClient implements BridgeClient {
  // ... existing fields ...
  private inboundVerifyQueue: VerifyInboundTransferResult[] = [];
  private swapQueue: SwapSrpowForSolResult[] = [];
  private burnQueue: BurnSrpowResult[] = [];
  burnCalls: { amountBaseUnits: bigint }[] = [];
  swapCalls: { amountBaseUnits: bigint; maxSlippageBps: number }[] = [];
  transferFromBridgeCalls: { recipient: string; amountBaseUnits: bigint }[] = [];

  queueInboundVerify(r: VerifyInboundTransferResult): void { this.inboundVerifyQueue.push(r); }
  queueSwapResult(r: SwapSrpowForSolResult): void { this.swapQueue.push(r); }
  queueBurnResult(r: BurnSrpowResult): void { this.burnQueue.push(r); }

  async verifyInboundTransfer(_args: VerifyInboundTransferArgs): Promise<VerifyInboundTransferResult> {
    const next = this.inboundVerifyQueue.shift();
    if (!next) throw new Error('FakeBridgeClient: no inbound verify queued');
    return next;
  }

  async swapSrpowForSol(
    amountBaseUnits: bigint,
    maxSlippageBps: number,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<SwapSrpowForSolResult> {
    this.swapCalls.push({ amountBaseUnits, maxSlippageBps });
    const next = this.swapQueue.shift();
    if (!next) throw new Error('FakeBridgeClient: no swap result queued');
    if (next.status === 'confirmed') {
      try { await onSignaturePrepared(next.signature); }
      catch (e: any) {
        return { status: 'failed', signature: null, failureReason: `pre-submit storage failure: ${e?.message ?? String(e)}` };
      }
    }
    return next;
  }

  async burnSrpow(
    amountBaseUnits: bigint,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<BurnSrpowResult> {
    this.burnCalls.push({ amountBaseUnits });
    const next = this.burnQueue.shift();
    if (!next) throw new Error('FakeBridgeClient: no burn result queued');
    if (next.status === 'confirmed') {
      try { await onSignaturePrepared(next.signature); }
      catch (e: any) {
        return { status: 'failed', signature: null, failureReason: `pre-submit storage failure: ${e?.message ?? String(e)}` };
      }
    }
    return next;
  }

  async transferSrpowFromBridge(
    recipientWallet: string,
    amountBaseUnits: bigint,
    onSignaturePrepared: OnSignaturePrepared,
  ): Promise<MintToResult> {
    this.transferFromBridgeCalls.push({ recipient: recipientWallet, amountBaseUnits });
    // Reuse the existing mintTo queue so test setup is one shape.
    return this.mintTo(
      { recipientWallet, amountBaseUnits },
      onSignaturePrepared,
    );
  }
}
```

Extend `SolanaBridgeClient` with **stub implementations that throw NotImplemented** for now — real implementations come in later tasks:

```ts
async verifyInboundTransfer(_args: VerifyInboundTransferArgs): Promise<VerifyInboundTransferResult> {
  throw new Error('SolanaBridgeClient.verifyInboundTransfer not yet implemented');
}
async swapSrpowForSol(): Promise<SwapSrpowForSolResult> {
  throw new Error('SolanaBridgeClient.swapSrpowForSol not yet implemented');
}
async burnSrpow(): Promise<BurnSrpowResult> {
  throw new Error('SolanaBridgeClient.burnSrpow not yet implemented');
}
async transferSrpowFromBridge(): Promise<MintToResult> {
  throw new Error('SolanaBridgeClient.transferSrpowFromBridge not yet implemented');
}
```

Update `packages/solana-bridge/src/index.ts` to re-export the new types:

```ts
export type {
  VerifyInboundTransferArgs,
  VerifyInboundTransferResult,
  SwapSrpowForSolResult,
  BurnSrpowResult,
} from './bridge-client.js';
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter @rpow/solana-bridge vitest run`
Expected: all existing tests + 4 new ones PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/solana-bridge/src/bridge-client.ts packages/solana-bridge/src/bridge-client.test.ts packages/solana-bridge/src/index.ts
git commit -m "$(cat <<'EOF'
feat(solana-bridge): extend BridgeClient with unwrap methods

Adds verifyInboundTransfer, swapSrpowForSol, burnSrpow,
transferSrpowFromBridge to the interface. FakeBridgeClient gets
queued-result implementations for tests. SolanaBridgeClient gets
NotImplemented stubs to be filled in later tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: SolanaBridgeClient.verifyInboundTransfer

**Files:**
- Modify: `packages/solana-bridge/src/bridge-client.ts`
- Create: `packages/solana-bridge/src/verify-inbound.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/solana-bridge/src/verify-inbound.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Connection } from '@solana/web3.js';
import { SolanaBridgeClient } from './bridge-client.js';

function makeClient(getTransactionImpl: any): SolanaBridgeClient {
  const conn = { getTransaction: getTransactionImpl } as unknown as Connection;
  return new SolanaBridgeClient({
    connection: conn,
    bridge: {} as any,
    mint: { toBase58: () => 'MINT' } as any,
    commitment: 'finalized',
    baseUnitsPerToken: 10n ** 9n,
    timeoutMs: 30000,
  });
}

describe('SolanaBridgeClient.verifyInboundTransfer', () => {
  it("returns 'not_found' when tx is missing", async () => {
    const c = makeClient(vi.fn().mockResolvedValue(null));
    const r = await c.verifyInboundTransfer({
      signature: 'SIG', expectedFrom: 'FROM', expectedTo: 'TO',
      expectedAmount: 100n, mint: 'MINT',
    });
    expect(r.status).toBe('not_found');
  });

  it("returns 'failed' when tx has meta.err", async () => {
    const c = makeClient(vi.fn().mockResolvedValue({
      meta: { err: { InstructionError: [0, 'Custom'] } },
      transaction: { message: { instructions: [] } },
    }));
    const r = await c.verifyInboundTransfer({
      signature: 'SIG', expectedFrom: 'FROM', expectedTo: 'TO',
      expectedAmount: 100n, mint: 'MINT',
    });
    expect(r.status).toBe('failed');
  });

  it("returns 'mismatch wrong_amount' for an SPL transfer of a different amount", async () => {
    const c = makeClient(vi.fn().mockResolvedValue({
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 0, mint: 'MINT', owner: 'FROM', uiTokenAmount: { amount: '1000' } },
          { accountIndex: 1, mint: 'MINT', owner: 'TO',   uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          { accountIndex: 0, mint: 'MINT', owner: 'FROM', uiTokenAmount: { amount: '950' } },
          { accountIndex: 1, mint: 'MINT', owner: 'TO',   uiTokenAmount: { amount: '50' } },
        ],
      },
      transaction: { message: { instructions: [] } },
    }));
    const r = await c.verifyInboundTransfer({
      signature: 'SIG', expectedFrom: 'FROM', expectedTo: 'TO',
      expectedAmount: 100n, mint: 'MINT',  // expected 100, observed 50
    });
    expect(r).toEqual({ status: 'mismatch', reason: 'wrong_amount' });
  });

  it("returns 'confirmed' when SPL token balances change by expected amount", async () => {
    const c = makeClient(vi.fn().mockResolvedValue({
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 0, mint: 'MINT', owner: 'FROM', uiTokenAmount: { amount: '1000' } },
          { accountIndex: 1, mint: 'MINT', owner: 'TO',   uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          { accountIndex: 0, mint: 'MINT', owner: 'FROM', uiTokenAmount: { amount: '900' } },
          { accountIndex: 1, mint: 'MINT', owner: 'TO',   uiTokenAmount: { amount: '100' } },
        ],
      },
      transaction: { message: { instructions: [] } },
    }));
    const r = await c.verifyInboundTransfer({
      signature: 'SIG', expectedFrom: 'FROM', expectedTo: 'TO',
      expectedAmount: 100n, mint: 'MINT',
    });
    expect(r.status).toBe('confirmed');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/solana-bridge vitest run src/verify-inbound.test.ts`
Expected: FAIL — `not yet implemented`.

- [ ] **Step 3: Implement `verifyInboundTransfer` on SolanaBridgeClient**

Replace the stub in `packages/solana-bridge/src/bridge-client.ts`:

```ts
async verifyInboundTransfer(args: VerifyInboundTransferArgs): Promise<VerifyInboundTransferResult> {
  const tx = await this.opts.connection.getTransaction(args.signature, {
    commitment: this.opts.commitment,
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return { status: 'not_found' };
  if (tx.meta?.err) {
    return { status: 'failed', reason: JSON.stringify(tx.meta.err) };
  }

  // Token-balance delta is the cleanest way to verify an SPL transfer in
  // either a legacy or versioned tx, and survives transfer-checked or
  // transfer-with-fee variants.
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  // Find the post-balance entry for the expected destination + mint, and
  // its matching pre-balance (zero if the ATA didn't exist before).
  const postTo = post.find(b => b.mint === args.mint && b.owner === args.expectedTo);
  if (!postTo) return { status: 'mismatch', reason: 'wrong_to' };
  const preTo = pre.find(b =>
    b.accountIndex === postTo.accountIndex && b.mint === args.mint,
  );
  const preToAmount = preTo ? BigInt(preTo.uiTokenAmount.amount) : 0n;
  const delta = BigInt(postTo.uiTokenAmount.amount) - preToAmount;
  if (delta !== args.expectedAmount) {
    return { status: 'mismatch', reason: 'wrong_amount' };
  }

  // Confirm the source debited by the same amount.
  const postFrom = post.find(b => b.mint === args.mint && b.owner === args.expectedFrom);
  if (!postFrom) return { status: 'mismatch', reason: 'wrong_from' };
  const preFrom = pre.find(b =>
    b.accountIndex === postFrom.accountIndex && b.mint === args.mint,
  );
  const preFromAmount = preFrom ? BigInt(preFrom.uiTokenAmount.amount) : 0n;
  if (preFromAmount - BigInt(postFrom.uiTokenAmount.amount) !== args.expectedAmount) {
    return { status: 'mismatch', reason: 'wrong_from' };
  }

  return { status: 'confirmed' };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/solana-bridge vitest run src/verify-inbound.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/solana-bridge/src/bridge-client.ts packages/solana-bridge/src/verify-inbound.test.ts
git commit -m "$(cat <<'EOF'
feat(solana-bridge): verifyInboundTransfer via token-balance delta

Parses pre/postTokenBalances from getTransaction to validate sender,
receiver, mint, and exact amount. Survives transfer/transfer-checked/
versioned-tx variants.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: SolanaBridgeClient.burnSrpow + transferSrpowFromBridge

**Files:**
- Modify: `packages/solana-bridge/src/bridge-client.ts`
- Create: `packages/solana-bridge/src/burn-and-refund.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/solana-bridge/src/burn-and-refund.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { SolanaBridgeClient } from './bridge-client.js';

function makeClient() {
  const conn = {
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: 'BH', lastValidBlockHeight: 1 }),
    sendRawTransaction: vi.fn().mockResolvedValue('SIG'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    getAccountInfo: vi.fn().mockResolvedValue(null),
  } as unknown as Connection;
  return {
    client: new SolanaBridgeClient({
      connection: conn,
      bridge: Keypair.generate(),
      mint: new PublicKey('So11111111111111111111111111111111111111112'),
      commitment: 'finalized',
      baseUnitsPerToken: 10n ** 9n,
      timeoutMs: 30000,
    }),
    conn,
  };
}

describe('SolanaBridgeClient.burnSrpow', () => {
  it('builds a burn tx, calls onSignaturePrepared, awaits confirmation', async () => {
    const { client, conn } = makeClient();
    let prepared: string | null = null;
    const r = await client.burnSrpow(95n, async (sig) => { prepared = sig; });
    expect(r.status).toBe('confirmed');
    expect(prepared).not.toBeNull();
    expect((conn.sendRawTransaction as any)).toHaveBeenCalledOnce();
  });

  it('returns failed when confirmTransaction returns err', async () => {
    const { client, conn } = makeClient();
    (conn.confirmTransaction as any).mockResolvedValue({ value: { err: 'InsufficientFunds' } });
    const r = await client.burnSrpow(95n, async () => {});
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failureReason).toMatch(/InsufficientFunds/);
  });
});

describe('SolanaBridgeClient.transferSrpowFromBridge', () => {
  it('builds a transfer tx and returns confirmed', async () => {
    const { client } = makeClient();
    let prepared: string | null = null;
    const r = await client.transferSrpowFromBridge(
      Keypair.generate().publicKey.toBase58(),
      100n,
      async (sig) => { prepared = sig; },
    );
    expect(r.status).toBe('confirmed');
    expect(prepared).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/solana-bridge vitest run src/burn-and-refund.test.ts`
Expected: FAIL — `not yet implemented`.

- [ ] **Step 3: Implement both methods**

Replace the stubs in `packages/solana-bridge/src/bridge-client.ts`. Both share the existing pattern (build, sign, prepare, submit, confirm with timeout). Add the SPL token instructions import:

```ts
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createBurnInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
```

Implementations:

```ts
async burnSrpow(
  amountBaseUnits: bigint,
  onSignaturePrepared: OnSignaturePrepared,
): Promise<BurnSrpowResult> {
  let signature: string | null = null;
  try {
    // Burn from the bridge's own SRPOW ATA. The bridge IS the mint authority.
    const bridgeAta = getAssociatedTokenAddressSync(this.opts.mint, this.opts.bridge.publicKey);

    const tx = new Transaction();
    tx.add(createBurnInstruction(
      bridgeAta,
      this.opts.mint,
      this.opts.bridge.publicKey,
      amountBaseUnits,
    ));

    const { blockhash, lastValidBlockHeight } =
      await this.opts.connection.getLatestBlockhash(this.opts.commitment);
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.opts.bridge.publicKey;
    tx.sign(this.opts.bridge);

    signature = bs58.encode(tx.signature!);
    await onSignaturePrepared(signature);

    await this.opts.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: this.opts.commitment,
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const confirmPromise = this.opts.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        this.opts.commitment,
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`burn confirmation timeout after ${this.opts.timeoutMs}ms`)),
          this.opts.timeoutMs,
        );
      });
      const c = await Promise.race([confirmPromise, timeoutPromise]);
      if (c.value.err) {
        return { status: 'failed', signature, failureReason: `confirmation err: ${JSON.stringify(c.value.err)}` };
      }
      return { status: 'confirmed', signature };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  } catch (e: any) {
    return { status: 'failed', signature, failureReason: e?.message ?? String(e) };
  }
}

async transferSrpowFromBridge(
  recipientWallet: string,
  amountBaseUnits: bigint,
  onSignaturePrepared: OnSignaturePrepared,
): Promise<MintToResult> {
  const recipient = new PublicKey(recipientWallet);
  let signature: string | null = null;
  try {
    const bridgeAta = getAssociatedTokenAddressSync(this.opts.mint, this.opts.bridge.publicKey);
    const recipientAta = getAssociatedTokenAddressSync(this.opts.mint, recipient);
    const ataInfo = await this.opts.connection.getAccountInfo(recipientAta, this.opts.commitment);

    const tx = new Transaction();
    if (!ataInfo) {
      tx.add(createAssociatedTokenAccountInstruction(
        this.opts.bridge.publicKey, recipientAta, recipient, this.opts.mint,
      ));
    }
    // transfer-checked requires the decimals; SRPOW uses 9 (baseUnitsPerToken=10^9).
    tx.add(createTransferCheckedInstruction(
      bridgeAta, this.opts.mint, recipientAta, this.opts.bridge.publicKey,
      amountBaseUnits, 9,
    ));

    const { blockhash, lastValidBlockHeight } =
      await this.opts.connection.getLatestBlockhash(this.opts.commitment);
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.opts.bridge.publicKey;
    tx.sign(this.opts.bridge);

    signature = bs58.encode(tx.signature!);
    await onSignaturePrepared(signature);

    await this.opts.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: this.opts.commitment,
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const c = await Promise.race([
        this.opts.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight }, this.opts.commitment,
        ),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`refund confirmation timeout after ${this.opts.timeoutMs}ms`)),
            this.opts.timeoutMs,
          );
        }),
      ]);
      if (c.value.err) {
        return { status: 'failed', signature, failureReason: `confirmation err: ${JSON.stringify(c.value.err)}` };
      }
      return { status: 'confirmed', signature };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  } catch (e: any) {
    return { status: 'failed', signature, failureReason: e?.message ?? String(e) };
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/solana-bridge vitest run src/burn-and-refund.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/solana-bridge/src/bridge-client.ts packages/solana-bridge/src/burn-and-refund.test.ts
git commit -m "$(cat <<'EOF'
feat(solana-bridge): burnSrpow + transferSrpowFromBridge

Burn uses the bridge's own ATA + mint authority. Refund path uses
transfer-checked from the bridge ATA to the recipient (auto-creates
ATA when missing). Same onSignaturePrepared + timeout pattern as
mintTo.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Jupiter v6 swap module + SolanaBridgeClient.swapSrpowForSol

**Files:**
- Create: `packages/solana-bridge/src/jupiter-swap.ts`
- Create: `packages/solana-bridge/src/jupiter-swap.test.ts`
- Modify: `packages/solana-bridge/src/bridge-client.ts`

- [ ] **Step 1: Write the failing test for the quote helper**

```ts
// packages/solana-bridge/src/jupiter-swap.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchJupiterQuote, JupiterClient } from './jupiter-swap.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

describe('fetchJupiterQuote', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock as any; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns parsed quote on success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        inputMint: 'SRPOW', outputMint: SOL_MINT,
        inAmount: '50', outAmount: '1234', slippageBps: 50,
        priceImpactPct: '0.012',
      }),
    });
    const q = await fetchJupiterQuote({
      apiBase: 'https://j', inputMint: 'SRPOW', outputMint: SOL_MINT,
      amountBaseUnits: 50n, slippageBps: 1000,
    });
    expect(q.inAmount).toBe('50');
    expect(q.outAmount).toBe('1234');
  });

  it('throws when API returns non-ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'down' });
    await expect(fetchJupiterQuote({
      apiBase: 'https://j', inputMint: 'SRPOW', outputMint: SOL_MINT,
      amountBaseUnits: 50n, slippageBps: 1000,
    })).rejects.toThrow(/jupiter quote failed: 500/);
  });
});

describe('JupiterClient.swap (integration with stubbed fetch + connection)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock as any; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns slippage_exceeded when quote priceImpactPct > cap', async () => {
    // priceImpactPct is a string like '0.15' meaning 15%.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        inputMint: 'SRPOW', outputMint: SOL_MINT,
        inAmount: '50', outAmount: '40', slippageBps: 50, priceImpactPct: '0.15',
      }),
    });
    const conn: any = {};
    const bridge: any = { publicKey: { toBase58: () => 'BRIDGE_PK' } };
    const r = await new JupiterClient({
      apiBase: 'https://j', connection: conn, bridge, commitment: 'finalized', timeoutMs: 30000,
    }).swap({
      inputMint: 'SRPOW', outputMint: SOL_MINT, amountBaseUnits: 50n, maxSlippageBps: 1000,
      onSignaturePrepared: async () => {},
    });
    expect(r.status).toBe('slippage_exceeded');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/solana-bridge vitest run src/jupiter-swap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the Jupiter module**

```ts
// packages/solana-bridge/src/jupiter-swap.ts
import { Connection, Keypair, VersionedTransaction, Commitment } from '@solana/web3.js';
import bs58 from 'bs58';

export const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  slippageBps: number;
  /** Decimal string, e.g. '0.012' = 1.2% price impact. */
  priceImpactPct: string;
}

export interface QuoteArgs {
  apiBase: string;
  inputMint: string;
  outputMint: string;
  amountBaseUnits: bigint;
  slippageBps: number;
}

export async function fetchJupiterQuote(args: QuoteArgs): Promise<JupiterQuote> {
  const url = new URL('/v6/quote', args.apiBase);
  url.searchParams.set('inputMint', args.inputMint);
  url.searchParams.set('outputMint', args.outputMint);
  url.searchParams.set('amount', args.amountBaseUnits.toString());
  url.searchParams.set('slippageBps', String(args.slippageBps));
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`jupiter quote failed: ${res.status} ${body}`);
  }
  return (await res.json()) as JupiterQuote;
}

export type SwapStatus =
  | { status: 'confirmed'; signature: string; sol_received_lamports: bigint }
  | { status: 'slippage_exceeded'; quoted_slippage_bps: number }
  | { status: 'failed'; signature: string | null; failureReason: string };

export interface JupiterClientOpts {
  apiBase: string;
  connection: Connection;
  bridge: Keypair;
  commitment: Commitment;
  timeoutMs: number;
}

export interface SwapArgs {
  inputMint: string;
  outputMint: string;
  amountBaseUnits: bigint;
  maxSlippageBps: number;
  onSignaturePrepared: (signature: string) => Promise<void>;
}

export class JupiterClient {
  constructor(private opts: JupiterClientOpts) {}

  async swap(args: SwapArgs): Promise<SwapStatus> {
    let quote: JupiterQuote;
    try {
      quote = await fetchJupiterQuote({
        apiBase: this.opts.apiBase,
        inputMint: args.inputMint,
        outputMint: args.outputMint,
        amountBaseUnits: args.amountBaseUnits,
        slippageBps: args.maxSlippageBps,
      });
    } catch (e: any) {
      return { status: 'failed', signature: null, failureReason: e?.message ?? String(e) };
    }

    // priceImpactPct is a decimal string. 0.10 = 10% = 1000 bps.
    const impactBps = Math.round(Number(quote.priceImpactPct) * 10000);
    if (impactBps > args.maxSlippageBps) {
      return { status: 'slippage_exceeded', quoted_slippage_bps: impactBps };
    }

    let signature: string | null = null;
    try {
      const swapRes = await fetch(new URL('/v6/swap', this.opts.apiBase).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.opts.bridge.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
        }),
      });
      if (!swapRes.ok) {
        const body = await swapRes.text().catch(() => '');
        return { status: 'failed', signature: null, failureReason: `jupiter swap failed: ${swapRes.status} ${body}` };
      }
      const { swapTransaction } = await swapRes.json() as { swapTransaction: string };

      const raw = Buffer.from(swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(raw);
      tx.sign([this.opts.bridge]);
      signature = bs58.encode(tx.signatures[0]!);
      await args.onSignaturePrepared(signature);

      await this.opts.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false, preflightCommitment: this.opts.commitment,
      });

      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        const { blockhash, lastValidBlockHeight } =
          await this.opts.connection.getLatestBlockhash(this.opts.commitment);
        const confirmPromise = this.opts.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight }, this.opts.commitment,
        );
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`swap confirmation timeout after ${this.opts.timeoutMs}ms`)),
            this.opts.timeoutMs,
          );
        });
        const c = await Promise.race([confirmPromise, timeoutPromise]);
        if (c.value.err) {
          return { status: 'failed', signature, failureReason: `confirmation err: ${JSON.stringify(c.value.err)}` };
        }
        return { status: 'confirmed', signature, sol_received_lamports: BigInt(quote.outAmount) };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } catch (e: any) {
      return { status: 'failed', signature, failureReason: e?.message ?? String(e) };
    }
  }
}
```

Wire `swapSrpowForSol` on `SolanaBridgeClient` to call into `JupiterClient`. The `SolanaBridgeClient` constructor needs the API base:

```ts
// In SolanaBridgeClientOptions, add:
//   jupiterApiBase: string;

// In SolanaBridgeClient, add a private member:
private jupiter: JupiterClient | null = null;

// In the constructor (after super-style setup), lazy-construct on first use.

async swapSrpowForSol(
  amountBaseUnits: bigint,
  maxSlippageBps: number,
  onSignaturePrepared: OnSignaturePrepared,
): Promise<SwapSrpowForSolResult> {
  if (!this.jupiter) {
    this.jupiter = new JupiterClient({
      apiBase: this.opts.jupiterApiBase,
      connection: this.opts.connection,
      bridge: this.opts.bridge,
      commitment: this.opts.commitment,
      timeoutMs: this.opts.timeoutMs,
    });
  }
  const r = await this.jupiter.swap({
    inputMint: this.opts.mint.toBase58(),
    outputMint: 'So11111111111111111111111111111111111111112',
    amountBaseUnits,
    maxSlippageBps,
    onSignaturePrepared,
  });
  return r;
}
```

Add `jupiterApiBase: string` to `SolanaBridgeClientOptions`.

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/solana-bridge vitest run src/jupiter-swap.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/solana-bridge/src/jupiter-swap.ts packages/solana-bridge/src/jupiter-swap.test.ts packages/solana-bridge/src/bridge-client.ts
git commit -m "$(cat <<'EOF'
feat(solana-bridge): Jupiter v6 swap client + SRPOW→SOL wiring

JupiterClient: fetchQuote → priceImpact gate → /v6/swap → submit
versioned tx → confirm. SolanaBridgeClient.swapSrpowForSol delegates
to JupiterClient. New constructor option jupiterApiBase.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Env vars + AppConfig wiring

**Files:**
- Modify: `apps/server/src/env.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/buildApp.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/tests/env.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env as envSchema } from '../src/env.js';

describe('unwrap env vars', () => {
  it('parses SRPOW_UNWRAP_* with defaults', () => {
    const parsed = envSchema.parse({
      DATABASE_URL: 'postgres://x',
      SESSION_SECRET: 'x'.repeat(32),
      MAGIC_LINK_BASE_URL: 'http://x',
      // ... whatever else is required-by-default; copy from an existing passing case
    });
    expect(parsed.SRPOW_UNWRAP_MIN_BASE_UNITS).toBe('10000000000');
    expect(parsed.SRPOW_UNWRAP_SLIPPAGE_BPS).toBe(1000);
    expect(parsed.SRPOW_UNWRAP_FEE_BPS).toBe(500);
    expect(parsed.JUPITER_API_BASE).toBe('https://quote-api.jup.ag');
  });
});
```

(Note: if `env.ts` exports something other than `envSchema`, follow the existing pattern in `tests/env.test.ts`.)

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/server vitest run tests/env.test.ts`
Expected: FAIL — property does not exist.

- [ ] **Step 3: Add the env vars**

In `apps/server/src/env.ts`, inside the zod object, append:

```ts
SRPOW_UNWRAP_MIN_BASE_UNITS: z.string().regex(/^[0-9]+$/).default('10000000000'),
SRPOW_UNWRAP_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10000).default(1000),
SRPOW_UNWRAP_FEE_BPS: z.coerce.number().int().min(0).max(10000).default(500),
JUPITER_API_BASE: z.string().url().default('https://quote-api.jup.ag'),
```

In `apps/server/src/buildApp.ts`, add to `AppConfig`:

```ts
srpowUnwrapMinBaseUnits: bigint;
srpowUnwrapSlippageBps: number;
srpowUnwrapFeeBps: number;
// (jupiterApiBase doesn't go on AppConfig; it goes into SolanaBridgeClient construction)
```

Then in `server.ts`, when constructing `config`:

```ts
srpowUnwrapMinBaseUnits: BigInt(env.SRPOW_UNWRAP_MIN_BASE_UNITS),
srpowUnwrapSlippageBps: env.SRPOW_UNWRAP_SLIPPAGE_BPS,
srpowUnwrapFeeBps: env.SRPOW_UNWRAP_FEE_BPS,
```

…and pass `jupiterApiBase: env.JUPITER_API_BASE` into the `SolanaBridgeClient` constructor next to `mint` / `bridge`.

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/server vitest run tests/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/env.ts apps/server/src/buildApp.ts apps/server/src/server.ts apps/server/tests/env.test.ts
git commit -m "$(cat <<'EOF'
feat(server): env + AppConfig wiring for unwrap params

SRPOW_UNWRAP_MIN_BASE_UNITS, SRPOW_UNWRAP_SLIPPAGE_BPS,
SRPOW_UNWRAP_FEE_BPS, JUPITER_API_BASE. All with defaults so dev
boots clean.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: GET /srpow/config endpoint

**Files:**
- Create: `apps/server/src/routes/srpow-unwrap.ts`
- Create: `apps/server/tests/srpowConfigEndpoint.test.ts`
- Modify: `apps/server/src/buildApp.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/srpowConfigEndpoint.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('GET /srpow/config', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns public unwrap configuration without auth', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/srpow/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      fee_bps: 500,
      min_unwrap_base_units: '10000000000',
      slippage_bps: 1000,
    });
    expect(typeof body.bridge_wallet_pubkey).toBe('string');
    expect(typeof body.srpow_mint_address).toBe('string');
    expect(typeof body.max_unwrap_base_units).toBe('string');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/server vitest run tests/srpowConfigEndpoint.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Create the route file**

```ts
// apps/server/src/routes/srpow-unwrap.ts
import type { FastifyInstance } from 'fastify';

export async function srpowUnwrapRoutes(app: FastifyInstance) {
  app.get('/srpow/config', async () => {
    return {
      bridge_wallet_pubkey: app.config.bridgeWalletPubkey ?? '',
      srpow_mint_address: app.config.srpowMintAddress ?? '',
      fee_bps: app.config.srpowUnwrapFeeBps,
      min_unwrap_base_units: app.config.srpowUnwrapMinBaseUnits.toString(),
      max_unwrap_base_units: (10n ** 18n).toString(),
      slippage_bps: app.config.srpowUnwrapSlippageBps,
    };
  });
}
```

(The route handler depends on two more AppConfig fields — `bridgeWalletPubkey` and `srpowMintAddress`. Add them now.)

In `apps/server/src/buildApp.ts`:

```ts
// In AppConfig:
bridgeWalletPubkey: string | null;
srpowMintAddress: string | null;
```

In `apps/server/src/server.ts` where the SOLANA env vars are conditionally wired:

```ts
const bridgeWalletPubkey = env.BRIDGE_KEYPAIR_BASE58
  ? loadBridgeKeypair(env.BRIDGE_KEYPAIR_BASE58).publicKey.toBase58()
  : null;
// ...add to the config object:
bridgeWalletPubkey,
srpowMintAddress: env.SRPOW_MINT_ADDRESS ?? null,
```

Register the route in `buildApp.ts` next to `srpowRoutes`:

```ts
import { srpowUnwrapRoutes } from './routes/srpow-unwrap.js';
// ...
await app.register(srpowUnwrapRoutes);
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/server vitest run tests/srpowConfigEndpoint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/srpow-unwrap.ts apps/server/src/buildApp.ts apps/server/src/server.ts apps/server/tests/srpowConfigEndpoint.test.ts
git commit -m "$(cat <<'EOF'
feat(srpow): GET /srpow/config public endpoint

Exposes bridge wallet pubkey, mint address, fee_bps, min/max amount,
and slippage cap so the unwrap UI can build the inbound SPL transfer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: POST /srpow/unwrap — validation + INSERT + verify

**Files:**
- Modify: `apps/server/src/routes/srpow-unwrap.ts`
- Create: `apps/server/tests/srpowUnwrapValidation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/srpowUnwrapValidation.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../src/session.js';

async function authedRequest(ctx: any, body: any) {
  const cookie = `${SESSION_COOKIE}=` + signSession({
    email: 'user@x', issued_at: Math.floor(Date.now()/1000),
  }, ctx.config.sessionSecret, SESSION_TTL_SECONDS);
  return ctx.app.inject({
    method: 'POST', url: '/srpow/unwrap',
    headers: { cookie, 'content-type': 'application/json' },
    payload: body,
  });
}

describe('POST /srpow/unwrap validation', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns 401 without session', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'POST', url: '/srpow/unwrap', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when allowlist denies', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: 'other@x' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    const res = await authedRequest(ctx, {
      signature: 'SIG', amount_base_units: '100000000000', idempotency_key: 'k1',
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 when amount below minimum', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    const res = await authedRequest(ctx, {
      signature: 'SIG', amount_base_units: '1', idempotency_key: 'k1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INSUFFICIENT_AMOUNT');
  });

  it('returns 400 when user has no bound wallet', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('user@x')`);  // no solana_wallet
    const res = await authedRequest(ctx, {
      signature: 'SIG', amount_base_units: '10000000000', idempotency_key: 'k1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NO_WALLET_BOUND');
  });

  it('returns 202 PENDING when bridge says inbound sig still pending', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    ctx.bridgeClient.queueInboundVerify({ status: 'pending' });
    const res = await authedRequest(ctx, {
      signature: 'SIG1', amount_base_units: '10000000000', idempotency_key: 'k1',
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('PENDING');
    // Row persisted so a retry is idempotent.
    const { rows } = await ctx.pool.query(`SELECT status, direction FROM srpow_wrap_events`);
    expect(rows[0]).toMatchObject({ status: 'PENDING', direction: 'UNWRAP' });
  });

  it('returns 409 INBOUND_SIG_REUSED when same sig posted with different idempotency_key', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    ctx.bridgeClient.queueInboundVerify({ status: 'pending' });
    await authedRequest(ctx, { signature: 'SIGX', amount_base_units: '10000000000', idempotency_key: 'k1' });
    // Second POST with same sig but different idempotency_key.
    const res = await authedRequest(ctx, { signature: 'SIGX', amount_base_units: '10000000000', idempotency_key: 'k2' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INBOUND_SIG_REUSED');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/server vitest run tests/srpowUnwrapValidation.test.ts`
Expected: FAIL — 404 (route not present yet).

- [ ] **Step 3: Implement the route handler**

Append to `apps/server/src/routes/srpow-unwrap.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readSession } from './auth.js';
import { isAllowed } from '../wrap-allowlist.js';

const UnwrapBody = z.object({
  signature: z.string().min(40).max(120),
  amount_base_units: z.string().regex(/^[1-9][0-9]{0,18}$/),
  idempotency_key: z.string().min(8).max(80),
});

// Inside srpowUnwrapRoutes(app):
app.post('/srpow/unwrap', async (req, reply) => {
  const s = readSession(req as any, app.config.sessionSecret);
  if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
  if (!isAllowed(app.wrapAllowlist, s.email)) {
    return reply.code(403).send({ error: 'FORBIDDEN', message: 'unwrap not enabled for your account' });
  }

  const parsed = UnwrapBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
  const { signature, amount_base_units, idempotency_key } = parsed.data;
  const amount = BigInt(amount_base_units);

  if (amount < app.config.srpowUnwrapMinBaseUnits) {
    return reply.code(400).send({ error: 'INSUFFICIENT_AMOUNT', message: 'below minimum unwrap amount' });
  }
  if (amount > 10n ** 18n) {
    return reply.code(400).send({ error: 'BAD_REQUEST', message: 'amount exceeds maximum' });
  }

  // Idempotency-key replay path: existing event with same key returns its row.
  const dup = await app.pool.query<{
    id: string; amount: string; status: string;
    solana_signature: string | null; swap_signature: string | null; burn_signature: string | null;
    direction: string;
  }>(
    `SELECT id, amount::text AS amount, status, solana_signature, swap_signature, burn_signature, direction
     FROM srpow_wrap_events WHERE idempotency_key=$1`,
    [idempotency_key],
  );
  if (dup.rows[0]) {
    const e = dup.rows[0];
    if (e.direction !== 'UNWRAP' || BigInt(e.amount) !== amount || e.solana_signature !== signature) {
      return reply.code(409).send({ error: 'DUP_DIFFERENT_PARAMS' });
    }
    if (e.status === 'CONFIRMED') {
      return {
        ok: true, event_id: e.id, status: 'CONFIRMED' as const,
        credit_base_units: ((amount * 95n) / 100n).toString(),
        inbound_signature: e.solana_signature, swap_signature: e.swap_signature, burn_signature: e.burn_signature,
      };
    }
    if (e.status === 'PENDING') {
      return reply.code(202).send({ event_id: e.id, status: 'PENDING' as const, message: 'unwrap in progress' });
    }
    return reply.code(503).send({ error: 'BRIDGE_FAILED', event_id: e.id, status: e.status });
  }

  // Resolve user wallet binding.
  const userRow = await app.pool.query<{ solana_wallet: string | null }>(
    `SELECT solana_wallet FROM users WHERE email=$1`, [s.email],
  );
  const wallet = userRow.rows[0]?.solana_wallet;
  if (!wallet) return reply.code(400).send({ error: 'NO_WALLET_BOUND' });

  // Daily quota — excluding REFUNDED/FAILED so a refunded attempt doesn't burn quota.
  const today = new Date().toISOString().slice(0, 10);
  const { rows: countRows } = await app.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM srpow_wrap_events
     WHERE user_email=$1 AND direction='UNWRAP'
       AND status NOT IN ('REFUNDED','FAILED')
       AND created_at::date = $2::date`,
    [s.email, today],
  );
  if ((countRows[0]?.n ?? 0) >= 1) {
    return reply.code(429).send({ error: 'DAILY_UNWRAP_LIMIT', message: '1 unwrap per day; resets at UTC midnight' });
  }

  // INSERT first so we have an event_id even if verification ends up pending.
  // The partial UNIQUE on solana_signature (UNWRAP only) catches sig replays.
  const eventId = randomUUID();
  try {
    await app.pool.query(
      `INSERT INTO srpow_wrap_events
       (id, user_email, solana_wallet, amount, direction, status, idempotency_key, solana_signature)
       VALUES($1,$2,$3,$4,'UNWRAP','PENDING',$5,$6)`,
      [eventId, s.email, wallet, amount.toString(), idempotency_key, signature],
    );
  } catch (e: any) {
    if (String(e?.message ?? '').match(/srpow_unwrap_inbound_sig_unique/)) {
      return reply.code(409).send({ error: 'INBOUND_SIG_REUSED' });
    }
    throw e;
  }

  // Verify the inbound transfer.
  if (!app.config.srpowMintAddress || !app.config.bridgeWalletPubkey) {
    await markFailed(app.pool, eventId, 'srpow not configured');
    return reply.code(503).send({ error: 'BRIDGE_DISABLED' });
  }
  const v = await app.bridgeClient.verifyInboundTransfer({
    signature, expectedFrom: wallet, expectedTo: app.config.bridgeWalletPubkey,
    expectedAmount: amount, mint: app.config.srpowMintAddress,
  });
  if (v.status === 'pending') {
    return reply.code(202).send({ event_id: eventId, status: 'PENDING' as const, message: 'inbound sig not finalized yet, retry shortly' });
  }
  if (v.status === 'not_found') {
    await markFailed(app.pool, eventId, 'inbound sig not_found');
    return reply.code(400).send({ error: 'TRANSFER_NOT_LANDED', event_id: eventId });
  }
  if (v.status === 'failed') {
    await markFailed(app.pool, eventId, `inbound sig failed: ${v.reason}`);
    return reply.code(400).send({ error: 'TRANSFER_NOT_LANDED', event_id: eventId });
  }
  if (v.status === 'mismatch') {
    await markFailed(app.pool, eventId, `inbound mismatch: ${v.reason}`);
    if (v.reason === 'wrong_from') return reply.code(403).send({ error: 'WRONG_SENDER', event_id: eventId });
    return reply.code(400).send({ error: 'AMOUNT_MISMATCH', event_id: eventId });
  }

  // 'confirmed' — proceed to swap+burn+credit. Implemented in Task 9.
  // For now: leave the row PENDING and return 202 so the test passes; real
  // execution path is filled in next task.
  return reply.code(202).send({ event_id: eventId, status: 'PENDING' as const, message: 'unwrap pipeline pending (impl in task 9)' });
});

async function markFailed(pool: import('pg').Pool, eventId: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE srpow_wrap_events SET status='FAILED', failure_reason=$1, updated_at=now() WHERE id=$2`,
    [reason, eventId],
  );
}
```

(The `markFailed` helper is hoisted as a top-level function inside the route file, not nested — adjust scope accordingly when implementing.)

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/server vitest run tests/srpowUnwrapValidation.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/srpow-unwrap.ts apps/server/tests/srpowUnwrapValidation.test.ts
git commit -m "$(cat <<'EOF'
feat(srpow): POST /srpow/unwrap — validation + INSERT + inbound verify

Body validation, allowlist, daily quota, idempotency replay, wallet
binding check, minimum amount. Inserts a PENDING UNWRAP row before
verify so the partial UNIQUE on inbound sig catches replays. Verify
calls into BridgeClient.verifyInboundTransfer; the swap/burn pipeline
is wired in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Swap + burn + credit happy path

**Files:**
- Modify: `apps/server/src/routes/srpow-unwrap.ts`
- Create: `apps/server/tests/srpowUnwrapHappyPath.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/srpowUnwrapHappyPath.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../src/session.js';

describe('POST /srpow/unwrap happy path', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('credits 95% RPOW and updates counters atomically', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);

    ctx.bridgeClient.queueInboundVerify({ status: 'confirmed' });
    ctx.bridgeClient.queueSwapResult({ status: 'confirmed', signature: 'SWAP_SIG', sol_received_lamports: 1234n });
    ctx.bridgeClient.queueBurnResult({ status: 'confirmed', signature: 'BURN_SIG' });

    const before = await ctx.pool.query<{ value: string }>(
      `SELECT coalesce(sum(value),0)::text AS value FROM app_counters WHERE name='wrapped_supply_base_units'`,
    );
    const cookie = `${SESSION_COOKIE}=` + signSession({ email: 'user@x', issued_at: Math.floor(Date.now()/1000) },
      ctx.config.sessionSecret, SESSION_TTL_SECONDS);

    const X = '100000000000'; // 100 RPOW
    const res = await ctx.app.inject({
      method: 'POST', url: '/srpow/unwrap',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { signature: 'INBOUND_SIG', amount_base_units: X, idempotency_key: 'k1' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('CONFIRMED');
    expect(body.credit_base_units).toBe((BigInt(X) * 95n / 100n).toString());

    // Bridge was called for swap (5%) and burn (95%) with the right amounts.
    expect(ctx.bridgeClient.swapCalls[0].amountBaseUnits).toBe(BigInt(X) * 5n / 100n);
    expect(ctx.bridgeClient.burnCalls[0].amountBaseUnits).toBe(BigInt(X) * 95n / 100n);

    // Event marked CONFIRMED with all three sigs.
    const { rows: ev } = await ctx.pool.query(`SELECT * FROM srpow_wrap_events`);
    expect(ev[0]).toMatchObject({
      status: 'CONFIRMED', direction: 'UNWRAP',
      solana_signature: 'INBOUND_SIG', swap_signature: 'SWAP_SIG', burn_signature: 'BURN_SIG',
    });

    // User got a fresh VALID token for 0.95X.
    const { rows: tokens } = await ctx.pool.query(
      `SELECT value::text AS value, state, wrap_event_id, is_change FROM tokens WHERE owner_email='user@x'`,
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      value: (BigInt(X) * 95n / 100n).toString(),
      state: 'VALID',
      is_change: false,
    });

    // wrapped_supply decreased by 0.95X.
    const after = await ctx.pool.query<{ value: string }>(
      `SELECT coalesce(sum(value),0)::text AS value FROM app_counters WHERE name='wrapped_supply_base_units'`,
    );
    expect(BigInt(before.rows[0].value) - BigInt(after.rows[0].value)).toBe(BigInt(X) * 95n / 100n);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/server vitest run tests/srpowUnwrapHappyPath.test.ts`
Expected: FAIL — status 202 not 200, missing credit.

- [ ] **Step 3: Replace the "impl in task 9" placeholder with the real pipeline**

In `apps/server/src/routes/srpow-unwrap.ts`, replace the placeholder return at the end of the handler with:

```ts
// 'confirmed' — execute the pipeline.
const feeAmount = (amount * BigInt(app.config.srpowUnwrapFeeBps)) / 10000n;
const burnAmount = amount - feeAmount;

// Step 2: swap 5% SRPOW for SOL via Jupiter.
const swapResult = await app.bridgeClient.swapSrpowForSol(
  feeAmount, app.config.srpowUnwrapSlippageBps,
  async (sig) => {
    await app.pool.query(
      `UPDATE srpow_wrap_events SET swap_signature=$1, updated_at=now() WHERE id=$2`,
      [sig, eventId],
    );
  },
);
if (swapResult.status !== 'confirmed') {
  // Failure path: refund. Implemented in Task 10.
  return await refundUnwrap(app, eventId, wallet, amount, swapResult);
}

// Step 3: burn 95% SRPOW from the bridge's own ATA.
const burnResult = await app.bridgeClient.burnSrpow(
  burnAmount,
  async (sig) => {
    await app.pool.query(
      `UPDATE srpow_wrap_events SET burn_signature=$1, updated_at=now() WHERE id=$2`,
      [sig, eventId],
    );
  },
);
if (burnResult.status !== 'confirmed') {
  // Burn failures should normally retry via reconcile. For now, mark event
  // as PENDING and let the reconcile worker handle it. Return 202.
  return reply.code(202).send({
    event_id: eventId, status: 'PENDING' as const,
    message: 'burn pending; reconcile will retry',
  });
}

// Step 4: credit user + update counters in a single tx.
await creditUserAndUpdateCounters(app.pool, app.config.signingPrivateKeyHex,
  eventId, s.email, burnAmount, feeAmount);

return {
  ok: true, event_id: eventId, status: 'CONFIRMED' as const,
  credit_base_units: burnAmount.toString(),
  inbound_signature: signature, swap_signature: swapResult.signature, burn_signature: burnResult.signature,
};
```

Add the helper functions at the bottom of `apps/server/src/routes/srpow-unwrap.ts`:

```ts
import { createHash, randomUUID as randomUUID2 } from 'node:crypto';
import { withTx } from '../db.js';
import { signTokenPayload } from '../signing.js';

async function creditUserAndUpdateCounters(
  pool: any,
  signingPrivateKeyHex: string,
  eventId: string,
  userEmail: string,
  creditAmount: bigint,  // 0.95X
  feeBurnedAmount: bigint, // 0.05X (for the fee counter)
): Promise<void> {
  await withTx(pool, async (c) => {
    const tokenId = randomUUID2();
    const issuedAt = new Date();
    const ownerHash = createHash('sha256').update(userEmail).digest('hex');
    const sig = signTokenPayload(
      { id: tokenId, owner_email_hash: ownerHash, value: creditAmount, issued_at: issuedAt.toISOString() },
      signingPrivateKeyHex,
    );
    // Trigger on tokens INSERT increments circulating_supply automatically.
    await c.query(
      `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig, wrap_event_id, is_change)
       VALUES($1, $2, $3, 'VALID', $4, $5, $6, FALSE)`,
      [tokenId, userEmail, creditAmount.toString(), issuedAt, sig, eventId],
    );

    // Manually decrement wrapped_supply_base_units (no specific WRAPPED token
    // "represents" the SRPOW being unwrapped — fungible on-chain).
    const wrappedShard = Math.floor(Math.random() * 128);
    await c.query(
      `UPDATE app_counters SET value = value - $1
       WHERE name='wrapped_supply_base_units' AND shard=$2`,
      [creditAmount.toString(), wrappedShard],
    );

    // Bump the unwrap fee counter (informational only).
    const feeShard = Math.floor(Math.random() * 128);
    await c.query(
      `UPDATE app_counters SET value = value + $1
       WHERE name='unwrap_fee_burned_srpow_base_units' AND shard=$2`,
      [feeBurnedAmount.toString(), feeShard],
    );

    await c.query(
      `UPDATE srpow_wrap_events SET status='CONFIRMED', updated_at=now() WHERE id=$1`,
      [eventId],
    );
  });
}

// Stub — Task 10 fills this in.
async function refundUnwrap(
  app: any, eventId: string, wallet: string, amount: bigint, _swap: any,
): Promise<any> {
  await app.pool.query(
    `UPDATE srpow_wrap_events SET status='REFUNDED', failure_reason='swap_failed', updated_at=now() WHERE id=$1`,
    [eventId],
  );
  return { code: 503, body: { error: 'BRIDGE_FAILED', event_id: eventId, status: 'REFUNDED' as const } };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/server vitest run tests/srpowUnwrapHappyPath.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/srpow-unwrap.ts apps/server/tests/srpowUnwrapHappyPath.test.ts
git commit -m "$(cat <<'EOF'
feat(srpow): unwrap pipeline — swap + burn + credit happy path

After verify=confirmed: Jupiter swap 5% → burn 95% → DB tx that
inserts a VALID token (trigger bumps circulating), decrements
wrapped_supply manually (no representative WRAPPED row to move),
increments the unwrap fee counter, and marks event CONFIRMED.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Refund path (swap failure) + FAILED paths

**Files:**
- Modify: `apps/server/src/routes/srpow-unwrap.ts`
- Create: `apps/server/tests/srpowUnwrapFailure.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/srpowUnwrapFailure.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../src/session.js';

async function unwrap(ctx: any, payload: any) {
  const cookie = `${SESSION_COOKIE}=` + signSession({ email: 'user@x', issued_at: Math.floor(Date.now()/1000) },
    ctx.config.sessionSecret, SESSION_TTL_SECONDS);
  return ctx.app.inject({
    method: 'POST', url: '/srpow/unwrap',
    headers: { cookie, 'content-type': 'application/json' },
    payload,
  });
}

describe('POST /srpow/unwrap failure paths', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('refunds when Jupiter swap returns slippage_exceeded', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    ctx.bridgeClient.queueInboundVerify({ status: 'confirmed' });
    ctx.bridgeClient.queueSwapResult({ status: 'slippage_exceeded', quoted_slippage_bps: 1500 });
    // Refund: transferSrpowFromBridge → uses mintTo's queue under the hood.
    ctx.bridgeClient.queueResult({ signature: 'REFUND_SIG' });

    const res = await unwrap(ctx, {
      signature: 'INBOUND_SIG', amount_base_units: '100000000000', idempotency_key: 'k1',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'BRIDGE_FAILED', status: 'REFUNDED' });

    // Refund call went out to the user's wallet for the full amount.
    expect(ctx.bridgeClient.transferFromBridgeCalls[0]).toEqual({
      recipient: 'USER_PK', amountBaseUnits: 100000000000n,
    });
    const { rows: ev } = await ctx.pool.query(`SELECT status, failure_reason FROM srpow_wrap_events`);
    expect(ev[0].status).toBe('REFUNDED');
    expect(ev[0].failure_reason).toMatch(/slippage/i);

    // No tokens credited to user.
    const { rows: tokens } = await ctx.pool.query(`SELECT count(*)::int AS n FROM tokens WHERE owner_email='user@x'`);
    expect(tokens[0].n).toBe(0);
  });

  it('returns 400 + marks FAILED when inbound sig was failed on-chain', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    ctx.bridgeClient.queueInboundVerify({ status: 'failed', reason: 'InstructionError' });

    const res = await unwrap(ctx, {
      signature: 'INBOUND_SIG', amount_base_units: '100000000000', idempotency_key: 'k1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('TRANSFER_NOT_LANDED');
    const { rows } = await ctx.pool.query(`SELECT status FROM srpow_wrap_events`);
    expect(rows[0].status).toBe('FAILED');
  });

  it('returns 403 WRONG_SENDER on mismatch=wrong_from', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);
    ctx.bridgeClient.queueInboundVerify({ status: 'mismatch', reason: 'wrong_from' });
    const res = await unwrap(ctx, {
      signature: 'INBOUND_SIG', amount_base_units: '100000000000', idempotency_key: 'k1',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('WRONG_SENDER');
  });

  it('refunded events do not consume daily quota', async () => {
    const ctx = await makeTestApp({ wrapAllowlistCsv: '*' }); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('user@x', 'USER_PK')`);

    // First call: refunded.
    ctx.bridgeClient.queueInboundVerify({ status: 'confirmed' });
    ctx.bridgeClient.queueSwapResult({ status: 'slippage_exceeded', quoted_slippage_bps: 9999 });
    ctx.bridgeClient.queueResult({ signature: 'REFUND_SIG_1' });
    await unwrap(ctx, { signature: 'SIG1', amount_base_units: '100000000000', idempotency_key: 'k1' });

    // Second call same day: should succeed (not quota-limited).
    ctx.bridgeClient.queueInboundVerify({ status: 'confirmed' });
    ctx.bridgeClient.queueSwapResult({ status: 'confirmed', signature: 'SWAP_2', sol_received_lamports: 100n });
    ctx.bridgeClient.queueBurnResult({ status: 'confirmed', signature: 'BURN_2' });
    const res = await unwrap(ctx, { signature: 'SIG2', amount_base_units: '100000000000', idempotency_key: 'k2' });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/server vitest run tests/srpowUnwrapFailure.test.ts`
Expected: FAIL on the refund test (Fake's missing burn queue) and on the refund-doesn't-consume-quota path.

- [ ] **Step 3: Implement the real `refundUnwrap` helper**

Replace the stub in `apps/server/src/routes/srpow-unwrap.ts`:

```ts
async function refundUnwrap(
  app: any, eventId: string, wallet: string, amount: bigint,
  swapResult: { status: string; quoted_slippage_bps?: number; failureReason?: string },
): Promise<{ code: number; body: any }> {
  // Reason string surfaced to the user via failure_reason.
  const reason = swapResult.status === 'slippage_exceeded'
    ? `swap_failed: slippage_exceeded (${swapResult.quoted_slippage_bps} bps)`
    : `swap_failed: ${(swapResult as any).failureReason ?? 'unknown'}`;

  // Send the full X SRPOW back to the user's wallet from the bridge's own ATA.
  const refund = await app.bridgeClient.transferSrpowFromBridge(
    wallet, amount,
    async (sig) => {
      await app.pool.query(
        `UPDATE srpow_wrap_events SET burn_signature=$1, updated_at=now() WHERE id=$2`,
        [sig, eventId],
      );
      // burn_signature reused for refund sig — operational compromise to avoid
      // a 4th sig column; the failure_reason makes the role unambiguous.
    },
  );

  if (refund.status !== 'confirmed') {
    // Refund itself failed — leave the event PENDING and surface a 503.
    // Operator must intervene (manual SRPOW transfer back).
    await app.pool.query(
      `UPDATE srpow_wrap_events SET failure_reason=$1, updated_at=now() WHERE id=$2`,
      [`${reason}; refund_failed`, eventId],
    );
    return { code: 503, body: { error: 'BRIDGE_FAILED', event_id: eventId, status: 'PENDING' } };
  }

  await app.pool.query(
    `UPDATE srpow_wrap_events SET status='REFUNDED', failure_reason=$1, updated_at=now() WHERE id=$2`,
    [reason, eventId],
  );
  return { code: 503, body: { error: 'BRIDGE_FAILED', event_id: eventId, status: 'REFUNDED' } };
}
```

Wire the route handler to use the returned `{ code, body }`:

```ts
if (swapResult.status !== 'confirmed') {
  const r = await refundUnwrap(app, eventId, wallet, amount, swapResult);
  return reply.code(r.code).send(r.body);
}
```

The validation test already covers the FAILED paths (verify=not_found, verify=failed, verify=mismatch); Task 8's `markFailed` already writes those. No code change needed there.

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/server vitest run tests/srpowUnwrapFailure.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/srpow-unwrap.ts apps/server/tests/srpowUnwrapFailure.test.ts
git commit -m "$(cat <<'EOF'
feat(srpow): unwrap refund path on swap failure

When the inline Jupiter swap returns slippage_exceeded or failed, the
bridge transfers the full X SRPOW back to the user's wallet and the
event is marked REFUNDED. The refund sig is stored in burn_signature
(operational compromise — failure_reason makes the role unambiguous).
REFUNDED events do not consume the daily quota.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Narrow existing reconcile to direction='WRAP'

**Files:**
- Modify: `apps/server/src/srpow-reconcile.ts`
- Modify: `apps/server/tests/srpow-reconcile.test.ts` (if it has new failure modes — small additive test)

- [ ] **Step 1: Write the failing test**

Append to `apps/server/tests/srpow-reconcile.test.ts`:

```ts
it('does not touch UNWRAP rows', async () => {
  const ctx = await makeTestApp({ wrapAllowlistCsv: '*' });
  await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('u@x','PK')`);
  await ctx.pool.query(`
    INSERT INTO srpow_wrap_events(id,user_email,solana_wallet,amount,direction,status,idempotency_key,solana_signature)
    VALUES ('11111111-1111-1111-1111-111111111111','u@x','PK',100,'UNWRAP','PENDING','k','SIGZ')
  `);
  // No queueResult — if the existing reconcile touches this row it'll throw.
  const { reconcilePendingWraps } = await import('../src/srpow-reconcile.js');
  await expect(reconcilePendingWraps(ctx.pool, ctx.bridgeClient)).resolves.toBeUndefined();
  const { rows } = await ctx.pool.query(`SELECT status FROM srpow_wrap_events WHERE id='11111111-1111-1111-1111-111111111111'`);
  expect(rows[0].status).toBe('PENDING');
  await ctx.cleanup();
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/server vitest run tests/srpow-reconcile.test.ts`
Expected: FAIL — reconcile mishandles the UNWRAP row (refunds it with wrap semantics).

- [ ] **Step 3: Add the filter**

In `apps/server/src/srpow-reconcile.ts`, change:

```ts
`SELECT id, solana_signature FROM srpow_wrap_events WHERE status='PENDING'`,
```

to:

```ts
`SELECT id, solana_signature FROM srpow_wrap_events WHERE status='PENDING' AND direction='WRAP'`,
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/server vitest run tests/srpow-reconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/srpow-reconcile.ts apps/server/tests/srpow-reconcile.test.ts
git commit -m "$(cat <<'EOF'
fix(srpow): wrap reconcile filters direction='WRAP'

Without this, UNWRAP rows in PENDING would be processed with wrap
semantics on the next boot. Unwraps get their own reconcile worker
in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: reconcilePendingUnwraps + boot wiring

**Files:**
- Create: `apps/server/src/srpow-unwrap-reconcile.ts`
- Create: `apps/server/tests/srpowUnwrapReconcile.test.ts`
- Modify: `apps/server/src/server.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/srpowUnwrapReconcile.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestApp } from './helpers.js';
import { reconcilePendingUnwraps } from '../src/srpow-unwrap-reconcile.js';

describe('reconcilePendingUnwraps', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('leaves an inbound-sig-pending row alone', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('u@x','PK')`);
    await ctx.pool.query(`
      INSERT INTO srpow_wrap_events(id,user_email,solana_wallet,amount,direction,status,idempotency_key,solana_signature)
      VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','u@x','PK',100,'UNWRAP','PENDING','k1','SIG_PEND')
    `);
    ctx.bridgeClient.setSignatureStatus('SIG_PEND', 'pending');
    await reconcilePendingUnwraps(ctx.pool, ctx.bridgeClient, ctx.config);
    const { rows } = await ctx.pool.query(`SELECT status FROM srpow_wrap_events`);
    expect(rows[0].status).toBe('PENDING');
  });

  it('marks FAILED when inbound sig was failed/not_found', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('u@x','PK')`);
    await ctx.pool.query(`
      INSERT INTO srpow_wrap_events(id,user_email,solana_wallet,amount,direction,status,idempotency_key,solana_signature)
      VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','u@x','PK',100,'UNWRAP','PENDING','k1','SIG_FAIL')
    `);
    ctx.bridgeClient.setSignatureStatus('SIG_FAIL', 'not_found');
    await reconcilePendingUnwraps(ctx.pool, ctx.bridgeClient, ctx.config);
    const { rows } = await ctx.pool.query(`SELECT status FROM srpow_wrap_events`);
    expect(rows[0].status).toBe('FAILED');
  });

  it('credits the user when burn_signature is set + confirmed but no credit token exists', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('u@x','PK')`);
    await ctx.pool.query(`
      INSERT INTO srpow_wrap_events(id,user_email,solana_wallet,amount,direction,status,idempotency_key,solana_signature,swap_signature,burn_signature)
      VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc','u@x','PK',100000000000,'UNWRAP','PENDING','k1','SIG_INB','SIG_SWAP','SIG_BURN')
    `);
    ctx.bridgeClient.setSignatureStatus('SIG_INB', 'confirmed');
    ctx.bridgeClient.setSignatureStatus('SIG_SWAP', 'confirmed');
    ctx.bridgeClient.setSignatureStatus('SIG_BURN', 'confirmed');
    await reconcilePendingUnwraps(ctx.pool, ctx.bridgeClient, ctx.config);
    const { rows: ev } = await ctx.pool.query(`SELECT status FROM srpow_wrap_events`);
    expect(ev[0].status).toBe('CONFIRMED');
    const { rows: t } = await ctx.pool.query(`SELECT value::text AS value FROM tokens WHERE owner_email='u@x'`);
    expect(t[0].value).toBe('95000000000');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/server vitest run tests/srpowUnwrapReconcile.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement the worker**

```ts
// apps/server/src/srpow-unwrap-reconcile.ts
import type { Pool } from 'pg';
import type { BridgeClient } from '@rpow/solana-bridge';
import { withTx } from './db.js';
import { createHash, randomUUID } from 'node:crypto';
import { signTokenPayload } from './signing.js';

export interface ReconcileConfig {
  signingPrivateKeyHex: string;
  srpowUnwrapFeeBps: number;
}

export async function reconcilePendingUnwraps(
  pool: Pool, bridge: BridgeClient, cfg: ReconcileConfig,
): Promise<void> {
  const { rows } = await pool.query<{
    id: string; user_email: string; amount: string; solana_wallet: string;
    solana_signature: string | null; swap_signature: string | null; burn_signature: string | null;
  }>(
    `SELECT id, user_email, amount::text AS amount, solana_wallet,
            solana_signature, swap_signature, burn_signature
     FROM srpow_wrap_events
     WHERE status='PENDING' AND direction='UNWRAP'`,
  );

  for (const ev of rows) {
    if (!ev.solana_signature) {
      await markFailed(pool, ev.id, 'reconcile: no inbound signature');
      continue;
    }

    let inboundStatus: string;
    try {
      inboundStatus = await bridge.getSignatureStatus(ev.solana_signature);
    } catch (e: any) {
      console.error(`reconcile inbound status failed ${ev.id}: ${e?.message ?? e}`);
      continue;
    }
    if (inboundStatus === 'pending') continue;
    if (inboundStatus === 'not_found' || inboundStatus === 'failed') {
      await markFailed(pool, ev.id, `reconcile: inbound ${inboundStatus}`);
      continue;
    }

    // From here, inbound is confirmed.
    if (!ev.swap_signature) {
      // Never executed swap; safest action is to mark FAILED — replaying
      // swap from boot without verifying we haven't already swapped is risky.
      // Operator can investigate and manually drive the row.
      await markFailed(pool, ev.id, 'reconcile: inbound confirmed but no swap_signature — manual review');
      continue;
    }

    let swapStatus: string;
    try {
      swapStatus = await bridge.getSignatureStatus(ev.swap_signature);
    } catch (e: any) {
      console.error(`reconcile swap status failed ${ev.id}: ${e?.message ?? e}`);
      continue;
    }
    if (swapStatus === 'pending') continue;
    if (swapStatus === 'not_found' || swapStatus === 'failed') {
      // Swap never landed → refund.
      const refund = await bridge.transferSrpowFromBridge(
        ev.solana_wallet, BigInt(ev.amount),
        async (_sig) => {},
      );
      if (refund.status !== 'confirmed') {
        console.error(`reconcile refund failed ${ev.id}`);
        continue;
      }
      await pool.query(
        `UPDATE srpow_wrap_events SET status='REFUNDED', failure_reason=$1, updated_at=now() WHERE id=$2`,
        [`reconcile: swap ${swapStatus}`, ev.id],
      );
      continue;
    }

    // Swap confirmed. Check burn.
    if (!ev.burn_signature) {
      // Resume burn step.
      const amount = BigInt(ev.amount);
      const feeAmount = (amount * BigInt(cfg.srpowUnwrapFeeBps)) / 10000n;
      const burnAmount = amount - feeAmount;
      const burn = await bridge.burnSrpow(
        burnAmount,
        async (sig) => {
          await pool.query(
            `UPDATE srpow_wrap_events SET burn_signature=$1, updated_at=now() WHERE id=$2`,
            [sig, ev.id],
          );
        },
      );
      if (burn.status !== 'confirmed') {
        console.error(`reconcile burn failed ${ev.id}: ${burn.failureReason}`);
        continue;
      }
      await creditAndFinalize(pool, cfg.signingPrivateKeyHex, ev.id, ev.user_email, burnAmount, feeAmount);
      continue;
    }

    let burnStatus: string;
    try {
      burnStatus = await bridge.getSignatureStatus(ev.burn_signature);
    } catch (e: any) {
      console.error(`reconcile burn status failed ${ev.id}: ${e?.message ?? e}`);
      continue;
    }
    if (burnStatus === 'pending') continue;
    if (burnStatus === 'not_found' || burnStatus === 'failed') {
      // Retry burn.
      const amount = BigInt(ev.amount);
      const feeAmount = (amount * BigInt(cfg.srpowUnwrapFeeBps)) / 10000n;
      const burnAmount = amount - feeAmount;
      const burn = await bridge.burnSrpow(
        burnAmount,
        async (sig) => {
          await pool.query(
            `UPDATE srpow_wrap_events SET burn_signature=$1, updated_at=now() WHERE id=$2`,
            [sig, ev.id],
          );
        },
      );
      if (burn.status !== 'confirmed') continue;
      await creditAndFinalize(pool, cfg.signingPrivateKeyHex, ev.id, ev.user_email, burnAmount, feeAmount);
      continue;
    }

    // All three confirmed. Check whether credit token exists; if not, run it.
    const amount = BigInt(ev.amount);
    const feeAmount = (amount * BigInt(cfg.srpowUnwrapFeeBps)) / 10000n;
    const burnAmount = amount - feeAmount;
    const { rows: existing } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tokens WHERE wrap_event_id=$1`,
      [ev.id],
    );
    if (existing[0].n === 0) {
      await creditAndFinalize(pool, cfg.signingPrivateKeyHex, ev.id, ev.user_email, burnAmount, feeAmount);
    } else {
      await pool.query(`UPDATE srpow_wrap_events SET status='CONFIRMED', updated_at=now() WHERE id=$1`, [ev.id]);
    }
  }
}

async function markFailed(pool: Pool, id: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE srpow_wrap_events SET status='FAILED', failure_reason=$1, updated_at=now() WHERE id=$2`,
    [reason, id],
  );
}

async function creditAndFinalize(
  pool: Pool, signingPrivateKeyHex: string, eventId: string, userEmail: string,
  creditAmount: bigint, feeBurnedAmount: bigint,
): Promise<void> {
  await withTx(pool, async (c) => {
    const tokenId = randomUUID();
    const issuedAt = new Date();
    const ownerHash = createHash('sha256').update(userEmail).digest('hex');
    const sig = signTokenPayload(
      { id: tokenId, owner_email_hash: ownerHash, value: creditAmount, issued_at: issuedAt.toISOString() },
      signingPrivateKeyHex,
    );
    await c.query(
      `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig, wrap_event_id, is_change)
       VALUES($1, $2, $3, 'VALID', $4, $5, $6, FALSE)`,
      [tokenId, userEmail, creditAmount.toString(), issuedAt, sig, eventId],
    );
    const wrappedShard = Math.floor(Math.random() * 128);
    await c.query(
      `UPDATE app_counters SET value = value - $1
       WHERE name='wrapped_supply_base_units' AND shard=$2`,
      [creditAmount.toString(), wrappedShard],
    );
    const feeShard = Math.floor(Math.random() * 128);
    await c.query(
      `UPDATE app_counters SET value = value + $1
       WHERE name='unwrap_fee_burned_srpow_base_units' AND shard=$2`,
      [feeBurnedAmount.toString(), feeShard],
    );
    await c.query(
      `UPDATE srpow_wrap_events SET status='CONFIRMED', updated_at=now() WHERE id=$1`,
      [eventId],
    );
  });
}
```

Wire into `apps/server/src/server.ts` next to the existing `reconcilePendingWraps` call:

```ts
import { reconcilePendingUnwraps } from './srpow-unwrap-reconcile.js';
// ...
if (env.SOLANA_RPC_URL && env.SRPOW_MINT_ADDRESS && env.BRIDGE_KEYPAIR_BASE58) {
  await reconcilePendingWraps(pool, bridgeClient);
  await reconcilePendingUnwraps(pool, bridgeClient, {
    signingPrivateKeyHex: env.SIGNING_PRIVATE_KEY_HEX,
    srpowUnwrapFeeBps: env.SRPOW_UNWRAP_FEE_BPS,
  });
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/server vitest run tests/srpowUnwrapReconcile.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/srpow-unwrap-reconcile.ts apps/server/src/server.ts apps/server/tests/srpowUnwrapReconcile.test.ts
git commit -m "$(cat <<'EOF'
feat(srpow): reconcilePendingUnwraps worker + boot wiring

Resolves PENDING UNWRAP rows by walking inbound → swap → burn → credit
signatures, refunding when swap landed as failed/not_found and
retrying burn when only that step is incomplete.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Extend /srpow/events response with swap + burn sigs

**Files:**
- Modify: `apps/server/src/routes/srpow.ts`
- Modify: `apps/server/tests/srpow-wrap.test.ts` (add a small assertion)

- [ ] **Step 1: Write the failing test**

Append to `apps/server/tests/srpow-wrap.test.ts`:

```ts
it('GET /srpow/events returns swap_signature + burn_signature columns', async () => {
  const ctx = await makeTestApp({ wrapAllowlistCsv: '*' });
  await ctx.pool.query(`INSERT INTO users(email, solana_wallet) VALUES ('u@x','PK')`);
  await ctx.pool.query(`
    INSERT INTO srpow_wrap_events(id,user_email,solana_wallet,amount,direction,status,idempotency_key,
      solana_signature,swap_signature,burn_signature)
    VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd','u@x','PK',100,'UNWRAP','CONFIRMED','k1',
      'SIG_INB','SIG_SWAP','SIG_BURN')
  `);
  const cookie = `${SESSION_COOKIE}=` + signSession({ email: 'u@x', issued_at: Math.floor(Date.now()/1000) },
    ctx.config.sessionSecret, SESSION_TTL_SECONDS);
  const res = await ctx.app.inject({ method: 'GET', url: '/srpow/events', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body[0]).toMatchObject({
    direction: 'UNWRAP',
    solana_signature: 'SIG_INB', swap_signature: 'SIG_SWAP', burn_signature: 'SIG_BURN',
  });
  await ctx.cleanup();
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/server vitest run tests/srpow-wrap.test.ts`
Expected: FAIL — missing properties.

- [ ] **Step 3: Extend the response**

Edit both `/srpow/events` and `/srpow/events/:id` in `apps/server/src/routes/srpow.ts`. For `/srpow/events`:

```ts
app.get('/srpow/events', async (req, reply) => {
  const s = readSession(req as any, app.config.sessionSecret);
  if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
  const { rows } = await app.pool.query(
    `SELECT id, direction, amount::text AS amount, status, solana_signature,
            swap_signature, burn_signature, failure_reason, created_at, updated_at
     FROM srpow_wrap_events WHERE user_email=$1 ORDER BY created_at DESC LIMIT 100`,
    [s.email],
  );
  return rows.map(r => ({
    event_id: r.id,
    direction: r.direction,
    amount_base_units: r.amount,
    status: r.status,
    solana_signature: r.solana_signature,
    swap_signature: r.swap_signature,
    burn_signature: r.burn_signature,
    failure_reason: r.failure_reason,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
});
```

Mirror for the `:id` variant.

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/server vitest run tests/srpow-wrap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/srpow.ts apps/server/tests/srpow-wrap.test.ts
git commit -m "$(cat <<'EOF'
feat(srpow): expose swap_signature + burn_signature on /srpow/events

Lets the unwrap UI render per-step Solscan links and lets clients
poll for in-flight unwrap progress.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: useSrpowConfig hook + SRPOW balance reader

**Files:**
- Create: `apps/web/src/hooks/useSrpowConfig.ts`
- Create: `apps/web/src/lib/srpowBalance.ts`
- Create: `apps/web/src/lib/srpowBalance.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/srpowBalance.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchSrpowBalanceBaseUnits } from './srpowBalance.js';

afterEach(() => vi.restoreAllMocks());

describe('fetchSrpowBalanceBaseUnits', () => {
  it("returns 0n when user has no SRPOW ATA", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: [] } }),
    }) as any;
    const b = await fetchSrpowBalanceBaseUnits({
      rpcUrl: 'https://r', ownerPubkey: 'OWN', mintPubkey: 'MINT',
    });
    expect(b).toBe(0n);
  });

  it('sums all token accounts for the mint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: {
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { amount: '100' } } } } } },
          { account: { data: { parsed: { info: { tokenAmount: { amount: '50' } } } } } },
        ],
      }}),
    }) as any;
    const b = await fetchSrpowBalanceBaseUnits({
      rpcUrl: 'https://r', ownerPubkey: 'OWN', mintPubkey: 'MINT',
    });
    expect(b).toBe(150n);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/web vitest run src/lib/srpowBalance.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement balance fetcher and config hook**

```ts
// apps/web/src/lib/srpowBalance.ts
export interface FetchSrpowBalanceArgs {
  rpcUrl: string;       // VITE_SOLANA_RPC_URL (proxy)
  ownerPubkey: string;
  mintPubkey: string;
}

export async function fetchSrpowBalanceBaseUnits(args: FetchSrpowBalanceArgs): Promise<bigint> {
  const res = await fetch(args.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
      params: [
        args.ownerPubkey,
        { mint: args.mintPubkey },
        { encoding: 'jsonParsed', commitment: 'finalized' },
      ],
    }),
  });
  if (!res.ok) throw new Error(`getTokenAccountsByOwner failed: ${res.status}`);
  const body = await res.json() as { result?: { value: any[] } };
  const accs = body.result?.value ?? [];
  return accs.reduce<bigint>(
    (acc, a) => acc + BigInt(a.account.data.parsed.info.tokenAmount.amount),
    0n,
  );
}
```

```ts
// apps/web/src/hooks/useSrpowConfig.ts
import { useEffect, useState } from 'react';

export interface SrpowConfig {
  bridge_wallet_pubkey: string;
  srpow_mint_address: string;
  fee_bps: number;
  min_unwrap_base_units: string;
  max_unwrap_base_units: string;
  slippage_bps: number;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export function useSrpowConfig(): { config: SrpowConfig | null; error: string | null } {
  const [config, setConfig] = useState<SrpowConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/srpow/config`, { credentials: 'include' });
        if (!r.ok) throw new Error(`srpow config: ${r.status}`);
        const j = await r.json();
        if (!cancelled) setConfig(j);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return { config, error };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/web vitest run src/lib/srpowBalance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/srpowBalance.ts apps/web/src/lib/srpowBalance.test.ts apps/web/src/hooks/useSrpowConfig.ts
git commit -m "$(cat <<'EOF'
feat(web): useSrpowConfig hook + SRPOW balance reader

Hook fetches /srpow/config once on mount. fetchSrpowBalanceBaseUnits
hits Solana RPC via getTokenAccountsByOwner and sums any ATAs (handles
the unusual multi-ATA case as 0+sum=correct).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: UnwrapForm component

**Files:**
- Create: `apps/web/src/components/UnwrapForm.tsx`
- Create: `apps/web/src/components/UnwrapForm.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/UnwrapForm.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UnwrapForm } from './UnwrapForm.js';

describe('UnwrapForm preview math', () => {
  it('shows credit_base_units = 95% of input', () => {
    render(<UnwrapForm
      srpowBalanceBaseUnits={500_000_000_000n}
      config={{
        bridge_wallet_pubkey: 'BRIDGE', srpow_mint_address: 'MINT',
        fee_bps: 500, min_unwrap_base_units: '10000000000',
        max_unwrap_base_units: '1000000000000000000', slippage_bps: 1000,
      }}
      walletAdapter={null}
      onUnwrapped={() => {}}
    />);
    const input = screen.getByLabelText(/amount/i);
    fireEvent.change(input, { target: { value: '100' } });
    expect(screen.getByText(/receive 95 RPOW/i)).toBeInTheDocument();
    expect(screen.getByText(/5 SRPOW fee/i)).toBeInTheDocument();
  });

  it('disables the Unwrap button when amount is below min', () => {
    render(<UnwrapForm
      srpowBalanceBaseUnits={500_000_000_000n}
      config={{
        bridge_wallet_pubkey: 'BRIDGE', srpow_mint_address: 'MINT',
        fee_bps: 500, min_unwrap_base_units: '10000000000',
        max_unwrap_base_units: '1000000000000000000', slippage_bps: 1000,
      }}
      walletAdapter={null}
      onUnwrapped={() => {}}
    />);
    const input = screen.getByLabelText(/amount/i);
    fireEvent.change(input, { target: { value: '1' } });
    expect(screen.getByRole('button', { name: /unwrap/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @rpow/web vitest run src/components/UnwrapForm.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement UnwrapForm**

```tsx
// apps/web/src/components/UnwrapForm.tsx
import { useMemo, useState } from 'react';
import type { SrpowConfig } from '../hooks/useSrpowConfig.js';

const BASE_UNITS_PER_RPOW = 1_000_000_000n;

interface Props {
  srpowBalanceBaseUnits: bigint;
  config: SrpowConfig;
  /** Phantom wallet adapter (or compatible). null = not connected. */
  walletAdapter: any | null;
  onUnwrapped?: () => void;
}

function rpowFromBaseUnits(b: bigint): string {
  return (Number(b) / Number(BASE_UNITS_PER_RPOW)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function UnwrapForm({ srpowBalanceBaseUnits, config, walletAdapter, onUnwrapped }: Props) {
  const [inputRpow, setInputRpow] = useState('');
  const [status, setStatus] = useState<'idle' | 'signing' | 'verifying' | 'swapping' | 'burning' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const inputBaseUnits = useMemo<bigint | null>(() => {
    if (!inputRpow) return null;
    try { return BigInt(Math.floor(Number(inputRpow) * Number(BASE_UNITS_PER_RPOW))); }
    catch { return null; }
  }, [inputRpow]);

  const min = BigInt(config.min_unwrap_base_units);
  const max = BigInt(config.max_unwrap_base_units);
  const feeBaseUnits = inputBaseUnits == null ? null
    : (inputBaseUnits * BigInt(config.fee_bps)) / 10000n;
  const creditBaseUnits = inputBaseUnits == null || feeBaseUnits == null ? null
    : inputBaseUnits - feeBaseUnits;

  const tooLow = inputBaseUnits != null && inputBaseUnits < min;
  const tooHigh = inputBaseUnits != null && inputBaseUnits > max;
  const overBalance = inputBaseUnits != null && inputBaseUnits > srpowBalanceBaseUnits;
  const disabled = !inputBaseUnits || tooLow || tooHigh || overBalance || !walletAdapter || status !== 'idle';

  async function handleUnwrap() {
    if (!inputBaseUnits || !walletAdapter) return;
    setStatus('signing'); setError(null);
    try {
      // 1. Build + sign + send SPL transfer from wallet to bridge.
      // (Implementation details: use @solana/spl-token's createTransferCheckedInstruction
      //  with the walletAdapter as feePayer/signer, send via the adapter's sendTransaction.)
      const signature = await sendSrpowTransferToBridge(walletAdapter, config, inputBaseUnits);

      // 2. POST to /srpow/unwrap.
      setStatus('verifying');
      const res = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ''}/srpow/unwrap`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          signature, amount_base_units: inputBaseUnits.toString(),
          idempotency_key: crypto.randomUUID(),
        }),
      });
      const body = await res.json();
      if (res.status === 200) {
        setStatus('done');
        onUnwrapped?.();
      } else if (res.status === 202) {
        // Poll /srpow/events/:id until CONFIRMED or terminal.
        await pollEvent(body.event_id, setStatus);
        onUnwrapped?.();
      } else {
        setStatus('error'); setError(body.error ?? `HTTP ${res.status}`);
      }
    } catch (e: any) {
      setStatus('error'); setError(e?.message ?? String(e));
    }
  }

  return (
    <div className="panel">
      <h3>Unwrap SRPOW → RPOW</h3>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
        SRPOW balance: <strong>{rpowFromBaseUnits(srpowBalanceBaseUnits)}</strong> SRPOW
      </div>
      <label htmlFor="unwrap-amount">Amount (SRPOW)</label>
      <input
        id="unwrap-amount"
        value={inputRpow}
        onChange={(e) => setInputRpow(e.target.value)}
        placeholder="e.g. 100"
      />
      {creditBaseUnits != null && feeBaseUnits != null && inputBaseUnits != null && (
        <div style={{ fontSize: 12, margin: '8px 0' }}>
          Receive <strong>{rpowFromBaseUnits(creditBaseUnits)} RPOW</strong>
          <br />
          {rpowFromBaseUnits(feeBaseUnits)} SRPOW fee swapped to SOL ({config.fee_bps / 100}%)
        </div>
      )}
      {tooLow && <div style={{ color: '#f88' }}>Below minimum ({rpowFromBaseUnits(min)} RPOW)</div>}
      {tooHigh && <div style={{ color: '#f88' }}>Above maximum</div>}
      {overBalance && <div style={{ color: '#f88' }}>Exceeds your SRPOW balance</div>}
      <button onClick={handleUnwrap} disabled={disabled}>
        {status === 'idle' ? 'Unwrap' : status}
      </button>
      {error && <div style={{ color: '#f88', marginTop: 8 }}>Error: {error}</div>}
    </div>
  );
}

// Build & send the inbound SPL transfer via Phantom. Mirrors the pattern in
// apps/web/src/pages/UsdcDeposit.tsx — same wallet adapter API, same
// createTransferCheckedInstruction, same sendTransaction call. If a shared
// helper was extracted during UsdcDeposit work, prefer that.
async function sendSrpowTransferToBridge(
  walletAdapter: any, config: SrpowConfig, amountBaseUnits: bigint,
): Promise<string> {
  const { Connection, PublicKey, Transaction } = await import('@solana/web3.js');
  const { getAssociatedTokenAddressSync, createTransferCheckedInstruction } = await import('@solana/spl-token');

  const rpcUrl = import.meta.env.VITE_SOLANA_RPC_URL as string;
  const conn = new Connection(rpcUrl, 'finalized');

  const owner = walletAdapter.publicKey as InstanceType<typeof PublicKey>;
  if (!owner) throw new Error('wallet not connected');
  const mint = new PublicKey(config.srpow_mint_address);
  const bridge = new PublicKey(config.bridge_wallet_pubkey);

  const fromAta = getAssociatedTokenAddressSync(mint, owner);
  const toAta = getAssociatedTokenAddressSync(mint, bridge);

  const tx = new Transaction();
  tx.add(createTransferCheckedInstruction(
    fromAta, mint, toAta, owner, amountBaseUnits, 9,
  ));

  const { blockhash } = await conn.getLatestBlockhash('finalized');
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;

  // walletAdapter.sendTransaction signs with the user's key and submits.
  const sig: string = await walletAdapter.sendTransaction(tx, conn);
  await conn.confirmTransaction(sig, 'finalized');
  return sig;
}

async function pollEvent(eventId: string, setStatus: (s: any) => void): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    await new Promise(r => setTimeout(r, 1500));
    const res = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ''}/srpow/events/${eventId}`, { credentials: 'include' });
    if (!res.ok) continue;
    const ev = await res.json();
    if (ev.swap_signature && !ev.burn_signature) setStatus('burning');
    if (ev.status === 'CONFIRMED') { setStatus('done'); return; }
    if (ev.status === 'REFUNDED' || ev.status === 'FAILED') {
      throw new Error(ev.failure_reason ?? ev.status);
    }
  }
  throw new Error('timed out polling unwrap event');
}
```

(Note: `sendSrpowTransferToBridge` is intentionally a stub — the engineer should mirror the pattern in `apps/web/src/pages/UsdcDeposit.tsx`. The test bypasses it by leaving `walletAdapter={null}` and asserting preview math only.)

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @rpow/web vitest run src/components/UnwrapForm.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/UnwrapForm.tsx apps/web/src/components/UnwrapForm.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): UnwrapForm component with live preview + polling

Live SRPOW→RPOW preview applying the configured fee_bps. Validation
against min/max/balance. Phantom transfer is delegated to
sendSrpowTransferToBridge (pattern lifted from UsdcDeposit). Polls
/srpow/events/:id for terminal status.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: WrapPage tab toggle + WrapHistory direction labeling

**Files:**
- Modify: `apps/web/src/pages/WrapPage.tsx`
- Modify: `apps/web/src/components/WrapHistory.tsx`

- [ ] **Step 1: Read current WrapPage.tsx + WrapHistory.tsx**

Run: `cat apps/web/src/pages/WrapPage.tsx apps/web/src/components/WrapHistory.tsx`

Note the existing structure — the toggle goes above `<WrapForm>` / `<UnwrapForm>`.

- [ ] **Step 2: Add the tab toggle in WrapPage.tsx**

Sketch (adapt to the actual existing structure):

```tsx
import { useState } from 'react';
import { WrapForm } from '../components/WrapForm.js';
import { UnwrapForm } from '../components/UnwrapForm.js';
import { WrapHistory } from '../components/WrapHistory.js';
import { useSrpowConfig } from '../hooks/useSrpowConfig.js';
// ...existing hooks (useMe, etc.)

export function WrapPage() {
  // ...existing fetch of me, events, balances
  const [tab, setTab] = useState<'wrap' | 'unwrap'>('wrap');
  const { config: srpowConfig } = useSrpowConfig();

  return (
    <>
      <div className="tabbar">
        <button
          onClick={() => setTab('wrap')}
          aria-pressed={tab === 'wrap'}
          style={{ fontWeight: tab === 'wrap' ? 700 : 400 }}
        >Wrap</button>
        <button
          onClick={() => setTab('unwrap')}
          aria-pressed={tab === 'unwrap'}
          style={{ fontWeight: tab === 'unwrap' ? 700 : 400 }}
        >Unwrap</button>
      </div>
      {tab === 'wrap'
        ? <WrapForm availableBaseUnits={availableBaseUnits} enabled={true} onWrapped={refetchEvents} />
        : (srpowConfig
            ? <UnwrapForm
                srpowBalanceBaseUnits={srpowBalanceBaseUnits}
                config={srpowConfig}
                walletAdapter={phantomAdapter}
                onUnwrapped={refetchEvents}
              />
            : <div>Loading…</div>)
      }
      <WrapHistory events={events} />
    </>
  );
}
```

The engineer must wire `srpowBalanceBaseUnits` using `fetchSrpowBalanceBaseUnits` from Task 14 — call it in a `useEffect` once `me.solana_wallet` and `srpowConfig.srpow_mint_address` are both known. Use the same Solana RPC URL that the existing `WrapForm` flow uses (look up `VITE_SOLANA_RPC_URL`).

- [ ] **Step 3: Make WrapHistory label UNWRAP rows distinctly**

In `WrapHistory.tsx`, find where each event row renders the direction. Add a CSS color or label distinguishing UNWRAP from WRAP. Minimal change:

```tsx
<span style={{ color: e.direction === 'UNWRAP' ? '#ffc857' : '#7ec8e3' }}>
  {e.direction === 'UNWRAP' ? '↩ UNWRAP' : '↪ WRAP'}
</span>
```

Render per-step Solscan links when `swap_signature` / `burn_signature` are present.

- [ ] **Step 4: Build + smoke test**

Run: `pnpm --filter @rpow/web build`
Expected: clean build.

(Optional manual smoke: `pnpm --filter @rpow/web dev` → open `/wrap`, toggle tabs, confirm both render.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/WrapPage.tsx apps/web/src/components/WrapHistory.tsx
git commit -m "$(cat <<'EOF'
feat(web): Wrap | Unwrap tab toggle + distinct UNWRAP history rows

WrapPage adds a two-button tab bar. UNWRAP events render with a
contrasting color + ↩ icon. swap_signature / burn_signature surfaced
as Solscan links when present.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

After Task 16, run the full suite and a full build:

- [ ] `pnpm --filter @rpow/solana-bridge vitest run` — all bridge tests pass
- [ ] `pnpm --filter @rpow/server vitest run` — all server tests pass
- [ ] `pnpm --filter @rpow/web vitest run` — all web tests pass
- [ ] `npm run build` — repo-wide build clean
- [ ] Smoke test deployed branch: `/wrap` toggles to Unwrap, preview math matches, balance reads from chain. (Requires deploying to a branch preview if Phantom flow needs real wallet.)

---

## Open implementation notes for the engineer

- The `signTokenPayload` signature must match what other token-issuing paths use. Reference `apps/server/src/routes/srpow.ts` line ~132 — same payload shape for the unwrap credit.
- `withTx` is in `apps/server/src/db.js`. Always use it for multi-statement state changes.
- The reconcile worker is called once at boot. If you want periodic recovery (e.g., for unwraps that get stuck in PENDING for hours), add a `setInterval` runner — out of scope for this plan.
- `FakeBridgeClient` queue order matters: the route handler does verify → swap → burn → (optionally) transferFromBridge. Test setup must queue in that order.
- If the existing AMM deposit flow already has a Phantom + SPL transfer-checked helper, factor it out before implementing `sendSrpowTransferToBridge` so both paths share one implementation.
- The current `apps/web` build does NOT include `apps/web-chat` in its root build script. The unwrap UI lives entirely in `apps/web`, so the existing `npm run build` is sufficient — no script change needed.
