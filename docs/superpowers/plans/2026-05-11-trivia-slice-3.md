# Trivia Slice 3 — Match start + answer + resolve + signing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the trivia match flow playable end-to-end: challenger starts a match, both sides answer (server-stamped), server resolves per §4 rules with an ed25519-signed audit row.

**Architecture:** Add `MatchPayload` + `signMatchPayload` to `signing.ts` (mirrors `signFlipPayload`). Introduce a pure-tx helper `resolveMatchTx(c, matchId, ctx)` in `apps/server/src/trivia/resolve.ts` so resolution is invokable from both `POST /matches/:id/answer` (when both have answered) and the two GET poll endpoints (lazy resolve when `now() > deadline_at`). Wire 4 endpoints in `apps/server/src/routes/trivia/matches.ts`. Each endpoint owns its `withTx`; the helper takes a tx client and performs DB mutations only — never reads `now()` from JS, always uses `now()` from postgres for server-authoritative timestamps.

**Tech Stack:** Fastify 4, Postgres 17 (`SELECT FOR UPDATE`), Zod, `node:crypto` (ed25519), vitest.

---

## File Structure

**Create:**
- `apps/server/src/trivia/resolve.ts` — `resolveMatchTx(c, matchId, ctx)`. One responsibility: given a row-locked active match (locked by caller), apply §4 rules, do bankroll + supply + auto-close + mint, sign the canonical payload, set `state='RESOLVED'`.
- `apps/server/tests/triviaResolve.test.ts` — unit tests for `resolveMatchTx` driven directly (no HTTP) covering every row of the §4 resolution table.
- `apps/server/tests/triviaMatchStart.test.ts` — happy path + OFFER_UNAVAILABLE + SELF_CHALLENGE + INSUFFICIENT_BALANCE + NO_QUESTIONS_AVAILABLE + UNIQUE-active-per-session + X_HANDLE_REQUIRED + 401 unauth.
- `apps/server/tests/triviaMatchAnswer.test.ts` — happy path + MATCH_EXPIRED + ALREADY_ANSWERED + NOT_A_PLAYER + invalid `choice_idx` + idempotency check + both-answered triggers resolve.
- `apps/server/tests/triviaMatchPolls.test.ts` — GET `/matches/active` (offerer poll, lazy resolve, no-active-match, not-owner forbidden) + GET `/matches/:id` (both-sides poll, lazy resolve, forbidden for non-player).
- `apps/server/tests/triviaSigning.test.ts` — `signMatchPayload` / `verifyMatchPayload` roundtrip + canonical bytes stability.

**Modify:**
- `apps/server/src/signing.ts` — add `MatchPayload`, `signMatchPayload`, `verifyMatchPayload`.
- `apps/server/src/routes/trivia/matches.ts` — replace 4 NOT_IMPLEMENTED stubs with real handlers; keep the existing `/matches/recent` + `/matches/history` reads intact.
- `apps/server/tests/triviaRoutes.test.ts` — delete the 501-stub test file entirely (all slice-3 endpoints will be real).

---

## Conventions used in this plan

- All numeric body fields are stringified bigints (`"100000000"`), validated `^\d+$`, matches existing trivia/gladiator routes.
- All server timestamps come from postgres `now()` so we never trust the JS clock. Where we need a JS-side ISO string (signing), we read it back from the RETURNING clause.
- `withTx` is the tx wrapper (see `apps/server/src/db.ts`). It rolls back on thrown exceptions; structured error returns (`{ error, status, message }`) commit and surface to the handler.
- Cap-check pattern: increment `app_counters.minted_supply` with a guarded UPDATE; if `rowCount == 0`, `throw new Error('SUPPLY_CAP_REACHED')` inside `withTx`; outer handler catches and 503s.
- For email hashing in signed payloads, use `createHash('sha256').update(email).digest('hex')` (matches gladiator's `FlipPayload`).
- Email handling: lowercase nothing — emails are passed through verbatim. The handle string in the share text is the X handle, not the email.
- "tx client" means the `PoolClient` passed into the `withTx` callback (named `c` in existing code).

---

## Task 1: Sign / verify MatchPayload

**Files:**
- Modify: `apps/server/src/signing.ts` (append new exports at end of file)
- Test: `apps/server/tests/triviaSigning.test.ts` (create)

`MatchPayload` covers everything needed for a third-party audit replay: who played, what they bet, which question, both answers + timestamps, who won, when it was created.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/triviaSigning.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  signMatchPayload,
  verifyMatchPayload,
  type MatchPayload,
  generateKeypair,
} from '../src/signing.js';

const samplePayload = (): MatchPayload => ({
  id: '00000000-0000-4000-8000-000000000001',
  offerer_email_hash: 'a'.repeat(64),
  challenger_email_hash: 'b'.repeat(64),
  bet_base_units: 12345n,
  question_id: '00000000-0000-4000-8000-000000000002',
  offerer_choice_idx: 1,
  offerer_answered_at: '2026-05-11T10:00:00.123Z',
  challenger_choice_idx: 2,
  challenger_answered_at: '2026-05-11T10:00:00.456Z',
  winner_email_hash: 'a'.repeat(64),
  created_at: '2026-05-11T10:00:00.000Z',
});

