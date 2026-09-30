# Trivia Slice 2 — Sessions + lobby + chat + stats + read endpoints

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flesh out every endpoint that doesn't depend on a live match. After this slice the trivia arena is browsable + chattable + enter/leaveable, but you can't actually challenge anyone yet (POST `/matches/start` stays 501 until slice 3).

**Architecture:** Mirror gladiator slice 3 + slice 5. Sessions use `withTx` + `burnFromUser` + `minted_supply -= bankroll` (the post-cleanup pattern). Lobby/chat/recent are simple read endpoints. The only deviations from the gladiator analogues: (a) trivia uses `matches_won/matches_lost` instead of `flips_won/flips_lost`, (b) trivia chat already filters `kind = 'USER'` at SQL level per the spec.

**Tech Stack:** Same as slice 1 — Postgres 17, Fastify 4, zod, ed25519 signing.

---

## Spec reference

`docs/superpowers/specs/2026-05-11-trivia-pvp-design.md` — §6 lists the endpoints, §7A covers enter, §7G covers chat. Resolution flow (§7B/C/D) is OUT OF SCOPE — that's slice 3.

## File structure

**Replace 501 stubs in:**

- `apps/server/src/routes/trivia/sessions.ts` — POST `/sessions`, POST `/sessions/:id/close`
- `apps/server/src/routes/trivia/lobby.ts` — GET `/lobby`
- `apps/server/src/routes/trivia/chat.ts` — GET `/chat`, POST `/chat`
- `apps/server/src/routes/trivia/stats.ts` — GET `/stats`
- `apps/server/src/routes/trivia/me.ts` — GET `/me`
- `apps/server/src/routes/trivia/matches.ts` — replace `/matches/recent` and `/matches/history` stubs with real impl (returns empty arrays until slice 3 actually creates matches). Leave `/matches/start`, `/matches/active`, `/matches/:id`, `/matches/:id/answer` as 501 stubs.

**Create test files:**

- `apps/server/tests/triviaSessions.test.ts` — enter + leave coverage
- `apps/server/tests/triviaLobby.test.ts` — lobby listing
- `apps/server/tests/triviaChat.test.ts` — read + write coverage
- `apps/server/tests/triviaStats.test.ts` — aggregate query coverage
- `apps/server/tests/triviaMe.test.ts` — /me response shape
- `apps/server/tests/triviaMatchReads.test.ts` — /matches/recent + /matches/history (empty + with hand-crafted rows)

**Modify:**

- `apps/server/tests/triviaRoutes.test.ts` — drop the now-implemented endpoints from the 501-stub list (keep only `/matches/start`, `/matches/active`, `/matches/:id`, `/matches/:id/answer`)

## Design decisions locked

1. **Chat read filters at SQL.** Server `WHERE kind = 'USER'` LIMIT 100. Same lesson learned from gladiator chat cleanup.
2. **Allowlist enforced** on POST `/sessions` only (not close — users can always retrieve their tokens). Mirrors gladiator's slice-3 cleanup.
3. **No SYSTEM chat row** for enter/leave by default. Spec §7G is silent on this; gladiator's chat-flood cleanup taught us to keep chat clean. Skip the SYSTEM inserts.
4. **`stats` endpoint** shape mirrors gladiator: `{ total_matches, total_volume_base_units, total_verified_users, open_arena_count }`. Names tweaked: `total_matches` not `total_flips`; `open_arena_count` is the count of OPEN trivia sessions.
5. **/me response shape:**

```ts
{
  email: string;
  x_handle: string | null;
  x_handle_verified_at: string | null;  // ISO
  x_avatar_url: string | null;
  open_session: TriviaSession | null;
  career: { wins: number; losses: number };  // counted from trivia_matches
}
```

6. **`/matches/recent` and `/matches/history`** join to `users` for x_handles. Always return RESOLVED matches only.

---

## Task 1: `POST /sessions` and `POST /sessions/:id/close`

**Files:**
- Modify: `apps/server/src/routes/trivia/sessions.ts`
- Create: `apps/server/tests/triviaSessions.test.ts`

