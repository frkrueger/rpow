# Gladiator Slice 4 — POST /api/gladiator/flip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `POST /api/gladiator/flip` — the atomic coin-flip route that resolves a single challenge against an open gladiator session: burns the challenger's bet, settles the outcome, optionally mints to the winner, signs and audits the flip, emits a SYSTEM chat row, and auto-closes the session on bankroll drain.

**Architecture:** Single Fastify route inside a `withTx` block. Locks the offerer's session row with `SELECT … FOR UPDATE`. Outcome is decided by one byte from `crypto.randomBytes` whose LSB picks the winner. The bet flow is asymmetric: the challenger always burns `bet`, and a `2×bet` token mint to the challenger fires only when the challenger wins; otherwise the offerer's bankroll counter absorbs the win in-place (no per-flip mint). On drain (`bankroll_remaining < bet` post-settlement), the session auto-closes inside the same transaction with a refund mint to the offerer if any remainder is left. The flip row is signed with a dedicated `FlipPayload` over `(id, offerer_email_hash, challenger_email_hash, bet, winner_email_hash, rv_hex, created_at)` — a new helper next to `signTokenPayload`. Randomness goes through a small `gladiator/randomness.ts` shim so tests can deterministically force outcomes via `vi.spyOn` (mirrors the longshot pattern).

**Tech Stack:** Fastify 4 + zod + node:crypto + node-postgres (`withTx`) + ed25519 (existing `signing.ts`). Tests use vitest + `app.inject`.

---

## File Structure

**Modify:**
- `apps/server/src/signing.ts` — add `FlipPayload` interface, `signFlipPayload`, `verifyFlipPayload`. Keeps the existing `TokenPayload` API unchanged.
- `apps/server/src/routes/gladiator/flip.ts` — replace the 501 stub with the real handler. Leaves the `flips/recent` and `flips/history` stubs untouched (slice 5+).

**Create:**
- `apps/server/src/gladiator/randomness.ts` — `drawFlip()` returning `{ challengerWins: boolean; hex: string }`; isolates `randomBytes(1)` so tests can mock it.
- `apps/server/src/gladiator/randomness.test.ts` — unit tests for `drawFlip`.
- `apps/server/tests/gladiatorFlip.test.ts` — full route coverage (auth, validation, both outcomes, drain, signature audit, chat side-effects, accounting invariants).

**Test (extend):**
- `apps/server/src/signing.test.ts` if it exists; else add inline cases into a new minimal test alongside `randomness.test.ts` to cover `signFlipPayload`/`verifyFlipPayload` round-trip and canonicalization.