describe('signMatchPayload / verifyMatchPayload', () => {
  it('signs and verifies a fully-populated payload', () => {
    const { privateHex, publicHex } = generateKeypair();
    const payload = samplePayload();
    const sig = signMatchPayload(payload, privateHex);
    expect(verifyMatchPayload(payload, sig, publicHex)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const { privateHex, publicHex } = generateKeypair();
    const payload = samplePayload();
    const sig = signMatchPayload(payload, privateHex);
    const tampered: MatchPayload = { ...payload, winner_email_hash: 'c'.repeat(64) };
    expect(verifyMatchPayload(tampered, sig, publicHex)).toBe(false);
  });

  it('supports null choice + null answered_at for a timed-out side', () => {
    const { privateHex, publicHex } = generateKeypair();
    const payload: MatchPayload = {
      ...samplePayload(),
      challenger_choice_idx: null,
      challenger_answered_at: null,
    };
    const sig = signMatchPayload(payload, privateHex);
    expect(verifyMatchPayload(payload, sig, publicHex)).toBe(true);
  });

  it('produces deterministic bytes for the same payload', () => {
    const { privateHex } = generateKeypair();
    const payload = samplePayload();
    const sig1 = signMatchPayload(payload, privateHex);
    const sig2 = signMatchPayload(payload, privateHex);
    // Ed25519 is deterministic; signatures must be byte-identical.
    expect(sig1.equals(sig2)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd apps/server && npx vitest run tests/triviaSigning.test.ts
```

Expected: FAIL — `signMatchPayload is not exported`.

- [ ] **Step 3: Add MatchPayload + sign/verify to signing.ts**

Append to the bottom of `apps/server/src/signing.ts`:

```ts
export interface MatchPayload {
  id: string;
  offerer_email_hash: string;
  challenger_email_hash: string;
  bet_base_units: bigint;
  question_id: string;
  offerer_choice_idx: number | null;
  offerer_answered_at: string | null;
  challenger_choice_idx: number | null;
  challenger_answered_at: string | null;
  winner_email_hash: string;
  created_at: string;
}

function canonicalMatch(payload: MatchPayload): Buffer {
  // Field order is part of the contract — never reorder, never add fields
  // in place; new versions get a new payload type.
  const ordered = JSON.stringify(
    {
      id: payload.id,
      offerer_email_hash: payload.offerer_email_hash,
      challenger_email_hash: payload.challenger_email_hash,
      bet_base_units: payload.bet_base_units,
      question_id: payload.question_id,
      offerer_choice_idx: payload.offerer_choice_idx,
      offerer_answered_at: payload.offerer_answered_at,
      challenger_choice_idx: payload.challenger_choice_idx,
      challenger_answered_at: payload.challenger_answered_at,
      winner_email_hash: payload.winner_email_hash,
      created_at: payload.created_at,
    },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
  return Buffer.from(ordered, 'utf8');
}

export function signMatchPayload(payload: MatchPayload, privHex: string): Buffer {
  return sign(null, canonicalMatch(payload), privKeyFromHex(privHex));
}

export function verifyMatchPayload(payload: MatchPayload, sig: Buffer, pubHex: string): boolean {
  return verify(null, canonicalMatch(payload), pubKeyFromHex(pubHex), sig);
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd apps/server && npx vitest run tests/triviaSigning.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/signing.ts apps/server/tests/triviaSigning.test.ts
git commit -m "feat(trivia): MatchPayload signing + canonical roundtrip tests"
```

---

## Task 2: resolveMatchTx helper

**Files:**
- Create: `apps/server/src/trivia/resolve.ts`
- Test: `apps/server/tests/triviaResolve.test.ts`

The helper is tx-only: caller is responsible for `withTx` AND for having already `SELECT … FOR UPDATE`-locked the match row. The helper trusts the lock. This gives the caller (answer endpoint and poll endpoints) one shared resolution code path — no duplicated bankroll/mint/sign logic.

### Helper contract

```ts
export interface ResolveCtx {
  signingPrivateKeyHex: string;
  mintMaxSupply: string;       // app.config.mintMaxSupply (RPOW, not base units)
}

export interface ResolveResult {
  winner_email: string;
  signature: Buffer;
  resolved_at: Date;
  // Post-resolution session state, for callers that want to surface it:
  session_status: 'OPEN' | 'CLOSED';
  bankroll_remaining: bigint;
  closed_at: Date | null;
}

export async function resolveMatchTx(
  c: PoolClient,
  matchId: string,
  ctx: ResolveCtx,
): Promise<ResolveResult>
```

Behavior:
1. `SELECT m.*, q.correct_idx FROM trivia_matches m JOIN trivia_questions q ON q.id = m.question_id WHERE m.id = $1 FOR UPDATE OF m` (lock the match; the session lock is acquired next).
2. If `state = 'RESOLVED'`: re-fetch the existing signature + winner + closed state and return them (idempotent — every poll path calls into here, so duplicate calls must be safe).
3. `SELECT FOR UPDATE` the offerer session row.
4. Compute winner per §4 rules below.
5. If challenger won: bankroll -= bet, matches_lost += 1, mint `2*bet` to challenger (cap-check throws on failure).
6. If offerer won: bankroll += bet, matches_won += 1, no mint.
7. UPDATE `last_match_at = now()` on the session row.
8. If new `bankroll_remaining < bet`: mint remainder back to offerer (cap-check), `status='CLOSED'`, `closed_at = now()`, insert SYSTEM chat row `'@<handle> drained out of the arena'`.
9. Build canonical `MatchPayload` from the row, sign, UPDATE match → `state='RESOLVED', winner_email, signature, resolved_at = now()`.
10. Return the resolve result.

### Winner rule (§4)

```ts
const offererCorrect  = offerer_choice_idx === correct_idx;
const challengerCorrect = challenger_choice_idx === correct_idx;

let winnerEmail: string;
if (offererCorrect && challengerCorrect) {
  // Both correct: faster wins, tie or null timestamps → offerer.
  if (
    challenger_answered_at !== null &&
    offerer_answered_at !== null &&
    challenger_answered_at.getTime() < offerer_answered_at.getTime()
  ) {
    winnerEmail = challenger_email;
  } else {
    winnerEmail = offerer_email; // includes the tie case
  }
} else if (offererCorrect) {
  winnerEmail = offerer_email;
} else if (challengerCorrect) {
  winnerEmail = challenger_email;
} else {
  // Both wrong / timeout / both null → offerer wins
  winnerEmail = offerer_email;
}
```

A NULL `choice_idx` is never equal to `correct_idx` (the strict `===` comparison rejects it), so a timed-out side is automatically "wrong".

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/triviaResolve.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { resolveMatchTx } from '../src/trivia/resolve.js';
import { verifyMatchPayload, type MatchPayload } from '../src/signing.js';

async function seedQuestion(pool: any, correctIdx: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trivia_questions(id, category, difficulty, question, correct_idx, choices)
     VALUES($1, 'General', 'easy', 'capital of France?', $2, ARRAY['London','Paris','Berlin','Tokyo'])`,
    [id, correctIdx],
  );
  return id;
}

async function seedSession(pool: any, email: string, bet: bigint, bankroll: bigint): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trivia_sessions(id, account_email, bet_base_units, bankroll_initial_base_units,
       bankroll_remaining_base_units, status, opened_at)
     VALUES($1, $2, $3, $4, $5, 'OPEN', now())`,
    [id, email, bet.toString(), bankroll.toString(), bankroll.toString()],
  );
  return id;
}

async function seedMatch(
  pool: any,
  opts: {
    offererSessionId: string;
    offererEmail: string;
    challengerEmail: string;
    bet: bigint;
    questionId: string;
    offererChoice: number | null;
    offererAnsweredAt: Date | null;
    challengerChoice: number | null;
    challengerAnsweredAt: Date | null;
    deadlineSecondsFromNow: number; // negative = already expired
  },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trivia_matches(id, offerer_session_id, offerer_email, challenger_email,
       bet_base_units, question_id, state, deadline_at,
       offerer_choice_idx, offerer_answered_at,
       challenger_choice_idx, challenger_answered_at, created_at)
     VALUES($1, $2, $3, $4, $5, $6, 'ACTIVE', now() + ($7 || ' seconds')::interval,
            $8, $9, $10, $11, now())`,
    [
      id,
      opts.offererSessionId,
      opts.offererEmail,
      opts.challengerEmail,
      opts.bet.toString(),
      opts.questionId,
      String(opts.deadlineSecondsFromNow),
      opts.offererChoice,
      opts.offererAnsweredAt,
      opts.challengerChoice,
      opts.challengerAnsweredAt,
    ],
  );
  // Mirror minted_supply: challenger's bet was burned before this row existed.
  await pool.query(
    `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
    [opts.bet.toString()],
  );
  return id;
}

async function getMatch(pool: any, id: string) {
  const r = await pool.query(
    `SELECT state, winner_email, signature,
            offerer_choice_idx, offerer_answered_at,
            challenger_choice_idx, challenger_answered_at,
            created_at, resolved_at
     FROM trivia_matches WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function getSession(pool: any, id: string) {
  const r = await pool.query(
    `SELECT status, bankroll_remaining_base_units::text AS bankroll_remaining,
            matches_won, matches_lost
     FROM trivia_sessions WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

// CTX uses the real signing key from the test app's config so verifyMatchPayload
// can use the matching public key (re-derived inside this test).
import { generateKeypair } from '../src/signing.js';
import { withTx } from '../src/db.js';
import { createHash } from 'node:crypto';

describe('resolveMatchTx — §4 resolution table', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  // Bet = 10, bankroll = 30 (3 matches). Default expects challenger NOT to drain.
  const BET = 10n;
  const BANKROLL = 30n;
  const offerer = 'off@x.com';
  const challenger = 'cha@x.com';

  async function setupCtx() {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    // Seed both users.
    await ctx.pool.query(
      `INSERT INTO users(email, x_handle, x_handle_verified_at) VALUES
         ($1, 'offhandle', now()), ($2, 'chahandle', now())`,
      [offerer, challenger],
    );
    return ctx;
  }

  // Tests one by one — each builds a different §4 row.

  it('row 1: offerer correct, challenger correct but slower → offerer wins', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1); // Paris is correct
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const t1 = new Date(Date.now() - 4000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 1, offererAnsweredAt: t0,
      challengerChoice: 1, challengerAnsweredAt: t1, // slower
      deadlineSecondsFromNow: 10,
    });

    const res = await withTx(ctx.pool, async (c) => {
      // Lock first (mimic caller contract).
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });

    expect(res.winner_email).toBe(offerer);
    const s = await getSession(ctx.pool, sid);
    expect(s.bankroll_remaining).toBe('40'); // +10
    expect(s.matches_won).toBe(1);
    expect(s.matches_lost).toBe(0);
    expect(s.status).toBe('OPEN');
  });

  it('row 2: offerer correct slower, challenger correct → challenger wins, payout minted', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const tFast = new Date(Date.now() - 5000);
    const tSlow = new Date(Date.now() - 4000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 1, offererAnsweredAt: tSlow,
      challengerChoice: 1, challengerAnsweredAt: tFast,
      deadlineSecondsFromNow: 10,
    });

    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });

    expect(res.winner_email).toBe(challenger);

    const s = await getSession(ctx.pool, sid);
    expect(s.bankroll_remaining).toBe('20'); // -10
    expect(s.matches_lost).toBe(1);

    // Challenger should now hold a payout token of 2*BET = 20 base units.
    const tok = await ctx.pool.query(
      `SELECT value::text AS value FROM tokens WHERE owner_email = $1 AND state = 'VALID'`,
      [challenger],
    );
    const total = tok.rows.reduce((acc: bigint, r: any) => acc + BigInt(r.value), 0n);
    expect(total).toBe(20n);
  });

  it('row 3: offerer correct, challenger wrong → offerer wins', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 1, offererAnsweredAt: t0,
      challengerChoice: 3, challengerAnsweredAt: t0, // wrong
      deadlineSecondsFromNow: 10,
    });

    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(offerer);
  });

  it('row 4: offerer wrong, challenger correct → challenger wins', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 3, offererAnsweredAt: t0,
      challengerChoice: 1, challengerAnsweredAt: t0,
      deadlineSecondsFromNow: 10,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(challenger);
  });

  it('row 5: both wrong → offerer wins (challenger loses bet)', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 3, offererAnsweredAt: t0,
      challengerChoice: 2, challengerAnsweredAt: t0,
      deadlineSecondsFromNow: 10,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(offerer);
  });

  it('row 5b: both timeout (null choices) → offerer wins', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: null, offererAnsweredAt: null,
      challengerChoice: null, challengerAnsweredAt: null,
      deadlineSecondsFromNow: -1, // expired
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(offerer);
  });

  it('row 6: tie on ms-equal correct timestamps → offerer wins', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 1, offererAnsweredAt: t0,
      challengerChoice: 1, challengerAnsweredAt: t0, // same instant
      deadlineSecondsFromNow: 10,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(offerer);
  });

  it('auto-closes the session and mints remainder back when bankroll drops below bet', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    // bankroll == 1*bet so a loss takes it to 0 → auto-close (nothing to mint back)
    const sid = await seedSession(ctx.pool, offerer, BET, BET);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 3, offererAnsweredAt: t0,           // wrong
      challengerChoice: 1, challengerAnsweredAt: t0,     // correct → wins
      deadlineSecondsFromNow: 10,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(res.winner_email).toBe(challenger);
    expect(res.session_status).toBe('CLOSED');
    const s = await getSession(ctx.pool, sid);
    expect(s.status).toBe('CLOSED');
    expect(s.bankroll_remaining).toBe('0');
    // Drain SYSTEM chat row recorded:
    const chat = await ctx.pool.query(
      `SELECT body FROM trivia_chat_messages WHERE kind = 'SYSTEM' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(chat.rows[0]?.body).toContain('drained');
  });

  it('signs the canonical payload and verifies', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 1, offererAnsweredAt: t0,
      challengerChoice: 3, challengerAnsweredAt: t0,
      deadlineSecondsFromNow: 10,
    });
    const res = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });

    // Pull the row, build payload, verify with the app's public key.
    const m = await getMatch(ctx.pool, mid);
    const payload: MatchPayload = {
      id: mid,
      offerer_email_hash: createHash('sha256').update(offerer).digest('hex'),
      challenger_email_hash: createHash('sha256').update(challenger).digest('hex'),
      bet_base_units: BET,
      question_id: qid,
      offerer_choice_idx: m.offerer_choice_idx,
      offerer_answered_at: m.offerer_answered_at?.toISOString() ?? null,
      challenger_choice_idx: m.challenger_choice_idx,
      challenger_answered_at: m.challenger_answered_at?.toISOString() ?? null,
      winner_email_hash: createHash('sha256').update(res.winner_email).digest('hex'),
      created_at: m.created_at.toISOString(),
    };
    expect(verifyMatchPayload(payload, res.signature, ctx.app.config.signingPublicKeyHex)).toBe(true);
  });

  it('is idempotent — calling twice on a RESOLVED match returns the same signature', async () => {
    const ctx = await setupCtx();
    const qid = await seedQuestion(ctx.pool, 1);
    const sid = await seedSession(ctx.pool, offerer, BET, BANKROLL);
    const t0 = new Date(Date.now() - 5000);
    const mid = await seedMatch(ctx.pool, {
      offererSessionId: sid, offererEmail: offerer, challengerEmail: challenger,
      bet: BET, questionId: qid,
      offererChoice: 1, offererAnsweredAt: t0,
      challengerChoice: 3, challengerAnsweredAt: t0,
      deadlineSecondsFromNow: 10,
    });

    const r1 = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    const r2 = await withTx(ctx.pool, async (c) => {
      await c.query(`SELECT id FROM trivia_matches WHERE id = $1 FOR UPDATE`, [mid]);
      return resolveMatchTx(c, mid, {
        signingPrivateKeyHex: ctx.app.config.signingPrivateKeyHex,
        mintMaxSupply: ctx.app.config.mintMaxSupply,
      });
    });
    expect(r1.signature.equals(r2.signature)).toBe(true);
    expect(r1.winner_email).toBe(r2.winner_email);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd apps/server && npx vitest run tests/triviaResolve.test.ts
```

Expected: FAIL — `Cannot find module '../src/trivia/resolve.js'`.

- [ ] **Step 3: Implement resolveMatchTx**

Create `apps/server/src/trivia/resolve.ts`:

```ts
import type { PoolClient } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { signMatchPayload, signTokenPayload, type MatchPayload } from '../signing.js';

const BASE_UNITS_PER_RPOW = 1_000_000_000n;

export interface ResolveCtx {
  signingPrivateKeyHex: string;
  mintMaxSupply: string;
}

export interface ResolveResult {
  winner_email: string;
  signature: Buffer;
  resolved_at: Date;
  session_status: 'OPEN' | 'CLOSED';
  bankroll_remaining: bigint;
  closed_at: Date | null;
}

/**
 * Apply the §4 resolution rules to one ACTIVE match and atomically:
 *   - update bankroll + W/L counters on the offerer's session
 *   - mint payout to challenger if challenger wins
 *   - auto-close the session if bankroll drops below bet (minting remainder back)
 *   - sign the canonical MatchPayload and write state='RESOLVED'
 *
 * Caller is responsible for opening the surrounding `withTx`. This function
 * always acquires `FOR UPDATE` locks on the match and session rows, so the
 * caller does not need to pre-lock — but a pre-existing lock is harmless.
 *
 * Idempotent: if the match is already RESOLVED, returns the persisted state
 * without mutating anything.
 */
export async function resolveMatchTx(
  c: PoolClient,
  matchId: string,
  ctx: ResolveCtx,
): Promise<ResolveResult> {
  // 1. Lock the match + read the joined question.
  const matchRes = await c.query<{
    id: string;
    offerer_session_id: string;
    offerer_email: string;
    challenger_email: string;
    bet_base_units: string;
    question_id: string;
    state: string;
    offerer_choice_idx: number | null;
    offerer_answered_at: Date | null;
    challenger_choice_idx: number | null;
    challenger_answered_at: Date | null;
    winner_email: string | null;
    signature: Buffer | null;
    created_at: Date;
    resolved_at: Date | null;
    correct_idx: number;
  }>(
    `SELECT m.id, m.offerer_session_id, m.offerer_email, m.challenger_email,
            m.bet_base_units::text, m.question_id, m.state,
            m.offerer_choice_idx, m.offerer_answered_at,
            m.challenger_choice_idx, m.challenger_answered_at,
            m.winner_email, m.signature, m.created_at, m.resolved_at,
            q.correct_idx
     FROM trivia_matches m
     JOIN trivia_questions q ON q.id = m.question_id
     WHERE m.id = $1
     FOR UPDATE OF m`,
    [matchId],
  );
  if (matchRes.rows.length === 0) {
    throw new Error('MATCH_NOT_FOUND');
  }
  const m = matchRes.rows[0];

  // 2. Idempotent fast path: already resolved.
  if (m.state === 'RESOLVED') {
    const sess = await c.query<{
      status: 'OPEN' | 'CLOSED';
      bankroll_remaining_base_units: string;
      closed_at: Date | null;
    }>(
      `SELECT status, bankroll_remaining_base_units::text, closed_at
       FROM trivia_sessions WHERE id = $1`,
      [m.offerer_session_id],
    );
    return {
      winner_email: m.winner_email!,
      signature: m.signature!,
      resolved_at: m.resolved_at!,
      session_status: sess.rows[0].status,
      bankroll_remaining: BigInt(sess.rows[0].bankroll_remaining_base_units),
      closed_at: sess.rows[0].closed_at,
    };
  }

  // 3. Lock the offerer session.
  const sessRes = await c.query<{
    bankroll_remaining_base_units: string;
    status: string;
  }>(
    `SELECT bankroll_remaining_base_units::text, status
     FROM trivia_sessions WHERE id = $1 FOR UPDATE`,
    [m.offerer_session_id],
  );
  if (sessRes.rows.length === 0) {
    throw new Error('SESSION_NOT_FOUND');
  }
  const bet = BigInt(m.bet_base_units);
  const bankroll = BigInt(sessRes.rows[0].bankroll_remaining_base_units);

  // 4. Determine winner per §4 rules.
  const offererCorrect = m.offerer_choice_idx === m.correct_idx;
  const challengerCorrect = m.challenger_choice_idx === m.correct_idx;
  let winnerEmail: string;
  if (offererCorrect && challengerCorrect) {
    if (
      m.challenger_answered_at !== null &&
      m.offerer_answered_at !== null &&
      m.challenger_answered_at.getTime() < m.offerer_answered_at.getTime()
    ) {
      winnerEmail = m.challenger_email;
    } else {
      winnerEmail = m.offerer_email;
    }
  } else if (offererCorrect) {
    winnerEmail = m.offerer_email;
  } else if (challengerCorrect) {
    winnerEmail = m.challenger_email;
  } else {
    winnerEmail = m.offerer_email;
  }

  // 5. Apply bankroll / supply / W-L for the resolution.
  let newBankroll: bigint;
  if (winnerEmail === m.challenger_email) {
    newBankroll = bankroll - bet;
    await c.query(
      `UPDATE trivia_sessions
       SET bankroll_remaining_base_units = $1::bigint,
           matches_lost = matches_lost + 1,
           last_match_at = now()
       WHERE id = $2`,
      [newBankroll.toString(), m.offerer_session_id],
    );
    // Mint payout (2 * bet) to challenger; cap-check.
    const payout = bet * 2n;
    const capBaseUnits = BigInt(ctx.mintMaxSupply) * BASE_UNITS_PER_RPOW;
    const supplyResult = await c.query(
      `UPDATE app_counters SET value = value + $1::bigint
       WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
      [payout.toString(), capBaseUnits.toString()],
    );
    if ((supplyResult.rowCount ?? 0) === 0) {
      throw new Error('SUPPLY_CAP_REACHED');
    }
    const tokenId = randomUUID();
    const issuedAt = new Date();
    const ownerEmailHash = createHash('sha256').update(m.challenger_email).digest('hex');
    const sig = signTokenPayload(
      { id: tokenId, owner_email_hash: ownerEmailHash, value: payout, issued_at: issuedAt.toISOString() },
      ctx.signingPrivateKeyHex,
    );
    await c.query(
      `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
       VALUES($1, $2, $3, 'VALID', $4, $5)`,
      [tokenId, m.challenger_email, payout.toString(), issuedAt, sig],
    );
  } else {
    newBankroll = bankroll + bet;
    await c.query(
      `UPDATE trivia_sessions
       SET bankroll_remaining_base_units = $1::bigint,
           matches_won = matches_won + 1,
           last_match_at = now()
       WHERE id = $2`,
      [newBankroll.toString(), m.offerer_session_id],
    );
  }

  // 6. Auto-close if drained.
  let sessionStatus: 'OPEN' | 'CLOSED' = 'OPEN';
  let closedAt: Date | null = null;
  if (newBankroll < bet) {
    if (newBankroll > 0n) {
      const capBaseUnits = BigInt(ctx.mintMaxSupply) * BASE_UNITS_PER_RPOW;
      const supplyResult = await c.query(
        `UPDATE app_counters SET value = value + $1::bigint
         WHERE name = 'minted_supply' AND value + $1::bigint <= $2::bigint`,
        [newBankroll.toString(), capBaseUnits.toString()],
      );
      if ((supplyResult.rowCount ?? 0) === 0) {
        throw new Error('SUPPLY_CAP_REACHED');
      }
      const tokenId = randomUUID();
      const issuedAt = new Date();
      const ownerEmailHash = createHash('sha256').update(m.offerer_email).digest('hex');
      const sig = signTokenPayload(
        { id: tokenId, owner_email_hash: ownerEmailHash, value: newBankroll, issued_at: issuedAt.toISOString() },
        ctx.signingPrivateKeyHex,
      );
      await c.query(
        `INSERT INTO tokens(id, owner_email, value, state, issued_at, server_sig)
         VALUES($1, $2, $3, 'VALID', $4, $5)`,
        [tokenId, m.offerer_email, newBankroll.toString(), issuedAt, sig],
      );
    }
    const closeRes = await c.query<{ closed_at: Date }>(
      `UPDATE trivia_sessions
       SET status = 'CLOSED', closed_at = now()
       WHERE id = $1
       RETURNING closed_at`,
      [m.offerer_session_id],
    );
    sessionStatus = 'CLOSED';
    closedAt = closeRes.rows[0].closed_at;

    // SYSTEM chat row noting the drain. Look up the offerer's handle for the message body.
    const handleRes = await c.query<{ x_handle: string | null }>(
      `SELECT x_handle FROM users WHERE email = $1`,
      [m.offerer_email],
    );
    const handle = handleRes.rows[0]?.x_handle ?? m.offerer_email;
    await c.query(
      `INSERT INTO trivia_chat_messages(id, account_email, x_handle, kind, body)
       VALUES($1, NULL, NULL, 'SYSTEM', $2)`,
      [randomUUID(), `@${handle} drained out of the arena`],
    );
  }

  // 7. Build canonical payload, sign, write RESOLVED.
  const updateRes = await c.query<{ resolved_at: Date }>(
    `UPDATE trivia_matches
     SET state = 'RESOLVED', winner_email = $1, resolved_at = now()
     WHERE id = $2
     RETURNING resolved_at`,
    [winnerEmail, matchId],
  );
  const resolvedAt = updateRes.rows[0].resolved_at;

  const payload: MatchPayload = {
    id: matchId,
    offerer_email_hash: createHash('sha256').update(m.offerer_email).digest('hex'),
    challenger_email_hash: createHash('sha256').update(m.challenger_email).digest('hex'),
    bet_base_units: bet,
    question_id: m.question_id,
    offerer_choice_idx: m.offerer_choice_idx,
    offerer_answered_at: m.offerer_answered_at?.toISOString() ?? null,
    challenger_choice_idx: m.challenger_choice_idx,
    challenger_answered_at: m.challenger_answered_at?.toISOString() ?? null,
    winner_email_hash: createHash('sha256').update(winnerEmail).digest('hex'),
    created_at: m.created_at.toISOString(),
  };
  const signature = signMatchPayload(payload, ctx.signingPrivateKeyHex);

  await c.query(
    `UPDATE trivia_matches SET signature = $1 WHERE id = $2`,
    [signature, matchId],
  );

  return {
    winner_email: winnerEmail,
    signature,
    resolved_at: resolvedAt,
    session_status: sessionStatus,
    bankroll_remaining: newBankroll,
    closed_at: closedAt,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd apps/server && npx vitest run tests/triviaResolve.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/trivia/resolve.ts apps/server/tests/triviaResolve.test.ts
git commit -m "feat(trivia): resolveMatchTx — §4 rules, signing, auto-close"
```

---

## Task 3: POST /api/trivia/matches/start

**Files:**
- Modify: `apps/server/src/routes/trivia/matches.ts` (replace POST /matches/start stub)
- Test: `apps/server/tests/triviaMatchStart.test.ts` (create)

Behavior:
1. Auth + X-handle gate + allowlist gate (mirrors session enter).
2. `withTx`: SELECT FOR UPDATE the offerer session. Validate status/bankroll/self-challenge. `burnFromUser`. Decrement `minted_supply`. Pick a random question (`ORDER BY random() LIMIT 1` — small cache is fine; periodic refill keeps it healthy). Insert ACTIVE match (UNIQUE-per-session index returns 23505 → OFFER_UNAVAILABLE).
3. Reply with `match_id, question, choices, deadline_at, bet_base_units, question_id`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/triviaMatchStart.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string): Promise<string> {
  await ctx.pool.query(
    `INSERT INTO users(email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
    [email],
  );
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}
async function markVerified(pool: any, email: string, handle: string) {
  await pool.query(
    `UPDATE users SET x_handle = $1, x_handle_verified_at = now() WHERE email = $2`,
    [handle, email],
  );
}
async function seedToken(pool: any, email: string, value: bigint) {
  await pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, server_sig)
     VALUES($1, $2, $3, 'VALID', '\\x00')`,
    [randomUUID(), email, value.toString()],
  );
}
async function seedQuestion(pool: any, correctIdx = 1): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trivia_questions(id, category, difficulty, question, correct_idx, choices)
     VALUES($1, 'General', 'easy', 'capital of France?', $2, ARRAY['London','Paris','Berlin','Tokyo'])`,
    [id, correctIdx],
  );
  return id;
}
async function seedOfferer(ctx: any, email: string, handle: string, bet: bigint, bankroll: bigint): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  await markVerified(ctx.pool, email, handle);
  const id = randomUUID();
  await ctx.pool.query(
    `INSERT INTO trivia_sessions(id, account_email, bet_base_units,
       bankroll_initial_base_units, bankroll_remaining_base_units, status, opened_at)
     VALUES($1, $2, $3, $4, $5, 'OPEN', now())`,
    [id, email, bet.toString(), bankroll.toString(), bankroll.toString()],
  );
  // Also reflect the bankroll burn in supply for parity with the real enter flow.
  await ctx.pool.query(
    `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
    [bankroll.toString()],
  );
  return id;
}

describe('POST /api/trivia/matches/start', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { 'content-type': 'application/json' },
      payload: { session_id: randomUUID() },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 X_HANDLE_REQUIRED when challenger unverified', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'cha@x.com');
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('X_HANDLE_REQUIRED');
  });

  it('400 SELF_CHALLENGE if challenger owns the session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedQuestion(ctx.pool);
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    const cookie = await login(ctx, 'off@x.com');
    await seedToken(ctx.pool, 'off@x.com', 1000n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('SELF_CHALLENGE');
  });

  it('409 INSUFFICIENT_BALANCE when challenger has no tokens', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedQuestion(ctx.pool);
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    const cookie = await login(ctx, 'cha@x.com');
    await markVerified(ctx.pool, 'cha@x.com', 'cha');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('404 SESSION_NOT_FOUND when session id does not exist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedQuestion(ctx.pool);
    const cookie = await login(ctx, 'cha@x.com');
    await markVerified(ctx.pool, 'cha@x.com', 'cha');
    await seedToken(ctx.pool, 'cha@x.com', 1000n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: randomUUID() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('SESSION_NOT_FOUND');
  });

  it('503 NO_QUESTIONS_AVAILABLE when question pool is empty', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    const cookie = await login(ctx, 'cha@x.com');
    await markVerified(ctx.pool, 'cha@x.com', 'cha');
    await seedToken(ctx.pool, 'cha@x.com', 1000n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('NO_QUESTIONS_AVAILABLE');
  });

  it('happy path: creates ACTIVE match, burns bet, returns question + deadline', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedQuestion(ctx.pool);
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    const cookie = await login(ctx, 'cha@x.com');
    await markVerified(ctx.pool, 'cha@x.com', 'cha');
    await seedToken(ctx.pool, 'cha@x.com', 1000n);

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.match_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.question).toBe('capital of France?');
    expect(body.choices).toEqual(['London','Paris','Berlin','Tokyo']);
    expect(body.bet_base_units).toBe('10');
    expect(new Date(body.deadline_at).getTime()).toBeGreaterThan(Date.now());

    // Challenger's tokens should have been burned (1000 - 10 remaining).
    const tok = await ctx.pool.query(
      `SELECT COALESCE(SUM(value), 0)::text AS total FROM tokens
       WHERE owner_email = 'cha@x.com' AND state = 'VALID'`,
    );
    expect(tok.rows[0].total).toBe('990');

    // The match row exists in ACTIVE state.
    const mr = await ctx.pool.query(
      `SELECT state, offerer_session_id, offerer_email, challenger_email
       FROM trivia_matches WHERE id = $1`,
      [body.match_id],
    );
    expect(mr.rows[0]).toMatchObject({
      state: 'ACTIVE',
      offerer_session_id: sid,
      offerer_email: 'off@x.com',
      challenger_email: 'cha@x.com',
    });
  });

  it('409 OFFER_UNAVAILABLE when the session already has an active match', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedQuestion(ctx.pool);
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    const cookie = await login(ctx, 'cha@x.com');
    await markVerified(ctx.pool, 'cha@x.com', 'cha');
    await seedToken(ctx.pool, 'cha@x.com', 1000n);
    // First call succeeds.
    const r1 = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(r1.statusCode).toBe(200);
    // Second call (different challenger to avoid SELF_CHALLENGE), same session.
    const cookie2 = await login(ctx, 'cha2@x.com');
    await markVerified(ctx.pool, 'cha2@x.com', 'cha2');
    await seedToken(ctx.pool, 'cha2@x.com', 1000n);
    const r2 = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie: cookie2, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe('OFFER_UNAVAILABLE');
  });

  it('409 OFFER_UNAVAILABLE for CLOSED session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedQuestion(ctx.pool);
    const sid = await seedOfferer(ctx, 'off@x.com', 'off', 10n, 30n);
    await ctx.pool.query(`UPDATE trivia_sessions SET status = 'CLOSED', closed_at = now() WHERE id = $1`, [sid]);
    const cookie = await login(ctx, 'cha@x.com');
    await markVerified(ctx.pool, 'cha@x.com', 'cha');
    await seedToken(ctx.pool, 'cha@x.com', 1000n);
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/matches/start',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { session_id: sid },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('OFFER_UNAVAILABLE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd apps/server && npx vitest run tests/triviaMatchStart.test.ts
```

Expected: FAIL — all the happy-path tests get 501 from the existing stub.

- [ ] **Step 3: Replace the stub in matches.ts**

In `apps/server/src/routes/trivia/matches.ts`, **replace** the `POST /api/trivia/matches/start` stub with the real handler. Add at the top of the file (alongside existing imports):

```ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withTx } from '../../db.js';
import { burnFromUser } from '../../longshot/burn.js';
```

Add after the existing `formatMatch` helper:

```ts
const StartBody = z.object({
  session_id: z.string().uuid(),
});