Mirror `apps/server/src/routes/gladiator/sessions.ts` exactly, with these renames:
- Table: `gladiator_sessions` → `trivia_sessions`
- Counter columns: `flips_won/flips_lost` → `matches_won/matches_lost`
- Last-activity column: `last_flip_at` → `last_match_at`
- Env vars: `gladiator*` → `trivia*` (use `app.config.triviaMinBetBaseUnits`, `triviaMaxBetBaseUnits`, `triviaMaxBankrollBaseUnits`, `triviaAllowedEmails`)
- Chat table: `gladiator_chat_messages` → `trivia_chat_messages`
- **Drop the SYSTEM chat inserts for enter/leave** (gladiator does these; trivia keeps chat quieter)

- [ ] **Step 1.1: Write the failing test file**

Create `apps/server/tests/triviaSessions.test.ts`. Use `apps/server/tests/gladiatorSessions.test.ts` as the structural template. Adapt every endpoint URL to `/api/trivia/*`, every table name, every column name. Cover:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);
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

const DEFAULT_BET = '10';
const DEFAULT_BANKROLL = '100';

describe('POST /api/trivia/sessions', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/sessions',
      headers: { 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 X_HANDLE_REQUIRED for unverified user', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('X_HANDLE_REQUIRED');
  });

  it('403 NOT_ALLOWED when user not on triviaAllowedEmails', async () => {
    const ctx = await makeTestApp({ triviaAllowedEmails: 'someone-else@example.com' });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_ALLOWED');
  });

  it('400 BAD_REQUEST for non-numeric strings', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: 'abc', bet_base_units: 'def' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 STAKE_OUT_OF_RANGE for bet below min', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: '50', bet_base_units: '5' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('STAKE_OUT_OF_RANGE');
  });

  it('400 BANKROLL_NOT_MULTIPLE when bankroll % bet != 0', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: '95', bet_base_units: '10' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BANKROLL_NOT_MULTIPLE');
  });

  it('409 INSUFFICIENT_BALANCE when user has no tokens', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('happy path: opens session, burns tokens, decrements supply', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    await seedToken(ctx.pool, 'a@b.com', 200n);
    await ctx.pool.query(`UPDATE app_counters SET value = 200 WHERE name = 'minted_supply'`);

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session_id).toBeTruthy();
    expect(body.bet_base_units).toBe('10');
    expect(body.bankroll_initial_base_units).toBe('100');
    expect(body.bankroll_remaining_base_units).toBe('100');
    expect(body.status).toBe('OPEN');

    const sess = await ctx.pool.query<{ status: string; bankroll_remaining_base_units: string }>(
      `SELECT status, bankroll_remaining_base_units::text FROM trivia_sessions WHERE id = $1`,
      [body.session_id],
    );
    expect(sess.rows[0].status).toBe('OPEN');
    expect(sess.rows[0].bankroll_remaining_base_units).toBe('100');

    const supply = await ctx.pool.query<{ value: string }>(`SELECT value::text FROM app_counters WHERE name = 'minted_supply'`);
    expect(supply.rows[0].value).toBe('100');

    const balance = await ctx.pool.query<{ sum: string }>(
      `SELECT COALESCE(SUM(value),0)::text AS sum FROM tokens WHERE owner_email='a@b.com' AND state='VALID'`,
    );
    expect(balance.rows[0].sum).toBe('100');
  });

  it('409 SESSION_ALREADY_OPEN when user opens twice', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    await seedToken(ctx.pool, 'a@b.com', 500n);
    await ctx.app.inject({
      method: 'POST', url: '/api/trivia/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SESSION_ALREADY_OPEN');
  });
});