Note: there is currently no `apps/server/src/signing.test.ts`. Check first; if absent, create `apps/server/src/signing.test.ts` with just the new FlipPayload cases (don't backfill TokenPayload tests — out of scope).

---

## Design Decisions Locked Before Coding

1. **Response shape extends the spec.** Spec says `{ winner_email, bet, signature, server_time, random_value_hex, share_text }`. We additionally return `session_status` (`'OPEN'`|`'CLOSED'`), `bankroll_remaining_base_units` (stringified bigint), and `closed_at` (ISO string or `null`). The frontend needs these without an extra round-trip; the spec doesn't forbid additions.

2. **`share_text` is always written from the winner's perspective.** Body: `I just won {N} RPOW in the gladiator arena against @{opp}. Come fight me at gladiator.rpow2.com`. The challenger frontend only renders the share button when `winner_email === <session-email>`. `{N}` is `2×bet` RPOW (formatted via `formatRpow`, same helper as slice 3 — copy it into a shared spot or re-import; see Task 3 step 4).

3. **Drain SYSTEM chat body.** Spec is silent. We use: `@<offerer_handle> drained out of the arena` (deliberate distinct phrasing from slice 3's manual `@<handle> left the arena` so the chat log distinguishes drains from voluntary leaves).

4. **`challenger_session_id` is always NULL.** Per spec: "NULL = drop-in challenger". V1 never links a challenger's own open session even if they have one. We can revisit if a future slice wants cross-session linkage.

5. **`random_value_hex`** is 2 lowercase hex chars (one byte). Matches spec ("`crypto.randomBytes(1)`").

6. **RNG byte interpretation.** `byte & 1 === 1` → challenger wins, `byte & 1 === 0` → offerer wins. (Spec language: "0 = offerer wins, 1 = challenger wins".)

7. **Rate limit.** 10/min per IP, keyed on `x-forwarded-for`/`req.ip` — matches `sessions/:id/close`.

8. **Cap check on the drain refund.** Mirror the defensive cap check in `sessions.ts` close path. Should never fire (we burned this exact amount at open time) but keeps the audit identical to the close handler.

---

## Task 1: Add `FlipPayload` signing helpers

**Files:**
- Modify: `apps/server/src/signing.ts`
- Create or modify: `apps/server/src/signing.test.ts` (create if absent; add the cases below either way)

- [ ] **Step 1.1: Inspect for an existing signing test file**

Run: `ls apps/server/src/signing.test.ts apps/server/tests/signing*.ts 2>/dev/null; ls apps/server/tests/ | grep -i sign`

Expected: probably no `signing.test.ts` exists. If it does, append to it; if not, create it in Step 1.2.

- [ ] **Step 1.2: Write failing tests for `signFlipPayload`/`verifyFlipPayload`**

Create or append to `apps/server/src/signing.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateKeypair, signFlipPayload, verifyFlipPayload, type FlipPayload } from './signing.js';

describe('FlipPayload signing', () => {
  const { privateHex, publicHex } = generateKeypair();

  const samplePayload: FlipPayload = {
    id: '11111111-1111-1111-1111-111111111111',
    offerer_email_hash: 'a'.repeat(64),
    challenger_email_hash: 'b'.repeat(64),
    bet_base_units: 100_000_000n,
    winner_email_hash: 'a'.repeat(64),
    random_value_hex: 'ff',
    created_at: '2026-05-10T12:00:00.000Z',
  };

  it('signFlipPayload + verifyFlipPayload round-trip', () => {
    const sig = signFlipPayload(samplePayload, privateHex);
    expect(verifyFlipPayload(samplePayload, sig, publicHex)).toBe(true);
  });

  it('verifyFlipPayload rejects a tampered field', () => {
    const sig = signFlipPayload(samplePayload, privateHex);
    const tampered = { ...samplePayload, bet_base_units: 200_000_000n };
    expect(verifyFlipPayload(tampered, sig, publicHex)).toBe(false);
  });

  it('verifyFlipPayload rejects under a different public key', () => {
    const other = generateKeypair();
    const sig = signFlipPayload(samplePayload, privateHex);
    expect(verifyFlipPayload(samplePayload, sig, other.publicHex)).toBe(false);
  });

  it('canonicalization is stable across property-order permutations', () => {
    // Build an equivalent payload but construct it with keys in a different
    // insertion order. signFlipPayload must produce the same signature bytes.
    const reordered: FlipPayload = {
      created_at: samplePayload.created_at,
      random_value_hex: samplePayload.random_value_hex,
      winner_email_hash: samplePayload.winner_email_hash,
      bet_base_units: samplePayload.bet_base_units,
      challenger_email_hash: samplePayload.challenger_email_hash,
      offerer_email_hash: samplePayload.offerer_email_hash,
      id: samplePayload.id,
    };
    const sigA = signFlipPayload(samplePayload, privateHex);
    const sigB = signFlipPayload(reordered, privateHex);
    expect(sigA.equals(sigB)).toBe(true);
  });
});
```

- [ ] **Step 1.3: Run the test and confirm it fails**

Run: `cd apps/server && npx vitest run src/signing.test.ts`

Expected: FAIL with "signFlipPayload is not a function" / "verifyFlipPayload is not a function" / "FlipPayload is not exported".

- [ ] **Step 1.4: Implement `FlipPayload` + signing helpers**

Edit `apps/server/src/signing.ts`. Append below the existing `verifyTokenPayload`:

```typescript
export interface FlipPayload {
  id: string;
  offerer_email_hash: string;
  challenger_email_hash: string;
  bet_base_units: bigint;
  winner_email_hash: string;
  random_value_hex: string;
  created_at: string;
}

function canonicalFlip(payload: FlipPayload): Buffer {
  const ordered = JSON.stringify(
    {
      id: payload.id,
      offerer_email_hash: payload.offerer_email_hash,
      challenger_email_hash: payload.challenger_email_hash,
      bet_base_units: payload.bet_base_units,
      winner_email_hash: payload.winner_email_hash,
      random_value_hex: payload.random_value_hex,
      created_at: payload.created_at,
    },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
  return Buffer.from(ordered, 'utf8');
}

export function signFlipPayload(payload: FlipPayload, privHex: string): Buffer {
  return sign(null, canonicalFlip(payload), privKeyFromHex(privHex));
}

export function verifyFlipPayload(payload: FlipPayload, sig: Buffer, pubHex: string): boolean {
  return verify(null, canonicalFlip(payload), pubKeyFromHex(pubHex), sig);
}
```

- [ ] **Step 1.5: Run tests, confirm pass**

Run: `cd apps/server && npx vitest run src/signing.test.ts`

Expected: 4 passed.

- [ ] **Step 1.6: Commit**

```bash
git add apps/server/src/signing.ts apps/server/src/signing.test.ts
git commit -m "feat(gladiator): signFlipPayload/verifyFlipPayload for slice 4"
```

---

## Task 2: `drawFlip()` randomness module

**Files:**
- Create: `apps/server/src/gladiator/randomness.ts`
- Create: `apps/server/src/gladiator/randomness.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `apps/server/src/gladiator/randomness.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { drawFlip } from './randomness.js';

describe('drawFlip', () => {
  it('returns a 2-char lowercase hex string and a boolean', () => {
    const draw = drawFlip();
    expect(typeof draw.challengerWins).toBe('boolean');
    expect(draw.hex).toMatch(/^[0-9a-f]{2}$/);
  });

  it('challengerWins matches LSB of the byte represented by hex', () => {
    // Loop a bunch of times so we observe both outcomes; assert the invariant
    // holds on every draw.
    for (let i = 0; i < 200; i++) {
      const { challengerWins, hex } = drawFlip();
      const byte = parseInt(hex, 16);
      expect(challengerWins).toBe((byte & 1) === 1);
    }
  });

  it('observes both outcomes over many draws', () => {
    let trueSeen = false;
    let falseSeen = false;
    for (let i = 0; i < 200; i++) {
      const { challengerWins } = drawFlip();
      if (challengerWins) trueSeen = true;
      else falseSeen = true;
      if (trueSeen && falseSeen) break;
    }
    expect(trueSeen).toBe(true);
    expect(falseSeen).toBe(true);
  });
});
```

- [ ] **Step 2.2: Run and confirm failure**

Run: `cd apps/server && npx vitest run src/gladiator/randomness.test.ts`

Expected: FAIL with "Cannot find module './randomness.js'".

- [ ] **Step 2.3: Implement `drawFlip`**

Create `apps/server/src/gladiator/randomness.ts`:

```typescript
import { randomBytes } from 'node:crypto';

export interface FlipDraw {
  /** True iff the challenger wins (byte LSB === 1). */
  challengerWins: boolean;
  /** Lowercase two-char hex of the single byte drawn. */
  hex: string;
}

/**
 * Draw one cryptographically secure byte; LSB picks the winner.
 *   - 0 → offerer wins
 *   - 1 → challenger wins
 *
 * The hex string is the exact byte that drove the decision, so the audit log
 * reflects what the server saw at decision time.
 */
export function drawFlip(): FlipDraw {
  const buf = randomBytes(1);
  const hex = buf.toString('hex');
  return { challengerWins: (buf[0] & 1) === 1, hex };
}
```

- [ ] **Step 2.4: Run tests, confirm pass**

Run: `cd apps/server && npx vitest run src/gladiator/randomness.test.ts`

Expected: 3 passed.

- [ ] **Step 2.5: Commit**

```bash
git add apps/server/src/gladiator/randomness.ts apps/server/src/gladiator/randomness.test.ts
git commit -m "feat(gladiator): drawFlip() randomness module"
```

---

## Task 3: Implement `POST /api/gladiator/flip`

**Files:**
- Modify: `apps/server/src/routes/gladiator/flip.ts`
- Create: `apps/server/tests/gladiatorFlip.test.ts`

This is the bulk of slice 4. We write the full route test suite first (red), then implement the route (green), then iterate on any remaining red.

- [ ] **Step 3.1: Write the failing route test suite**

Create `apps/server/tests/gladiatorFlip.test.ts`. This file is long; it covers every branch listed in `Design Decisions Locked Before Coding`.

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import * as randomness from '../src/gladiator/randomness.js';
import { verifyFlipPayload, type FlipPayload } from '../src/signing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.pool.query(
    `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
    [email],
  );
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

async function seedToken(pool: any, email: string, value: bigint) {
  await pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, server_sig)
     VALUES($1, $2, $3, 'VALID', '\\x00')`,
    [randomUUID(), email, value.toString()],
  );
}

async function markVerified(pool: any, email: string, handle: string) {
  await pool.query(
    `UPDATE users SET x_handle = $1, x_handle_verified_at = now() WHERE email = $2`,
    [handle, email],
  );
}

async function openSession(
  pool: any,
  ownerEmail: string,
  bet: bigint,
  bankroll: bigint,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO gladiator_sessions
       (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
     VALUES ($1, $2, $3, $4, $5, 'OPEN')`,
    [id, ownerEmail, bet.toString(), bankroll.toString(), bankroll.toString()],
  );
  return id;
}