function isAllowed(allowlistCsv: string, email: string): boolean {
  const trimmed = allowlistCsv.trim();
  if (trimmed === '*') return true;
  const emailLower = email.toLowerCase();
  return trimmed.split(',').map((e) => e.trim().toLowerCase()).includes(emailLower);
}
```

Replace the start stub block:

```ts
  app.post('/api/trivia/matches/start', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (req: any) => req.headers['x-forwarded-for'] ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const challengerEmail = s.email;

    if (!isAllowed(app.config.triviaAllowedEmails, challengerEmail)) {
      return reply.code(403).send({ error: 'NOT_ALLOWED', message: 'trivia access required' });
    }

    const challengerRes = await app.pool.query<{
      x_handle: string | null;
      x_handle_verified_at: Date | null;
    }>(
      `SELECT x_handle, x_handle_verified_at FROM users WHERE email = $1`,
      [challengerEmail],
    );
    const ch = challengerRes.rows[0];
    if (!ch || !ch.x_handle || !ch.x_handle_verified_at) {
      return reply.code(403).send({ error: 'X_HANDLE_REQUIRED', message: 'X handle verification required' });
    }

    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }
    const sessionId = parsed.data.session_id;

    type StartResult =
      | {
          ok: true;
          matchId: string;
          questionId: string;
          question: string;
          choices: string[];
          bet: bigint;
          deadlineAt: Date;
        }
      | { error: string; message: string; status: number };

    let result: StartResult;
    try {
      result = await withTx<StartResult>(app.pool, async (c) => {
        const sessRes = await c.query<{
          id: string;
          account_email: string;
          bet_base_units: string;
          bankroll_remaining_base_units: string;
          status: string;
        }>(
          `SELECT id, account_email, bet_base_units::text,
                  bankroll_remaining_base_units::text, status
           FROM trivia_sessions WHERE id = $1 FOR UPDATE`,
          [sessionId],
        );
        if (sessRes.rows.length === 0) {
          return { error: 'SESSION_NOT_FOUND', message: 'session not found', status: 404 };
        }
        const sess = sessRes.rows[0];
        if (sess.account_email === challengerEmail) {
          return { error: 'SELF_CHALLENGE', message: 'cannot challenge your own session', status: 400 };
        }
        const bet = BigInt(sess.bet_base_units);
        const bankroll = BigInt(sess.bankroll_remaining_base_units);
        if (sess.status !== 'OPEN' || bankroll < bet) {
          return { error: 'OFFER_UNAVAILABLE', message: 'session not open or bankroll insufficient', status: 409 };
        }

        // Pick a question at random from the cache. If empty, surface 503.
        const qRes = await c.query<{
          id: string; question: string; choices: string[];
        }>(
          `SELECT id, question, choices
           FROM trivia_questions
           ORDER BY random() LIMIT 1`,
        );
        if (qRes.rows.length === 0) {
          return { error: 'NO_QUESTIONS_AVAILABLE', message: 'no trivia questions cached', status: 503 };
        }
        const q = qRes.rows[0];

        // Burn challenger's bet and mirror minted_supply.
        await burnFromUser(c, challengerEmail, bet, app.config.signingPrivateKeyHex);
        await c.query(
          `UPDATE app_counters SET value = value - $1::bigint WHERE name = 'minted_supply'`,
          [bet.toString()],
        );

        const matchId = randomUUID();
        const deadlineSeconds = app.config.triviaMatchDeadlineSeconds;
        const insertRes = await c.query<{ deadline_at: Date }>(
          `INSERT INTO trivia_matches
             (id, offerer_session_id, offerer_email, challenger_email,
              bet_base_units, question_id, state, deadline_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', now() + ($7 || ' seconds')::interval)
           RETURNING deadline_at`,
          [matchId, sessionId, sess.account_email, challengerEmail,
           bet.toString(), q.id, String(deadlineSeconds)],
        );

        return {
          ok: true,
          matchId,
          questionId: q.id,
          question: q.question,
          choices: q.choices,
          bet,
          deadlineAt: insertRes.rows[0].deadline_at,
        };
      });
    } catch (e: any) {
      if (e?.message === 'INSUFFICIENT_BALANCE') {
        return reply.code(409).send({ error: 'INSUFFICIENT_BALANCE', message: 'not enough tokens' });
      }
      // UNIQUE partial-index conflict on offerer_session_id WHERE state='ACTIVE'
      if (e?.code === '23505') {
        return reply.code(409).send({ error: 'OFFER_UNAVAILABLE', message: 'session already has an active match' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    return reply.code(200).send({
      match_id: result.matchId,
      question_id: result.questionId,
      question: result.question,
      choices: result.choices,
      bet_base_units: result.bet.toString(),
      deadline_at: result.deadlineAt.toISOString(),
    });
  });
```

- [ ] **Step 4: Run test to verify it passes**

```
cd apps/server && npx vitest run tests/triviaMatchStart.test.ts
```

Expected: PASS, 8 tests. Also run the previous tests to confirm nothing regressed:

```
cd apps/server && npx vitest run tests/triviaResolve.test.ts tests/triviaSigning.test.ts
```

Expected: still PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/trivia/matches.ts apps/server/tests/triviaMatchStart.test.ts
git commit -m "feat(trivia): POST /matches/start — challenge + burn + question pick"
```

---

## Task 4: POST /api/trivia/matches/:id/answer

**Files:**
- Modify: `apps/server/src/routes/trivia/matches.ts` (replace the answer stub)
- Test: `apps/server/tests/triviaMatchAnswer.test.ts` (create)

Behavior:
1. Auth required. Validate body `{ choice_idx: 0..3 }`.
2. `withTx`: SELECT FOR UPDATE the match. Require `state='ACTIVE'` AND `now() < deadline_at` (postgres compares — `MATCH_EXPIRED` otherwise). Determine which side caller is. Require they haven't answered. UPDATE the row with the choice + `answered_at = now()`.
3. Re-fetch the row to see if both sides have now answered. If yes → call `resolveMatchTx`. (The caller already holds the FOR UPDATE lock; `resolveMatchTx` will re-lock idempotently.)
4. Reply with `{ answered_at, both_answered }`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/triviaMatchAnswer.test.ts`. (Shares the same `login`/`markVerified`/`seedToken`/`seedQuestion`/`seedOfferer` helpers as Task 3 — duplicate them at the top of this file rather than refactoring, to keep tests independent.)

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}
async function markVerified(pool: any, email: string, handle: string) {
  await pool.query(
    `UPDATE users SET x_handle = $1, x_handle_verified_at = now() WHERE email = $2`,
    [handle, email],
  );
}
async function seedToken(pool: any, email: string, value: bigint) {
  await pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, server_sig)
     VALUES($1, $2, $3, 'VALID', '\\x00')`,
    [randomUUID(), email, value.toString()],
  );
}
async function seedQuestion(pool: any, correctIdx = 1): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trivia_questions(id, category, difficulty, question, correct_idx, choices)
     VALUES($1, 'General', 'easy', 'capital of France?', $2, ARRAY['London','Paris','Berlin','Tokyo'])`,
    [id, correctIdx],
  );
  return id;
}

/** Start a match via the real endpoint so the seeded state is realistic. */
async function startMatch(ctx: any): Promise<{ matchId: string; sessionId: string; offererCookie: string; challengerCookie: string }> {
  await seedQuestion(ctx.pool);
  // Seed offerer with a session.
  await ctx.pool.query(`INSERT INTO users(email) VALUES ('off@x.com') ON CONFLICT DO NOTHING`);
  await markVerified(ctx.pool, 'off@x.com', 'off');
  const sessionId = randomUUID();
  await ctx.pool.query(
    `INSERT INTO trivia_sessions(id, account_email, bet_base_units,
       bankroll_initial_base_units, bankroll_remaining_base_units, status, opened_at)
     VALUES($1, 'off@x.com', 10, 30, 30, 'OPEN', now())`,
    [sessionId],
  );
  await ctx.pool.query(`UPDATE app_counters SET value = value - 30 WHERE name = 'minted_supply'`);
  // Seed + verify challenger with tokens.
  const challengerCookie = await login(ctx, 'cha@x.com');
  await markVerified(ctx.pool, 'cha@x.com', 'cha');
  await seedToken(ctx.pool, 'cha@x.com', 1000n);
  const offererCookie = await login(ctx, 'off@x.com');
  // Start the match via the route.
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/trivia/matches/start',
    headers: { cookie: challengerCookie, 'content-type': 'application/json' },
    payload: { session_id: sessionId },
  });
  expect(res.statusCode).toBe(200);
  return { matchId: res.json().match_id, sessionId, offererCookie, challengerCookie };
}

describe('POST /api/trivia/matches/:id/answer', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId } = await startMatch(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('400 BAD_REQUEST for out-of-range choice_idx', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie } = await startMatch(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 99 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });

  it('404 MATCH_NOT_FOUND for unknown id', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { offererCookie } = await startMatch(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${randomUUID()}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('MATCH_NOT_FOUND');
  });

  it('403 NOT_A_PLAYER for a third-party email', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId } = await startMatch(ctx);
    const cookie = await login(ctx, 'other@x.com');
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_A_PLAYER');
  });

  it('happy path single-side: records answer, both_answered=false', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie } = await startMatch(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().both_answered).toBe(false);
    expect(typeof res.json().answered_at).toBe('string');
    // Match still ACTIVE.
    const m = await ctx.pool.query(
      `SELECT state, offerer_choice_idx FROM trivia_matches WHERE id = $1`,
      [matchId],
    );
    expect(m.rows[0]).toMatchObject({ state: 'ACTIVE', offerer_choice_idx: 1 });
  });

  it('409 ALREADY_ANSWERED on second submission from same side', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie } = await startMatch(ctx);
    const r1 = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 2 },
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe('ALREADY_ANSWERED');
  });

  it('both sides answer → match resolves and both_answered=true on the second answer', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie, challengerCookie } = await startMatch(ctx);
    const r1 = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 }, // correct
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().both_answered).toBe(false);

    const r2 = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: challengerCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 3 }, // wrong
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().both_answered).toBe(true);

    const m = await ctx.pool.query(
      `SELECT state, winner_email, resolved_at, signature
       FROM trivia_matches WHERE id = $1`,
      [matchId],
    );
    expect(m.rows[0].state).toBe('RESOLVED');
    expect(m.rows[0].winner_email).toBe('off@x.com');
    expect(m.rows[0].resolved_at).not.toBeNull();
    expect(m.rows[0].signature).not.toBeNull();
  });

  it('410 MATCH_EXPIRED if deadline passed before answer arrives', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie } = await startMatch(ctx);
    // Force the deadline into the past.
    await ctx.pool.query(
      `UPDATE trivia_matches SET deadline_at = now() - interval '1 second' WHERE id = $1`,
      [matchId],
    );
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('MATCH_EXPIRED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd apps/server && npx vitest run tests/triviaMatchAnswer.test.ts
```