describe('POST /api/trivia/sessions/:id/close', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/sessions/${randomUUID()}/close`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('404 SESSION_NOT_FOUND when session does not exist', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/sessions/${randomUUID()}/close`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('403 FORBIDDEN when caller does not own the session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const aCookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    await seedToken(ctx.pool, 'a@b.com', 500n);
    const enterRes = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/sessions',
      headers: { cookie: aCookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    const sessionId = enterRes.json().session_id;
    const bCookie = await login(ctx, 'b@b.com');
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/sessions/${sessionId}/close`,
      headers: { cookie: bCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('happy path: closes session and refunds remainder', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    await seedToken(ctx.pool, 'a@b.com', 200n);
    await ctx.pool.query(`UPDATE app_counters SET value = 200 WHERE name = 'minted_supply'`);

    const enterRes = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    const sessionId = enterRes.json().session_id;

    const closeRes = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/sessions/${sessionId}/close`,
      headers: { cookie },
    });
    expect(closeRes.statusCode).toBe(200);
    const body = closeRes.json();
    expect(body.status).toBe('CLOSED');
    expect(body.refunded_base_units).toBe('100');

    const supply = await ctx.pool.query<{ value: string }>(
      `SELECT value::text FROM app_counters WHERE name = 'minted_supply'`,
    );
    expect(supply.rows[0].value).toBe('200'); // back to original

    const balance = await ctx.pool.query<{ sum: string }>(
      `SELECT COALESCE(SUM(value),0)::text AS sum FROM tokens WHERE owner_email='a@b.com' AND state='VALID'`,
    );
    expect(balance.rows[0].sum).toBe('200');
  });

  it('409 SESSION_NOT_OPEN when called twice', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await markVerified(ctx.pool, 'a@b.com', 'alice');
    await seedToken(ctx.pool, 'a@b.com', 200n);

    const enterRes = await ctx.app.inject({
      method: 'POST', url: '/api/trivia/sessions',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { bankroll_base_units: DEFAULT_BANKROLL, bet_base_units: DEFAULT_BET },
    });
    const sessionId = enterRes.json().session_id;
    await ctx.app.inject({
      method: 'POST', url: `/api/trivia/sessions/${sessionId}/close`,
      headers: { cookie },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/trivia/sessions/${sessionId}/close`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
  });
});
```

- [ ] **Step 1.2: Run, confirm fail**

```
cd /Users/fredkrueger/rpow/apps/server && TEST_DATABASE_URL=postgres://fredkrueger@localhost:5432/rpow_test npx vitest run tests/triviaSessions.test.ts
```

Expected: all FAIL (still 501).

- [ ] **Step 1.3: Implement the routes**

Replace the entire contents of `apps/server/src/routes/trivia/sessions.ts`. Read `apps/server/src/routes/gladiator/sessions.ts` and adapt:
- Every `gladiator_*` table → `trivia_*`
- Every `flips_won/flips_lost` → `matches_won/matches_lost`
- Every `last_flip_at` → `last_match_at`
- Every `gladiator*` config field → `trivia*`
- Drop the SYSTEM chat inserts entirely (both `entered with` and `left the arena`)
- Keep the cap-throw pattern (throw `new Error('SUPPLY_CAP_REACHED')`) from the slice-3-cleanup era of gladiator
- Keep the `INTERNAL_ERROR` early-return for missing x_handle in close (the bb89b4d fix); the user must already have a handle to have entered, so close should not need it, but the gladiator close path looks up handle for the SYSTEM chat — since we're not posting chat, we can DROP the x_handle lookup entirely in close

Final file should be ~250-280 lines.

- [ ] **Step 1.4: Run, confirm green**

Expected: all sessions tests pass.

- [ ] **Step 1.5: Commit**

```bash
cd /Users/fredkrueger/rpow
git add apps/server/src/routes/trivia/sessions.ts apps/server/tests/triviaSessions.test.ts
git commit -m "feat(trivia): slice 2 — POST /sessions + POST /sessions/:id/close"
```

---

## Task 2: GET `/lobby`

**Files:**
- Modify: `apps/server/src/routes/trivia/lobby.ts`
- Create: `apps/server/tests/triviaLobby.test.ts`

Mirror `apps/server/src/routes/gladiator/lobby.ts`.

- [ ] **Step 2.1: Write the failing test**

Create `apps/server/tests/triviaLobby.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';

async function openSession(pool: any, ownerEmail: string, bet: bigint, bankroll: bigint, handle: string): Promise<string> {
  await pool.query(`INSERT INTO users(email, x_handle, x_handle_verified_at) VALUES ($1, $2, now()) ON CONFLICT (email) DO UPDATE SET x_handle = $2, x_handle_verified_at = now()`, [ownerEmail, handle]);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO trivia_sessions (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
     VALUES ($1, $2, $3, $4, $5, 'OPEN')`,
    [id, ownerEmail, bet.toString(), bankroll.toString(), bankroll.toString()],
  );
  return id;
}

describe('GET /api/trivia/lobby', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns empty when nobody in arena', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/lobby' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ gladiators: [] });
  });

  it('returns OPEN sessions with owner profile fields', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await openSession(ctx.pool, 'a@b.com', 10n, 100n, 'alice');
    await openSession(ctx.pool, 'c@d.com', 20n, 200n, 'charlie');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/lobby' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gladiators).toHaveLength(2);
    expect(body.gladiators[0].x_handle).toMatch(/alice|charlie/);
  });

  it('excludes CLOSED sessions', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const id = await openSession(ctx.pool, 'a@b.com', 10n, 100n, 'alice');
    await ctx.pool.query(`UPDATE trivia_sessions SET status = 'CLOSED', closed_at = now() WHERE id = $1`, [id]);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/lobby' });
    expect(res.json().gladiators).toHaveLength(0);
  });

  it('ordered by opened_at DESC', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await openSession(ctx.pool, 'a@b.com', 10n, 100n, 'alice');
    await new Promise(r => setTimeout(r, 20));
    await openSession(ctx.pool, 'c@d.com', 10n, 100n, 'charlie');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/lobby' });
    const handles = res.json().gladiators.map((g: any) => g.x_handle);
    expect(handles[0]).toBe('charlie');
    expect(handles[1]).toBe('alice');
  });

  it('public — works without session cookie', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await openSession(ctx.pool, 'a@b.com', 10n, 100n, 'alice');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/lobby' });
    expect(res.statusCode).toBe(200);
  });
});
```

Note the response key is `gladiators` (same shape as gladiator lobby — the frontend can rename in its api.ts). Spec §6 uses generic terminology; staying consistent with the gladiator response shape avoids divergence.

Actually — given the trivia spec uses "offerers" and "challengers" rather than "gladiators", and the spec table just says "List all OPEN sessions", let's use a CLEARER name: `players` instead of `gladiators`. Update the test:

```typescript
    expect(res.json()).toEqual({ players: [] });
    // ...
    expect(body.players).toHaveLength(2);
    expect(body.players[0].x_handle).toMatch(/alice|charlie/);
    // etc.