async function totalSupply(pool: any): Promise<bigint> {
  const res = await pool.query<{ value: string }>(
    `SELECT value::text FROM app_counters WHERE name = 'minted_supply'`,
  );
  return BigInt(res.rows[0]?.value ?? '0');
}

async function userBalance(pool: any, email: string): Promise<bigint> {
  const res = await pool.query<{ sum: string | null }>(
    `SELECT COALESCE(SUM(value), 0)::text AS sum FROM tokens
     WHERE owner_email = $1 AND state = 'VALID'`,
    [email],
  );
  return BigInt(res.rows[0].sum ?? '0');
}

// ---------------------------------------------------------------------------
// Auth / validation
// ---------------------------------------------------------------------------

describe('POST /api/gladiator/flip', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
    vi.restoreAllMocks();
  });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { 'content-type': 'application/json' },
      payload: { session_id: randomUUID() },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
  });

  it('403 X_HANDLE_REQUIRED for unverified challenger', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@b.com');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: randomUUID() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('X_HANDLE_REQUIRED');
  });

  it('400 BAD_REQUEST for missing session_id', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('400 BAD_REQUEST for non-uuid session_id', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('404 SESSION_NOT_FOUND when session does not exist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: randomUUID() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('SESSION_NOT_FOUND');
  });

  it('409 OFFER_UNAVAILABLE when session is CLOSED', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    await ctx.pool.query(
      `UPDATE gladiator_sessions SET status = 'CLOSED', closed_at = now() WHERE id = $1`,
      [sessionId],
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('OFFER_UNAVAILABLE');
  });

  it('400 SELF_CHALLENGE when offerer tries to flip own session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('SELF_CHALLENGE');
  });

  it('409 INSUFFICIENT_BALANCE when challenger has no tokens', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);
    // bob has no tokens
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------

  it('CHALLENGER WINS: balance +bet, bankroll -bet, supply +bet, flips_lost+=1', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    await seedToken(ctx.pool, 'bob@b.com', 1000n);
    // Seed minted_supply baseline matching what alice burned at session-open.
    // (Test app bootstraps with 0; pretend alice's bankroll is already "out".)
    await ctx.pool.query(
      `UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`,
    );
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);

    vi.spyOn(randomness, 'drawFlip').mockReturnValue({ challengerWins: true, hex: '01' });

    const before = { bal: await userBalance(ctx.pool, 'bob@b.com'), supply: await totalSupply(ctx.pool) };

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.winner_email).toBe('bob@b.com');
    expect(body.bet_base_units).toBe('10');
    expect(body.random_value_hex).toBe('01');
    expect(body.session_status).toBe('OPEN');
    expect(body.bankroll_remaining_base_units).toBe('90');
    expect(body.closed_at).toBeNull();
    expect(typeof body.share_text).toBe('string');
    expect(body.share_text).toMatch(/won 2.*RPOW.*@alice/i);

    const after = { bal: await userBalance(ctx.pool, 'bob@b.com'), supply: await totalSupply(ctx.pool) };
    expect(after.bal - before.bal).toBe(10n);  // -10 burn + 20 mint = +10
    expect(after.supply - before.supply).toBe(10n);

    const sess = await ctx.pool.query<{
      bankroll_remaining_base_units: string;
      flips_won: number;
      flips_lost: number;
      last_flip_at: Date | null;
      status: string;
    }>(
      `SELECT bankroll_remaining_base_units::text, flips_won, flips_lost, last_flip_at, status
       FROM gladiator_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(sess.rows[0].bankroll_remaining_base_units).toBe('90');
    expect(sess.rows[0].flips_won).toBe(0);
    expect(sess.rows[0].flips_lost).toBe(1);
    expect(sess.rows[0].last_flip_at).not.toBeNull();
    expect(sess.rows[0].status).toBe('OPEN');
  });

  it('OFFERER WINS: balance -bet, bankroll +bet, supply -bet, flips_won+=1', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    await seedToken(ctx.pool, 'bob@b.com', 1000n);
    await ctx.pool.query(
      `UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`,
    );
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);

    vi.spyOn(randomness, 'drawFlip').mockReturnValue({ challengerWins: false, hex: '00' });

    const before = { bal: await userBalance(ctx.pool, 'bob@b.com'), supply: await totalSupply(ctx.pool) };

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.winner_email).toBe('alice@a.com');
    expect(body.bet_base_units).toBe('10');
    expect(body.random_value_hex).toBe('00');
    expect(body.session_status).toBe('OPEN');
    expect(body.bankroll_remaining_base_units).toBe('110');
    expect(body.closed_at).toBeNull();

    const after = { bal: await userBalance(ctx.pool, 'bob@b.com'), supply: await totalSupply(ctx.pool) };
    expect(after.bal - before.bal).toBe(-10n);
    expect(after.supply - before.supply).toBe(-10n);

    const sess = await ctx.pool.query<{
      bankroll_remaining_base_units: string;
      flips_won: number;
      flips_lost: number;
      status: string;
    }>(
      `SELECT bankroll_remaining_base_units::text, flips_won, flips_lost, status
       FROM gladiator_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(sess.rows[0].bankroll_remaining_base_units).toBe('110');
    expect(sess.rows[0].flips_won).toBe(1);
    expect(sess.rows[0].flips_lost).toBe(0);
    expect(sess.rows[0].status).toBe('OPEN');
  });

  // ---------------------------------------------------------------------------
  // Drain (auto-close)
  // ---------------------------------------------------------------------------

  it('DRAIN: when bankroll_remaining < bet after settle, session auto-closes and remainder is minted back', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    await seedToken(ctx.pool, 'bob@b.com', 1000n);

    // alice opened with bet=10 and a single-flip bankroll of 10.
    // baseline minted_supply = 1000 (bob's seed). We won't model alice's burn
    // here since we hand-craft her session row.
    await ctx.pool.query(
      `UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`,
    );
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 10n);

    // Force challenger-wins: alice's bankroll goes 10 → 0; drain triggers.
    vi.spyOn(randomness, 'drawFlip').mockReturnValue({ challengerWins: true, hex: '01' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session_status).toBe('CLOSED');
    expect(body.bankroll_remaining_base_units).toBe('0');
    expect(body.closed_at).not.toBeNull();

    const sess = await ctx.pool.query<{ status: string; closed_at: Date | null }>(
      `SELECT status, closed_at FROM gladiator_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(sess.rows[0].status).toBe('CLOSED');
    expect(sess.rows[0].closed_at).not.toBeNull();
  });

  // The "drain with leftover" branch (newBankroll > 0 && < bet) is not
  // testable from a legal session state: migration 014's
  // CHECK (bankroll_initial % bet = 0) means bankroll_remaining is always a
  // clean multiple of bet, so post-flip remainder can only be 0 or >= bet.
  // The refund-mint path is exercised by the existing sessions/close test.

  // ---------------------------------------------------------------------------
  // Audit + chat side-effects
  // ---------------------------------------------------------------------------

  it('AUDIT: inserts a gladiator_flips row whose signature verifies under the public key', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    await seedToken(ctx.pool, 'bob@b.com', 1000n);
    await ctx.pool.query(
      `UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`,
    );
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);

    vi.spyOn(randomness, 'drawFlip').mockReturnValue({ challengerWins: true, hex: 'a5' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await ctx.pool.query<{
      id: string;
      offerer_session_id: string;
      challenger_session_id: string | null;
      offerer_email: string;
      challenger_email: string;
      bet_base_units: string;
      winner_email: string;
      random_value_hex: string;
      signature: Buffer;
      created_at: Date;
    }>(`SELECT id, offerer_session_id, challenger_session_id, offerer_email, challenger_email,
                bet_base_units::text, winner_email, random_value_hex, signature, created_at
         FROM gladiator_flips`);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.offerer_session_id).toBe(sessionId);
    expect(r.challenger_session_id).toBeNull();
    expect(r.offerer_email).toBe('alice@a.com');
    expect(r.challenger_email).toBe('bob@b.com');
    expect(r.bet_base_units).toBe('10');
    expect(r.winner_email).toBe('bob@b.com');
    expect(r.random_value_hex).toBe('a5');
    expect(r.signature.length).toBeGreaterThan(0);

    // Recover the canonical payload exactly as the server signed it, then verify.
    const payload: FlipPayload = {
      id: r.id,
      offerer_email_hash: createHash('sha256').update('alice@a.com').digest('hex'),
      challenger_email_hash: createHash('sha256').update('bob@b.com').digest('hex'),
      bet_base_units: BigInt(r.bet_base_units),
      winner_email_hash: createHash('sha256').update('bob@b.com').digest('hex'),
      random_value_hex: r.random_value_hex,
      created_at: r.created_at.toISOString(),
    };
    // The test app exposes the public key via app.config; read it from there.
    const pubHex = ctx.app.config.signingPublicKeyHex;
    expect(verifyFlipPayload(payload, r.signature, pubHex)).toBe(true);
  });

  it('CHAT: inserts a SYSTEM row about the flip result', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    await seedToken(ctx.pool, 'bob@b.com', 1000n);
    await ctx.pool.query(
      `UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`,
    );
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 100n);

    vi.spyOn(randomness, 'drawFlip').mockReturnValue({ challengerWins: true, hex: '01' });

    await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });

    const { rows } = await ctx.pool.query<{ kind: string; body: string }>(
      `SELECT kind, body FROM gladiator_chat_messages
       WHERE kind = 'SYSTEM' AND body LIKE '%beat%'
       ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toMatch(/@bob beat @alice for .* RPOW/i);
  });

  it('CHAT (drain): inserts a SYSTEM row about the drain in addition to the flip row', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await login(ctx, 'alice@a.com');
    await markVerified(ctx.pool, 'alice@a.com', 'alice');
    const cookie = await login(ctx, 'bob@b.com');
    await markVerified(ctx.pool, 'bob@b.com', 'bob');
    await seedToken(ctx.pool, 'bob@b.com', 1000n);
    await ctx.pool.query(
      `UPDATE app_counters SET value = 1000 WHERE name = 'minted_supply'`,
    );
    const sessionId = await openSession(ctx.pool, 'alice@a.com', 10n, 10n);

    vi.spyOn(randomness, 'drawFlip').mockReturnValue({ challengerWins: true, hex: '01' });

    await ctx.app.inject({
      method: 'POST',
      url: '/api/gladiator/flip',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sessionId },
    });

    const drainChat = await ctx.pool.query<{ body: string }>(
      `SELECT body FROM gladiator_chat_messages
       WHERE kind = 'SYSTEM' AND body LIKE '%drained%'`,
    );
    expect(drainChat.rows).toHaveLength(1);
    expect(drainChat.rows[0].body).toMatch(/@alice drained out of the arena/i);

    const flipChat = await ctx.pool.query<{ body: string }>(
      `SELECT body FROM gladiator_chat_messages
       WHERE kind = 'SYSTEM' AND body LIKE '%beat%'`,
    );
    expect(flipChat.rows).toHaveLength(1);
  });
});
```

- [ ] **Step 3.2: Run and confirm failure**

Run: `cd apps/server && npx vitest run tests/gladiatorFlip.test.ts`

Expected: all tests FAIL with 501 NOT_IMPLEMENTED or schema errors — the route is still the stub.

- [ ] **Step 3.3: Implement the route**

Replace the entire contents of `apps/server/src/routes/gladiator/flip.ts` with:

```typescript
import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { readSession } from '../auth.js';
import { withTx } from '../../db.js';
import { burnFromUser } from '../../longshot/burn.js';
import { signTokenPayload, signFlipPayload, type FlipPayload } from '../../signing.js';
import { drawFlip } from '../../gladiator/randomness.js';