Expected: FAIL — answer stub still returns 501.

- [ ] **Step 3: Implement the answer endpoint**

Add an import at the top of `apps/server/src/routes/trivia/matches.ts`:

```ts
import { resolveMatchTx } from '../../trivia/resolve.js';
```

Define the body schema near the `StartBody` one:

```ts
const AnswerBody = z.object({
  choice_idx: z.number().int().min(0).max(3),
});
```

Replace the `POST /api/trivia/matches/:id/answer` stub:

```ts
  app.post('/api/trivia/matches/:id/answer', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (req: any) => req.headers['x-forwarded-for'] ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const caller = s.email;

    const parsed = AnswerBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }
    const choiceIdx = parsed.data.choice_idx;
    const { id: matchId } = req.params as { id: string };

    type AnswerResult =
      | { ok: true; answeredAt: Date; bothAnswered: boolean }
      | { error: string; message: string; status: number };

    let result: AnswerResult;
    try {
      result = await withTx<AnswerResult>(app.pool, async (c) => {
        const mRes = await c.query<{
          state: string;
          offerer_email: string;
          challenger_email: string;
          offerer_choice_idx: number | null;
          challenger_choice_idx: number | null;
          expired: boolean;
        }>(
          `SELECT state, offerer_email, challenger_email,
                  offerer_choice_idx, challenger_choice_idx,
                  (now() >= deadline_at) AS expired
           FROM trivia_matches WHERE id = $1 FOR UPDATE`,
          [matchId],
        );
        if (mRes.rows.length === 0) {
          return { error: 'MATCH_NOT_FOUND', message: 'match not found', status: 404 };
        }
        const m = mRes.rows[0];
        if (m.state !== 'ACTIVE') {
          return { error: 'MATCH_EXPIRED', message: 'match is not active', status: 410 };
        }
        if (m.expired) {
          return { error: 'MATCH_EXPIRED', message: 'deadline passed', status: 410 };
        }
        const isOfferer = m.offerer_email === caller;
        const isChallenger = m.challenger_email === caller;
        if (!isOfferer && !isChallenger) {
          return { error: 'NOT_A_PLAYER', message: 'not a player of this match', status: 403 };
        }
        const alreadyAnswered = isOfferer ? m.offerer_choice_idx !== null : m.challenger_choice_idx !== null;
        if (alreadyAnswered) {
          return { error: 'ALREADY_ANSWERED', message: 'you already answered', status: 409 };
        }

        const col = isOfferer ? 'offerer' : 'challenger';
        const upd = await c.query<{ answered_at: Date }>(
          `UPDATE trivia_matches
           SET ${col}_choice_idx = $1, ${col}_answered_at = now()
           WHERE id = $2
           RETURNING ${col}_answered_at AS answered_at`,
          [choiceIdx, matchId],
        );

        const both = isOfferer
          ? m.challenger_choice_idx !== null
          : m.offerer_choice_idx !== null;

        if (both) {
          await resolveMatchTx(c, matchId, {
            signingPrivateKeyHex: app.config.signingPrivateKeyHex,
            mintMaxSupply: app.config.mintMaxSupply,
          });
        }

        return { ok: true, answeredAt: upd.rows[0].answered_at, bothAnswered: both };
      });
    } catch (e: any) {
      if (e?.message === 'SUPPLY_CAP_REACHED') {
        return reply.code(503).send({ error: 'SUPPLY_CAP_REACHED', message: 'minted supply cap reached' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    return reply.code(200).send({
      answered_at: result.answeredAt.toISOString(),
      both_answered: result.bothAnswered,
    });
  });
```