```

- [ ] **Step 2.2: Run, confirm fail**

```
cd /Users/fredkrueger/rpow/apps/server && TEST_DATABASE_URL=postgres://fredkrueger@localhost:5432/rpow_test npx vitest run tests/triviaLobby.test.ts
```

- [ ] **Step 2.3: Implement**

Replace `apps/server/src/routes/trivia/lobby.ts` with the structure from `apps/server/src/routes/gladiator/lobby.ts`, swapping table name and the response key (`gladiators` → `players`). Use `matches_won/matches_lost` not `flips_won/flips_lost`. Use `last_match_at` not `last_flip_at`.

- [ ] **Step 2.4: Run green + commit**

```bash
cd /Users/fredkrueger/rpow
git add apps/server/src/routes/trivia/lobby.ts apps/server/tests/triviaLobby.test.ts
git commit -m "feat(trivia): slice 2 — GET /lobby"
```

---

## Task 3: GET `/chat` + POST `/chat`

**Files:**
- Modify: `apps/server/src/routes/trivia/chat.ts`
- Create: `apps/server/tests/triviaChat.test.ts`

Mirror `apps/server/src/routes/gladiator/chat.ts` (the POST-cleanup version with USER-only filter and LIMIT 100).

- [ ] **Step 3.1: Write the failing test**

Create `apps/server/tests/triviaChat.test.ts` modeled after gladiator's. Cover:
- GET empty
- GET returns up to 100 USER rows newest-first
- GET excludes SYSTEM rows
- GET with `before=<iso>` paginates correctly
- GET with invalid `before` → 400
- POST 401 unauthed, 403 X_HANDLE_REQUIRED, 400 missing body, 400 length 0, 400 length > 280, 200 happy path inserts USER row

Copy gladiator chat test file content, swap URLs and table names.

- [ ] **Step 3.2-3.4: Same TDD pattern**

Implement `apps/server/src/routes/trivia/chat.ts` mirroring `apps/server/src/routes/gladiator/chat.ts` (post-cleanup). The SQL already filters `kind = 'USER'` and LIMIT 100.

- [ ] **Step 3.5: Commit**

```bash
git add apps/server/src/routes/trivia/chat.ts apps/server/tests/triviaChat.test.ts
git commit -m "feat(trivia): slice 2 — GET/POST /chat (USER-only, 100 limit)"
```

---

## Task 4: GET `/stats`

**Files:**
- Modify: `apps/server/src/routes/trivia/stats.ts`
- Create: `apps/server/tests/triviaStats.test.ts`

Mirror `apps/server/src/routes/gladiator/stats.ts`. Response shape:

```json
{
  "total_matches": <int>,
  "total_volume_base_units": "<bigint as string>",
  "total_verified_users": <int>,
  "open_arena_count": <int>
}
```

Note: `total_volume` is `SUM(bet_base_units * 2)` over RESOLVED matches only (matches counted only once they've actually settled — same convention as gladiator). `total_verified_users` is the count of users with `x_handle IS NOT NULL` (shared with gladiator — both games gate on the same X-verified handle).

- [ ] **Step 4.1: Failing test**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';

describe('GET /api/trivia/stats', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('returns zeros on empty DB', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/stats' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      total_matches: 0,
      total_volume_base_units: '0',
      total_verified_users: 0,
      open_arena_count: 0,
    });
  });

  it('counts verified users (with x_handle)', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users (email, x_handle, x_handle_verified_at) VALUES ('a@b.com', 'alice', now()), ('c@d.com', 'charlie', now())`);
    await ctx.pool.query(`INSERT INTO users (email) VALUES ('e@f.com')`);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/stats' });
    expect(res.json().total_verified_users).toBe(2);
  });

  it('counts open arena sessions', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@b.com'),('c@d.com') ON CONFLICT DO NOTHING`);
    await ctx.pool.query(
      `INSERT INTO trivia_sessions (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
       VALUES (gen_random_uuid(), 'a@b.com', 10, 100, 100, 'OPEN'),
              (gen_random_uuid(), 'c@d.com', 10, 100, 100, 'OPEN')`,
    );
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/stats' });
    expect(res.json().open_arena_count).toBe(2);
  });

  it('aggregates resolved matches', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await ctx.pool.query(`INSERT INTO users(email) VALUES ('a@b.com') ON CONFLICT DO NOTHING`);
    const { rows: sessRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO trivia_sessions (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status)
       VALUES (gen_random_uuid(), 'a@b.com', 10, 100, 100, 'OPEN')
       RETURNING id`,
    );
    const { rows: qRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO trivia_questions (id, category, difficulty, question, correct_idx, choices)
       VALUES (gen_random_uuid(), 'x', 'easy', 'q', 0, ARRAY['a','b','c','d'])
       RETURNING id`,
    );
    await ctx.pool.query(
      `INSERT INTO trivia_matches (id, offerer_session_id, offerer_email, challenger_email, bet_base_units, question_id, state, deadline_at, winner_email, signature, resolved_at, created_at)
       VALUES (gen_random_uuid(), $1, 'a@b.com', 'c@d.com', 10, $2, 'RESOLVED', now() + INTERVAL '10 seconds', 'a@b.com', '\\x00', now(), now()),
              (gen_random_uuid(), $1, 'a@b.com', 'e@f.com', 10, $2, 'RESOLVED', now() + INTERVAL '10 seconds', 'e@f.com', '\\x00', now(), now())`,
      [sessRows[0].id, qRows[0].id],
    );
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/stats' });
    expect(res.json().total_matches).toBe(2);
    expect(res.json().total_volume_base_units).toBe('40');
  });

  it('public — works without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/stats' });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 4.2-4.4: Same pattern. Commit.**