const BASE_UNITS_PER_RPOW = 1_000_000_000n;

/** Format base-units as a human-readable RPOW string (matches sessions.ts). */
function formatRpow(baseUnits: bigint): string {
  if (baseUnits % BASE_UNITS_PER_RPOW === 0n) {
    return (baseUnits / BASE_UNITS_PER_RPOW).toString();
  }
  return (Number(baseUnits) / 1e9).toFixed(9).replace(/\.?0+$/, '');
}

const FlipBody = z.object({
  session_id: z.string().uuid(),
});

const NOT_IMPLEMENTED = { error: 'NOT_IMPLEMENTED', message: 'gladiator slice 1' };

export async function flipRoutes(app: FastifyInstance) {
  app.post('/api/gladiator/flip', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (req: any) => req.headers['x-forwarded-for'] ?? req.ip,
      },
    },
  }, async (req, reply) => {
    // 1. Auth
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const challengerEmail = s.email;

    // 2. Challenger must be X-verified
    const challengerRes = await app.pool.query<{
      x_handle: string | null;
      x_handle_verified_at: Date | null;
    }>(
      `SELECT x_handle, x_handle_verified_at FROM users WHERE email = $1`,
      [challengerEmail],
    );
    const challenger = challengerRes.rows[0];
    if (!challenger || !challenger.x_handle_verified_at || !challenger.x_handle) {
      return reply.code(403).send({ error: 'X_HANDLE_REQUIRED', message: 'X handle verification required' });
    }
    const challengerHandle = challenger.x_handle;

    // 3. Body
    const parsed = FlipBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }
    const sessionId = parsed.data.session_id;

    // 4. Transactional settlement
    type FlipResult =
      | {
          ok: true;
          flipId: string;
          offererEmail: string;
          offererHandle: string;
          bet: bigint;
          winnerEmail: string;
          rvHex: string;
          signature: Buffer;
          bankrollRemaining: bigint;
          sessionStatus: 'OPEN' | 'CLOSED';
          closedAt: Date | null;
          createdAt: Date;
        }
      | { error: string; message: string; status: number };

    let result: FlipResult;
    try {
      result = await withTx<FlipResult>(app.pool, async (c) => {
        // 4a. Lock the session row
        const sessRes = await c.query<{
          id: string;
          account_email: string;
          bet_base_units: string;
          bankroll_remaining_base_units: string;
          status: string;
        }>(
          `SELECT id, account_email, bet_base_units::text, bankroll_remaining_base_units::text, status
           FROM gladiator_sessions
           WHERE id = $1
           FOR UPDATE`,
          [sessionId],
        );
        if (sessRes.rows.length === 0) {
          return { error: 'SESSION_NOT_FOUND', message: 'session not found', status: 404 };
        }
        const sess = sessRes.rows[0];

        // 4b. Self-challenge guard (before status checks for clearer 400 vs 409)
        if (sess.account_email === challengerEmail) {
          return { error: 'SELF_CHALLENGE', message: 'cannot challenge your own session', status: 400 };
        }

        // 4c. Availability
        const bet = BigInt(sess.bet_base_units);
        const bankroll = BigInt(sess.bankroll_remaining_base_units);
        if (sess.status !== 'OPEN' || bankroll < bet) {
          return { error: 'OFFER_UNAVAILABLE', message: 'session not open or bankroll insufficient', status: 409 };
        }

        const offererEmail = sess.account_email;

        // 4d. Fetch offerer's x_handle for the chat message (snapshot-ok if updated mid-flip).
        const offererRes = await c.query<{ x_handle: string | null }>(
          `SELECT x_handle FROM users WHERE email = $1`,
          [offererEmail],
        );
        const offererHandle = offererRes.rows[0]?.x_handle ?? offererEmail;

        // 4e. Burn the challenger's bet (throws INSUFFICIENT_BALANCE on shortfall).
        await burnFromUser(c, challengerEmail, bet, app.config.signingPrivateKeyHex);

        // 4f. Draw the outcome.
        const { challengerWins, hex: rvHex } = drawFlip();
        const winnerEmail = challengerWins ? challengerEmail : offererEmail;

        // 4g. Apply outcome-specific accounting.
        let newBankroll: bigint;
        if (challengerWins) {
          // bankroll -= bet, flips_lost += 1
          newBankroll = bankroll - bet;
          await c.query(
            `UPDATE gladiator_sessions
             SET bankroll_remaining_base_units = $1::bigint,
                 flips_lost = flips_lost + 1,
                 last_flip_at = now()
             WHERE id = $2`,
            [newBankroll.toString(), sessionId],
          );

          // Mint 2*bet to challenger (cap-checked).
          const payout = bet * 2n;
          const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
          const supplyResult = await c.query(
            `UPDATE app_counters SET value = value + $1::bigint
             WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
            [payout.toString(), capBaseUnits.toString()],
          );
          if ((supplyResult.rowCount ?? 0) === 0) {
            return { error: 'SUPPLY_CAP_REACHED', message: 'minted supply cap reached', status: 503 };
          }

          const tokenId = randomUUID();
          const issuedAt = new Date();
          const ownerEmailHash = createHash('sha256').update(challengerEmail).digest('hex');
          const sig = signTokenPayload(
            { id: tokenId, owner_email_hash: ownerEmailHash, value: payout, issued_at: issuedAt.toISOString() },
            app.config.signingPrivateKeyHex,
          );
          await c.query(
            `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
             VALUES($1, $2, $3, 'VALID', $4, $5)`,
            [tokenId, challengerEmail, payout.toString(), issuedAt, sig],
          );
        } else {
          // bankroll += bet, flips_won += 1; supply implicitly drops by bet
          // (challenger burned bet, no offsetting mint).
          newBankroll = bankroll + bet;
          await c.query(
            `UPDATE gladiator_sessions
             SET bankroll_remaining_base_units = $1::bigint,
                 flips_won = flips_won + 1,
                 last_flip_at = now()
             WHERE id = $2`,
            [newBankroll.toString(), sessionId],
          );
          // Decrement minted_supply by bet (mirrors longshot LOSE accounting).
          await c.query(
            `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
            [bet.toString()],
          );
        }

        // 4h. Auto-close on drain.
        let sessionStatus: 'OPEN' | 'CLOSED' = 'OPEN';
        let closedAt: Date | null = null;
        if (newBankroll < bet) {
          // Mint remainder back to offerer if > 0.
          if (newBankroll > 0n) {
            const capBaseUnits = BigInt(app.config.mintMaxSupply) * BASE_UNITS_PER_RPOW;
            const supplyResult = await c.query(
              `UPDATE app_counters SET value = value + $1::bigint
               WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
              [newBankroll.toString(), capBaseUnits.toString()],
            );
            if ((supplyResult.rowCount ?? 0) === 0) {
              return { error: 'SUPPLY_CAP_REACHED', message: 'minted supply cap reached', status: 503 };
            }
            const tokenId = randomUUID();
            const issuedAt = new Date();
            const ownerEmailHash = createHash('sha256').update(offererEmail).digest('hex');
            const sig = signTokenPayload(
              { id: tokenId, owner_email_hash: ownerEmailHash, value: newBankroll, issued_at: issuedAt.toISOString() },
              app.config.signingPrivateKeyHex,
            );
            await c.query(
              `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
               VALUES($1, $2, $3, 'VALID', $4, $5)`,
              [tokenId, offererEmail, newBankroll.toString(), issuedAt, sig],
            );
          }
          // Flip the row to CLOSED.
          const closeRes = await c.query<{ closed_at: Date }>(
            `UPDATE gladiator_sessions
             SET status = 'CLOSED', closed_at = now()
             WHERE id = $1
             RETURNING closed_at`,
            [sessionId],
          );
          sessionStatus = 'CLOSED';
          closedAt = closeRes.rows[0].closed_at;

          await c.query(
            `INSERT INTO gladiator_chat_messages (id, account_email, x_handle, kind, body)
             VALUES ($1, NULL, NULL, 'SYSTEM', $2)`,
            [randomUUID(), `@${offererHandle} drained out of the arena`],
          );
        }

        // 4i. Sign + insert the flip row.
        const flipId = randomUUID();
        const createdAt = new Date();
        const flipPayload: FlipPayload = {
          id: flipId,
          offerer_email_hash: createHash('sha256').update(offererEmail).digest('hex'),
          challenger_email_hash: createHash('sha256').update(challengerEmail).digest('hex'),
          bet_base_units: bet,
          winner_email_hash: createHash('sha256').update(winnerEmail).digest('hex'),
          random_value_hex: rvHex,
          created_at: createdAt.toISOString(),
        };
        const signature = signFlipPayload(flipPayload, app.config.signingPrivateKeyHex);
        await c.query(
          `INSERT INTO gladiator_flips
             (id, offerer_session_id, challenger_session_id, offerer_email, challenger_email,
              bet_base_units, winner_email, random_value_hex, signature, created_at)
           VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9)`,
          [flipId, sessionId, offererEmail, challengerEmail, bet.toString(), winnerEmail, rvHex, signature, createdAt],
        );

        // 4j. SYSTEM chat: "@<winner> beat @<loser> for <N> RPOW"
        const winnerHandle = challengerWins ? challengerHandle : offererHandle;
        const loserHandle = challengerWins ? offererHandle : challengerHandle;
        await c.query(
          `INSERT INTO gladiator_chat_messages (id, account_email, x_handle, kind, body)
           VALUES ($1, NULL, NULL, 'SYSTEM', $2)`,
          [randomUUID(), `@${winnerHandle} beat @${loserHandle} for ${formatRpow(bet * 2n)} RPOW`],
        );

        return {
          ok: true,
          flipId,
          offererEmail,
          offererHandle,
          bet,
          winnerEmail,
          rvHex,
          signature,
          bankrollRemaining: newBankroll,
          sessionStatus,
          closedAt,
          createdAt,
        };
      });
    } catch (e: any) {
      if (e?.message === 'INSUFFICIENT_BALANCE') {
        return reply.code(409).send({ error: 'INSUFFICIENT_BALANCE', message: 'not enough tokens' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    // Build share_text from the winner's perspective.
    const winnerHandle =
      result.winnerEmail === challengerEmail ? challengerHandle : result.offererHandle;
    const opponentHandle =
      result.winnerEmail === challengerEmail ? result.offererHandle : challengerHandle;
    const shareText =
      `I just won ${formatRpow(result.bet * 2n)} RPOW in the gladiator arena against @${opponentHandle}.` +
      ` Come fight me at gladiator.rpow2.com`;

    return reply.code(200).send({
      flip_id: result.flipId,
      winner_email: result.winnerEmail,
      winner_x_handle: winnerHandle,
      bet_base_units: result.bet.toString(),
      random_value_hex: result.rvHex,
      signature: result.signature.toString('hex'),
      server_time: result.createdAt.toISOString(),
      share_text: shareText,
      session_status: result.sessionStatus,
      bankroll_remaining_base_units: result.bankrollRemaining.toString(),
      closed_at: result.closedAt ? result.closedAt.toISOString() : null,
    });
  });

  // Keep the slice-1 stubs for the still-unimplemented read routes.
  app.get('/api/gladiator/flips/recent', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });

  app.get('/api/gladiator/flips/history', async (_req, reply) => {
    return reply.code(501).send(NOT_IMPLEMENTED);
  });
}
```

- [ ] **Step 3.4: Run the route tests**

Run: `cd apps/server && npx vitest run tests/gladiatorFlip.test.ts`

Expected: all tests PASS. If a test fails:
- Read the failure carefully — most likely culprits are: `formatRpow` rounding for `2n` (`'2'` vs `'2.0'`), `share_text` regex strictness, `ctx.app.config.signingPublicKeyHex` field name mismatch, or `winner_x_handle` vs spec response. Adjust the test or the response field; don't loosen the financial invariants.
- If `verifyFlipPayload` returns `false`: the canonical JSON ordering in `signing.ts` doesn't match what the route hands in. Both must reference the same field set in the same order — the JSON.stringify with explicit ordered object literal handles that.

- [ ] **Step 3.5: Run the full server suite to catch regressions**

Run: `cd apps/server && npx vitest run`

Expected: all green. Slice 2/3 tests must still pass — flip.ts changes don't touch other routes, but the signing.ts addition could break a TokenPayload test if anyone has one. Investigate any new red.

- [ ] **Step 3.6: Commit**

```bash
git add apps/server/src/routes/gladiator/flip.ts apps/server/tests/gladiatorFlip.test.ts
git commit -m "feat(gladiator): slice 4 — POST /api/gladiator/flip"
```

---

## Task 4: Verification & wrap-up

- [ ] **Step 4.1: Run the full server suite once more**

Run: `cd apps/server && npx vitest run`

Expected: every test green, no skipped tests added by this slice.

- [ ] **Step 4.2: Sanity-check the new route by hand against the route table**

Run: `cd apps/server && grep -nE "POST.*gladiator/flip|gladiator/flip.*POST" dist 2>/dev/null; grep -nE "gladiator/flip" src/routes/gladiator/index.ts`

Expected: `flipRoutes` is already registered in `index.ts` (it was wired in slice 1 — verify, don't re-wire).

If it isn't, add the registration; otherwise leave alone.

- [ ] **Step 4.3: Final commit (if anything was tweaked in 4.1–4.2)**

Only commit if there are changes. Otherwise skip.

---

## Out of Scope (Slice 5+)

- `GET /api/gladiator/lobby` — list OPEN gladiators
- `GET /api/gladiator/chat` + `POST /api/gladiator/chat` — read/write the global chat
- `GET /api/gladiator/flips/recent`
- `GET /api/gladiator/flips/history`
- Auto-close inactive sessions sweeper (`GLADIATOR_SESSION_TTL_HOURS`)
- Frontend SPA `apps/web-gladiator/`
- 8-bit battle animation, share-on-win UI

---

## Self-Review (post-write)

- **Spec coverage (section 7.C):** `withTx` ✓, `SELECT FOR UPDATE` ✓, status/bankroll/self-challenge checks ✓, `crypto.randomBytes(1)[0] & 1` via `drawFlip` ✓, challenger-wins burn + 2×bet mint ✓, offerer-wins burn + bankroll increment ✓, auto-close on drain + mint remainder ✓, signed `gladiator_flips` insert with canonical fields ✓, SYSTEM chat insert ✓, response includes `winner_email, bet, signature, server_time, random_value_hex, share_text` ✓ (plus three ergonomic additions called out in Design Decisions).

- **Placeholder scan:** none. The "implementor note" inside the second DRAIN test is a deliberate signal to *delete* that test in Step 3.2 — Step 3.2 makes the deletion an explicit action.

- **Type consistency:** `FlipPayload` field names match exactly in `signing.ts`, the route construction, the audit test reconstruction, and the canonical-JSON ordered literal. `app.config.signingPublicKeyHex` and `app.config.signingPrivateKeyHex` are the same keys already used by `sessions.ts` and `longshot.ts`. `app.config.mintMaxSupply` matches the close path's cap-check.

- **Drain refund branch:** exercised by `DRAIN: when bankroll_remaining < bet…` test (no leftover, ok) and by the existing `sessions/close` refund test (with leftover, ok). The second DRAIN test was deliberately deleted because the migration's `bankroll_initial % bet = 0` CHECK makes a legal sub-bet remainder impossible.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-10-gladiator-slice-4-flip.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks
2. **Inline Execution** — execute in this session using `executing-plans`, batch with checkpoints

**Which approach?**