Note on the dynamic column name (`${col}_choice_idx`): `col` is hardcoded to `'offerer'` or `'challenger'` — never user input — so this is safe from injection. We could parameterize via a switch but the explicit pair would be more verbose and no safer.

- [ ] **Step 4: Run test to verify it passes**

```
cd apps/server && npx vitest run tests/triviaMatchAnswer.test.ts
```

Expected: PASS, 8 tests.

```
cd apps/server && npx vitest run tests/triviaResolve.test.ts tests/triviaSigning.test.ts tests/triviaMatchStart.test.ts
```

Expected: still PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/trivia/matches.ts apps/server/tests/triviaMatchAnswer.test.ts
git commit -m "feat(trivia): POST /matches/:id/answer — server-stamped + auto-resolve"
```

---

## Task 5: GET /api/trivia/matches/active + GET /api/trivia/matches/:id

**Files:**
- Modify: `apps/server/src/routes/trivia/matches.ts` (replace both GET stubs)
- Test: `apps/server/tests/triviaMatchPolls.test.ts` (create)

Behavior:

**GET /matches/active?session_id=X** (offerer poll):
- Auth required.
- Caller must own the session (else 403).
- Look up the in-flight match for that session. If none → `{ match: null }`.
- If found AND `state='ACTIVE'` AND deadline passed → `resolveMatchTx` then re-fetch.
- If `state='RESOLVED'` AND `resolved_at` within last 5 seconds → return the final state so the offerer's UI gets the result.
- Otherwise return the full active-match payload (question, choices, deadline, who has answered, etc.).

**GET /matches/:id** (both sides poll):
- Auth required.
- Caller must be offerer or challenger of this match (else 403).
- If `state='ACTIVE'` AND deadline passed → `resolveMatchTx` then re-fetch.
- Return full match payload (question, both choices once revealed, winner/signature if RESOLVED).

For both endpoints, the response shape includes the question text + choices so the offerer's auto-opened modal can render without an extra round trip.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/triviaMatchPolls.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users(email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}
async function markVerified(pool: any, email: string, handle: string) {
  await pool.query(`UPDATE users SET x_handle = $1, x_handle_verified_at = now() WHERE email = $2`, [handle, email]);
}
async function seedToken(pool: any, email: string, value: bigint) {
  await pool.query(
    `INSERT INTO tokens(id, owner_email, value, state, server_sig)
     VALUES($1, $2, $3, 'VALID', '\\x00')`,
    [randomUUID(), email, value.toString()],
  );
}
async function seedQuestion(pool: any, correctIdx = 1): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trivia_questions(id, category, difficulty, question, correct_idx, choices)
     VALUES($1, 'General', 'easy', 'capital of France?', $2, ARRAY['London','Paris','Berlin','Tokyo'])`,
    [id, correctIdx],
  );
  return id;
}