```bash
git add apps/server/src/routes/trivia/stats.ts apps/server/tests/triviaStats.test.ts
git commit -m "feat(trivia): slice 2 — GET /stats"
```

---

## Task 5: GET `/me`

**Files:**
- Modify: `apps/server/src/routes/trivia/me.ts`
- Create: `apps/server/tests/triviaMe.test.ts`

Response per spec §6:

```json
{
  "email": "<email>",
  "x_handle": "<handle or null>",
  "x_handle_verified_at": "<ISO or null>",
  "x_avatar_url": "<url or null>",
  "open_session": <trivia_sessions row or null>,
  "career": { "wins": <int>, "losses": <int> }
}
```

Career W/L: count from `trivia_matches` where caller was offerer or challenger AND state='RESOLVED'. `wins` = where `winner_email = caller`, `losses` = where `winner_email != caller AND winner_email IS NOT NULL`.

- [ ] **Step 5.1-5.4: TDD as before**

Adapt the structure of `apps/server/src/routes/gladiator/xHandle.ts` (specifically the `/api/gladiator/me` handler at the bottom, around line 230+). Swap tables and counter terminology.

- [ ] **Step 5.5: Commit**

```bash
git add apps/server/src/routes/trivia/me.ts apps/server/tests/triviaMe.test.ts
git commit -m "feat(trivia): slice 2 — GET /me (profile + open session + career W/L)"
```

---

## Task 6: GET `/matches/recent` and `/matches/history`

**Files:**
- Modify: `apps/server/src/routes/trivia/matches.ts` (replace the two stubs; keep the four match-flow stubs)
- Create: `apps/server/tests/triviaMatchReads.test.ts`

Both endpoints select RESOLVED matches only, JOIN to users for x_handles. `/recent` is public, max 50, newest first. `/history` requires session, filters to `offerer_email = caller OR challenger_email = caller`, max 50, newest first.

Match response shape per row:

```ts
{
  id: string;
  offerer_email: string;
  challenger_email: string;
  offerer_x_handle: string | null;
  challenger_x_handle: string | null;
  bet_base_units: string;
  winner_email: string;
  offerer_choice_idx: number | null;
  challenger_choice_idx: number | null;
  question_id: string;
  created_at: string;  // ISO
  resolved_at: string;  // ISO
}
```

- [ ] **Step 6.1-6.4: TDD**

Test file:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';

async function login(ctx: any, email: string): Promise<string> {
  await ctx.pool.query(`INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

async function seedResolvedMatch(pool: any, offererEmail: string, challengerEmail: string, winnerEmail: string) {
  await pool.query(`INSERT INTO users(email, x_handle, x_handle_verified_at) VALUES ($1, $2, now()), ($3, $4, now()) ON CONFLICT (email) DO UPDATE SET x_handle = EXCLUDED.x_handle, x_handle_verified_at = EXCLUDED.x_handle_verified_at`, [offererEmail, offererEmail.split('@')[0], challengerEmail, challengerEmail.split('@')[0]]);
  const { rows: s } = await pool.query<{ id: string }>(`INSERT INTO trivia_sessions (id, account_email, bet_base_units, bankroll_initial_base_units, bankroll_remaining_base_units, status) VALUES (gen_random_uuid(), $1, 10, 100, 100, 'OPEN') RETURNING id`, [offererEmail]);
  const { rows: q } = await pool.query<{ id: string }>(`INSERT INTO trivia_questions (id, category, difficulty, question, correct_idx, choices) VALUES (gen_random_uuid(), 'x', 'easy', 'q', 0, ARRAY['a','b','c','d']) RETURNING id`);
  const { rows: m } = await pool.query<{ id: string }>(`INSERT INTO trivia_matches (id, offerer_session_id, offerer_email, challenger_email, bet_base_units, question_id, state, deadline_at, winner_email, signature, resolved_at, created_at) VALUES (gen_random_uuid(), $1, $2, $3, 10, $4, 'RESOLVED', now() + INTERVAL '10 seconds', $5, '\\x00', now(), now()) RETURNING id`, [s[0].id, offererEmail, challengerEmail, q[0].id, winnerEmail]);
  return m[0].id;
}

describe('GET /api/trivia/matches/recent', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('200 empty when no resolved matches', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/matches/recent' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ matches: [] });
  });

  it('returns RESOLVED matches with x_handles', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    await seedResolvedMatch(ctx.pool, 'a@b.com', 'c@d.com', 'a@b.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/matches/recent' });
    expect(res.json().matches).toHaveLength(1);
    const m = res.json().matches[0];
    expect(m.offerer_x_handle).toBe('a');
    expect(m.challenger_x_handle).toBe('c');
    expect(m.winner_email).toBe('a@b.com');
  });

  it('public', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/matches/recent' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/trivia/matches/history', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('401 without session', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/matches/history' });
    expect(res.statusCode).toBe(401);
  });

  it('returns matches where caller is offerer or challenger', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    await seedResolvedMatch(ctx.pool, 'a@b.com', 'c@d.com', 'a@b.com');
    await seedResolvedMatch(ctx.pool, 'e@f.com', 'a@b.com', 'e@f.com');
    await seedResolvedMatch(ctx.pool, 'x@y.com', 'z@y.com', 'x@y.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/matches/history', headers: { cookie } });
    expect(res.json().matches).toHaveLength(2);
  });

  it('returns empty when caller has no matches', async () => {
    const ctx = await makeTestApp(); cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/trivia/matches/history', headers: { cookie } });
    expect(res.json()).toEqual({ matches: [] });
  });
});
```

- [ ] **Step 6.5: Commit**

```bash
git add apps/server/src/routes/trivia/matches.ts apps/server/tests/triviaMatchReads.test.ts
git commit -m "feat(trivia): slice 2 — GET /matches/recent + /matches/history"
```

---

## Task 7: Trim the 501-stub test

**Files:**
- Modify: `apps/server/tests/triviaRoutes.test.ts`

The original 13-endpoint stub test now over-asserts: 9 endpoints are now real (return 401 or 200, not 501). Remove those entries. Keep only the 4 match-flow endpoints that are still 501:

```typescript
  const endpoints: Array<{ method: 'GET' | 'POST'; url: string }> = [
    { method: 'POST', url: '/api/trivia/matches/start' },
    { method: 'GET',  url: '/api/trivia/matches/active?session_id=00000000-0000-0000-0000-000000000000' },
    { method: 'POST', url: '/api/trivia/matches/00000000-0000-0000-0000-000000000000/answer' },
    { method: 'GET',  url: '/api/trivia/matches/00000000-0000-0000-0000-000000000000' },
  ];
```

- [ ] **Step 7.1: Update test**
- [ ] **Step 7.2: Run, confirm 4 / 4 still pass**
- [ ] **Step 7.3: Commit**

```bash
git add apps/server/tests/triviaRoutes.test.ts
git commit -m "test(trivia): drop now-implemented endpoints from stub test"
```

---

## Task 8: Run full server suite + PR + deploy

- [ ] **Step 8.1: Full suite**

```
cd /Users/fredkrueger/rpow/apps/server && TEST_DATABASE_URL=postgres://fredkrueger@localhost:5432/rpow_test npx vitest run
```

Expected: pre-existing baseline failures (42) unchanged. New trivia tests all green.

- [ ] **Step 8.2: Push + open PR**

```bash
git push -u origin feat/trivia-slice-2
gh pr create --title "feat(trivia): slice 2 — sessions / lobby / chat / stats / me / match reads" --body "..."
```

- [ ] **Step 8.3: Deploy to VPS** (after merge)

Standard runbook deploy. Both services.

---

## Self-Review

**Spec coverage:**
- §6 endpoints — sessions enter/leave ✓, lobby ✓, /me ✓, /matches/recent ✓, /matches/history ✓, /chat ✓, /stats ✓. Out of scope this slice: /matches/start, /active, /:id, /answer (slice 3).
- §7A Enter — Task 1 ✓ (with burnFromUser + supply decrement)
- §7G Chat — Task 3 ✓ (USER-only, LIMIT 100 — lesson from gladiator)
- Allowlist on /sessions — Task 1 ✓
- Skip-SYSTEM-chat decision — Task 1 explicitly notes drop

**Placeholder scan:** No TBD / TODO / "similar to gladiator slice X" — each task gives the explicit adaptation.

**Type consistency:**
- `matches_won/matches_lost` and `last_match_at` used consistently across sessions, /me, lobby
- `total_matches` not `total_flips` in stats
- Lobby response key chosen: `players` (rather than reusing gladiator's `gladiators`)
- Match response shape stable across `/recent`, `/history`, and the eventual GET `/matches/:id` in slice 3

---

## Execution Handoff

**Plan complete. Saved to `docs/superpowers/plans/2026-05-11-trivia-slice-2.md`.**

Two options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review, fast iteration
2. **Inline Execution** — execute in this session with checkpoints

Which?