async function setupMatch(ctx: any) {
  await seedQuestion(ctx.pool);
  await ctx.pool.query(`INSERT INTO users(email) VALUES ('off@x.com') ON CONFLICT DO NOTHING`);
  await markVerified(ctx.pool, 'off@x.com', 'off');
  const sessionId = randomUUID();
  await ctx.pool.query(
    `INSERT INTO trivia_sessions(id, account_email, bet_base_units,
       bankroll_initial_base_units, bankroll_remaining_base_units, status, opened_at)
     VALUES($1, 'off@x.com', 10, 30, 30, 'OPEN', now())`,
    [sessionId],
  );
  await ctx.pool.query(`UPDATE app_counters SET value = value - 30 WHERE name = 'minted_supply'`);
  const challengerCookie = await login(ctx, 'cha@x.com');
  await markVerified(ctx.pool, 'cha@x.com', 'cha');
  await seedToken(ctx.pool, 'cha@x.com', 1000n);
  const offererCookie = await login(ctx, 'off@x.com');
  const r = await ctx.app.inject({
    method: 'POST', url: '/api/trivia/matches/start',
    headers: { cookie: challengerCookie, 'content-type': 'application/json' },
    payload: { session_id: sessionId },
  });
  expect(r.statusCode).toBe(200);
  return { matchId: r.json().match_id, sessionId, offererCookie, challengerCookie };
}

describe('GET /api/trivia/matches/active', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/trivia/matches/active?session_id=${randomUUID()}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 when caller does not own the session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { sessionId } = await setupMatch(ctx);
    const cookie = await login(ctx, 'someone-else@x.com');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/trivia/matches/active?session_id=${sessionId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns { match: null } when no active match', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('off@x.com') ON CONFLICT DO NOTHING`);
    await markVerified(ctx.pool, 'off@x.com', 'off');
    const sessionId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO trivia_sessions(id, account_email, bet_base_units,
         bankroll_initial_base_units, bankroll_remaining_base_units, status, opened_at)
       VALUES($1, 'off@x.com', 10, 30, 30, 'OPEN', now())`,
      [sessionId],
    );
    const cookie = await login(ctx, 'off@x.com');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/trivia/matches/active?session_id=${sessionId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().match).toBeNull();
  });

  it('returns the active match for the offerer with question + choices', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, sessionId, offererCookie } = await setupMatch(ctx);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/trivia/matches/active?session_id=${sessionId}`,
      headers: { cookie: offererCookie },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json().match;
    expect(m.id).toBe(matchId);
    expect(m.state).toBe('ACTIVE');
    expect(m.question).toBe('capital of France?');
    expect(m.choices).toEqual(['London','Paris','Berlin','Tokyo']);
    expect(m.offerer_answered).toBe(false);
    expect(m.challenger_answered).toBe(false);
  });

  it('lazy-resolves a stale ACTIVE match when polled after deadline', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, sessionId, offererCookie } = await setupMatch(ctx);
    await ctx.pool.query(
      `UPDATE trivia_matches SET deadline_at = now() - interval '1 second' WHERE id = $1`,
      [matchId],
    );
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/trivia/matches/active?session_id=${sessionId}`,
      headers: { cookie: offererCookie },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json().match;
    expect(m.id).toBe(matchId);
    expect(m.state).toBe('RESOLVED');
    expect(m.winner_email).toBe('off@x.com'); // both timed out, offerer wins
    expect(m.signature_hex).toMatch(/^[0-9a-f]+$/);
  });
});

describe('GET /api/trivia/matches/:id', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId } = await setupMatch(ctx);
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/trivia/matches/${matchId}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 for non-player', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId } = await setupMatch(ctx);
    const cookie = await login(ctx, 'rando@x.com');
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/trivia/matches/${matchId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns ACTIVE state for the challenger', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, challengerCookie } = await setupMatch(ctx);
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/trivia/matches/${matchId}`,
      headers: { cookie: challengerCookie },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json().match;
    expect(m.state).toBe('ACTIVE');
    expect(m.question).toBe('capital of France?');
    expect(m.offerer_choice_idx).toBeNull();
    expect(m.challenger_choice_idx).toBeNull();
  });

  it('returns RESOLVED state with winner + signature after both answer', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, offererCookie, challengerCookie } = await setupMatch(ctx);
    await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: offererCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/trivia/matches/${matchId}/answer`,
      headers: { cookie: challengerCookie, 'content-type': 'application/json' },
      payload: { choice_idx: 1 },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/trivia/matches/${matchId}`,
      headers: { cookie: offererCookie },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json().match;
    expect(m.state).toBe('RESOLVED');
    expect(m.offerer_choice_idx).toBe(1);
    expect(m.challenger_choice_idx).toBe(1);
    expect(m.correct_choice_idx).toBe(1);
    expect(m.signature_hex).toMatch(/^[0-9a-f]+$/);
  });

  it('lazy-resolves on deadline-passed read', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const { matchId, challengerCookie } = await setupMatch(ctx);
    await ctx.pool.query(
      `UPDATE trivia_matches SET deadline_at = now() - interval '1 second' WHERE id = $1`,
      [matchId],
    );
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/trivia/matches/${matchId}`,
      headers: { cookie: challengerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().match.state).toBe('RESOLVED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd apps/server && npx vitest run tests/triviaMatchPolls.test.ts
```

Expected: FAIL — both polling stubs still return 501.

- [ ] **Step 3: Implement both poll endpoints**

In `apps/server/src/routes/trivia/matches.ts`, add a shared formatter near `formatMatch`:

```ts
type PollMatchRow = {
  id: string;
  state: 'ACTIVE' | 'RESOLVED';
  offerer_email: string;
  challenger_email: string;
  offerer_x_handle: string | null;
  challenger_x_handle: string | null;
  bet_base_units: string;
  question_id: string;
  question: string;
  choices: string[];
  correct_idx: number;
  offerer_choice_idx: number | null;
  offerer_answered_at: Date | null;
  challenger_choice_idx: number | null;
  challenger_answered_at: Date | null;
  winner_email: string | null;
  signature: Buffer | null;
  deadline_at: Date;
  created_at: Date;
  resolved_at: Date | null;
};

function formatPollMatch(r: PollMatchRow) {
  const resolved = r.state === 'RESOLVED';
  return {
    id: r.id,
    state: r.state,
    offerer_email: r.offerer_email,
    challenger_email: r.challenger_email,
    offerer_x_handle: r.offerer_x_handle ?? null,
    challenger_x_handle: r.challenger_x_handle ?? null,
    bet_base_units: r.bet_base_units,
    question_id: r.question_id,
    question: r.question,
    choices: r.choices,
    // Don't leak the correct answer while the match is still active.
    correct_choice_idx: resolved ? r.correct_idx : null,
    offerer_choice_idx: r.offerer_choice_idx,
    offerer_answered: r.offerer_choice_idx !== null,
    offerer_answered_at: r.offerer_answered_at?.toISOString() ?? null,
    challenger_choice_idx: r.challenger_choice_idx,
    challenger_answered: r.challenger_choice_idx !== null,
    challenger_answered_at: r.challenger_answered_at?.toISOString() ?? null,
    winner_email: r.winner_email,
    signature_hex: r.signature ? Buffer.from(r.signature).toString('hex') : null,
    deadline_at: r.deadline_at.toISOString(),
    created_at: r.created_at.toISOString(),
    resolved_at: r.resolved_at?.toISOString() ?? null,
  };
}

const POLL_MATCH_SELECT = `
  SELECT
    m.id, m.state,
    m.offerer_email, m.challenger_email,
    off_user.x_handle AS offerer_x_handle,
    cha_user.x_handle AS challenger_x_handle,
    m.bet_base_units::text,
    m.question_id, q.question, q.choices, q.correct_idx,
    m.offerer_choice_idx, m.offerer_answered_at,
    m.challenger_choice_idx, m.challenger_answered_at,
    m.winner_email, m.signature,
    m.deadline_at, m.created_at, m.resolved_at
  FROM trivia_matches m
  JOIN trivia_questions q ON q.id = m.question_id
  LEFT JOIN users off_user ON off_user.email = m.offerer_email
  LEFT JOIN users cha_user ON cha_user.email = m.challenger_email
`;
```

Replace the `GET /api/trivia/matches/active` stub:

```ts
  app.get('/api/trivia/matches/active', async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const query = req.query as Record<string, string | undefined>;
    const sessionId = query['session_id'];
    if (!sessionId) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'session_id required' });
    }

    // Ownership check.
    const sessRes = await app.pool.query<{ account_email: string }>(
      `SELECT account_email FROM trivia_sessions WHERE id = $1`,
      [sessionId],
    );
    if (sessRes.rows.length === 0) {
      return reply.code(404).send({ error: 'SESSION_NOT_FOUND', message: 'session not found' });
    }
    if (sessRes.rows[0].account_email !== s.email) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'not your session' });
    }

    // Find the most recent match for this session. ACTIVE always wins;
    // otherwise fall back to a very recent RESOLVED one so the offerer's
    // UI can render the result for ~5s.
    const matchRes = await app.pool.query<PollMatchRow & { expired: boolean }>(
      `${POLL_MATCH_SELECT}
       WHERE m.offerer_session_id = $1
         AND (m.state = 'ACTIVE'
              OR (m.state = 'RESOLVED' AND m.resolved_at > now() - interval '5 seconds'))
       ORDER BY m.created_at DESC LIMIT 1`,
      [sessionId],
    );
    if (matchRes.rows.length === 0) {
      return reply.code(200).send({ match: null });
    }
    let row = matchRes.rows[0];

    // Lazy resolve if ACTIVE but deadline has passed.
    if (row.state === 'ACTIVE' && row.deadline_at.getTime() <= Date.now()) {
      try {
        await withTx(app.pool, async (c) => {
          await resolveMatchTx(c, row.id, {
            signingPrivateKeyHex: app.config.signingPrivateKeyHex,
            mintMaxSupply: app.config.mintMaxSupply,
          });
        });
      } catch (e: any) {
        if (e?.message !== 'SUPPLY_CAP_REACHED') throw e;
        return reply.code(503).send({ error: 'SUPPLY_CAP_REACHED', message: 'minted supply cap reached' });
      }
      const refetch = await app.pool.query<PollMatchRow>(
        `${POLL_MATCH_SELECT} WHERE m.id = $1`,
        [row.id],
      );
      row = refetch.rows[0];
    }

    return reply.code(200).send({ match: formatPollMatch(row) });
  });
```

Replace the `GET /api/trivia/matches/:id` stub. Keep it registered LAST in `matchesRoutes` (the existing file already does this and the comment explains why):

```ts
  app.get('/api/trivia/matches/:id', async (req, reply) => {
    const sSess = readSession(req as any, app.config.sessionSecret);
    if (!sSess) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });
    const { id: mid } = req.params as { id: string };

    const r = await app.pool.query<PollMatchRow>(
      `${POLL_MATCH_SELECT} WHERE m.id = $1`,
      [mid],
    );
    if (r.rows.length === 0) {
      return reply.code(404).send({ error: 'MATCH_NOT_FOUND', message: 'match not found' });
    }
    let row = r.rows[0];

    if (row.offerer_email !== sSess.email && row.challenger_email !== sSess.email) {
      return reply.code(403).send({ error: 'NOT_A_PLAYER', message: 'not a player of this match' });
    }

    if (row.state === 'ACTIVE' && row.deadline_at.getTime() <= Date.now()) {
      try {
        await withTx(app.pool, async (c) => {
          await resolveMatchTx(c, mid, {
            signingPrivateKeyHex: app.config.signingPrivateKeyHex,
            mintMaxSupply: app.config.mintMaxSupply,
          });
        });
      } catch (e: any) {
        if (e?.message !== 'SUPPLY_CAP_REACHED') throw e;
        return reply.code(503).send({ error: 'SUPPLY_CAP_REACHED', message: 'minted supply cap reached' });
      }
      const refetch = await app.pool.query<PollMatchRow>(
        `${POLL_MATCH_SELECT} WHERE m.id = $1`,
        [mid],
      );
      row = refetch.rows[0];
    }

    return reply.code(200).send({ match: formatPollMatch(row) });
  });
```

- [ ] **Step 4: Run test to verify it passes**

```
cd apps/server && npx vitest run tests/triviaMatchPolls.test.ts
```

Expected: PASS, 9 tests.

```
cd apps/server && npx vitest run tests/trivia
```

Expected: every trivia test still passes.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/trivia/matches.ts apps/server/tests/triviaMatchPolls.test.ts
git commit -m "feat(trivia): GET /matches/active + /matches/:id with lazy resolution"
```

---

## Task 6: Trim 501-stub test + final sanity check

**Files:**
- Delete: `apps/server/tests/triviaRoutes.test.ts`

The 501-stub test file existed for slice 1/2 to assert "endpoints not implemented yet". Now that every endpoint in the file is real, the test file is obsolete (and would fail because the endpoints no longer return 501).

- [ ] **Step 1: Verify the file's tests now fail**

```
cd apps/server && npx vitest run tests/triviaRoutes.test.ts
```

Expected: FAIL on all 4 stubs (the endpoints return 200/400/etc. now instead of 501).

- [ ] **Step 2: Delete the file**

```bash
git rm apps/server/tests/triviaRoutes.test.ts
```

- [ ] **Step 3: Run the entire trivia test suite**

```
cd apps/server && npx vitest run tests/trivia
```

Expected: every test passes; no remaining `501`-stub assertions.

- [ ] **Step 4: Run the entire server test suite**

```
cd apps/server && npx vitest run
```

Expected: all tests pass. No regressions from the new resolve/sign code paths.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(trivia): drop slice-1 501-stub test file — all routes implemented"
```

---

## Self-Review (controller — not for the implementer)

**Spec coverage check:**

| Spec § | Implemented in | Notes |
|---|---|---|
| §4 resolution table — row 1 (both correct, offerer faster) | Task 2 test | row-1 |
| §4 row 2 (challenger faster) | Task 2 test | row-2 + mint check |
| §4 row 3 (offerer correct, challenger wrong) | Task 2 test | row-3 |
| §4 row 4 (offerer wrong, challenger correct) | Task 2 test | row-4 |
| §4 row 5 (both wrong/timeout) | Task 2 tests | row-5 + row-5b (null/timeout) |
| §4 row 6 (tie → offerer) | Task 2 test | row-6 |
| Auto-close + drain SYSTEM chat | Task 2 test | "auto-closes the session…" |
| Idempotent resolveMatchTx | Task 2 test | "is idempotent…" |
| ed25519 signature verifies | Task 2 test | "signs the canonical payload…" |
| Signing canonical payload stability | Task 1 tests | 4 sigtests |
| Match start happy path + errors | Task 3 tests | 8 cases |
| OFFER_UNAVAILABLE on second start (unique partial index) | Task 3 test | |
| NO_QUESTIONS_AVAILABLE on empty cache | Task 3 test | |
| SELF_CHALLENGE, X_HANDLE_REQUIRED, INSUFFICIENT_BALANCE | Task 3 tests | |
| Answer happy + both_answered transition | Task 4 tests | resolves on second answer |
| MATCH_EXPIRED via past deadline | Task 4 test | |
| ALREADY_ANSWERED, NOT_A_PLAYER, BAD_REQUEST | Task 4 tests | |
| GET /matches/active — null + active + lazy resolve + 5s window | Task 5 tests | offerer-only |
| GET /matches/active — 403 not-owner | Task 5 test | |
| GET /matches/:id — both sides, lazy resolve, 403 non-player | Task 5 tests | |
| `correct_choice_idx` hidden until RESOLVED | Task 5 formatter | enforced via `resolved ? r.correct_idx : null` |
| 501 stubs removed | Task 6 | file deleted |

**Placeholder scan:** No "TODO" / "add appropriate" / "similar to" in any task — every step has full code.

**Type consistency:** `MatchPayload`, `ResolveCtx`, `ResolveResult`, `resolveMatchTx`, `PollMatchRow`, `formatPollMatch`, `POLL_MATCH_SELECT`, `StartBody`, `AnswerBody` — names and shapes used identically across tasks 1–5.

**Cross-cutting carry-over:** `signMatchPayload` / `verifyMatchPayload` from Task 1 are imported in Task 2 (`resolve.ts`) and Task 2's tests. `resolveMatchTx` from Task 2 is imported in Tasks 4 and 5. `withTx`, `burnFromUser`, `readSession`, `isAllowed` reused identically to gladiator/sessions.

**Slice scope:** Backend-only, fully testable. Frontend (TriviaMatchModal, polling cadence) is slice 5. Deploy (nginx + Netlify site for trivia.rpow2.com) is slice 6 — though the nginx routing for /api/trivia/ has already been applied to prod.
