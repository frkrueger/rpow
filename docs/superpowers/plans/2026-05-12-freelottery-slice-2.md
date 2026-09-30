# Freelottery Slice 2 — Entry flow (per-day code dance + ticket-tier math + utilitarian /enter UI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the slice-1 501 stubs at `POST /api/freelottery/entry/start` and `POST /api/freelottery/entry/verify` with real implementations of the per-day code dance, including ticket-tier math (1 base ticket; +1 if balance ≥ 1 RPOW at verify time) and full integration tests. Add a utilitarian `/enter` page to `apps/web-freelottery/` that drives the flow end-to-end with the existing X-handle bind UI (copied from `apps/web-gladiator/`). After this slice, a logged-in user can earn a daily lottery ticket; the draw runner and marketing public page are still future slices.

**Architecture:** A small `apps/server/src/freelottery/codes.ts` module owns pure helpers (`generateCode`, `ticketCountForBalance`, `tweetTemplate`, `tweetIntentUrl`). The two real route handlers in `apps/server/src/routes/freelottery/entry.ts` orchestrate session-check → day-utc compute → code upsert (for `/start`) and session-check → tweet oEmbed → balance snapshot → entry insert (for `/verify`). Tweet verification reuses the gladiator `verifyTweet` helper at `apps/server/src/gladiator/xVerify.ts` unchanged. The frontend gets a new `Enter.tsx` page that polls `/me`, renders bind-modal if `x_handle` is null, otherwise renders the daily code dance UI. The bind modal is a verbatim copy of `apps/web-gladiator/src/XHandleClaimModal.tsx` — same pattern `apps/web-trivia/` uses today.

**Tech Stack:** Postgres 17, Fastify 4 + zod, vitest, React 18 + Vite 5. No new npm dependencies.

---

## Spec reference

`docs/superpowers/specs/2026-05-12-daily-free-lottery-design.md` — Slice 2 implements: §2 decisions for ticket tiers and tweet template, §5.1 entry flow end-to-end, §6.2 the `/enter` UI, §7.1 entry-time error handling. Slice 2 does **not** implement: §5.2 draw, §5.3 `/today` and `/winners` (still 501), §6.1 public marketing page (slice 4), §6.3 news entry, §7.2 draw-time errors.

## File structure

**Create:**

- `apps/server/src/freelottery/codes.ts` — pure helpers: code gen, balance→tickets, tweet text/intent URL
- `apps/server/tests/freelotteryCodes.test.ts` — unit tests
- `apps/server/tests/freelotteryEntry.test.ts` — integration tests for `/start` and `/verify`
- `apps/web-freelottery/src/Enter.tsx` — utilitarian entry-flow page
- `apps/web-freelottery/src/XHandleClaimModal.tsx` — verbatim copy from web-gladiator
- `apps/web-freelottery/src/api.ts` — API client (auth, status, me, x-handle, entry)

**Modify:**

- `apps/server/src/routes/freelottery/entry.ts` — replace 501 stubs with real handlers
- `apps/web-freelottery/src/App.tsx` — wire routing (`/` placeholder vs `/enter`)
- `apps/web-freelottery/src/styles.css` — add styles for the new page + modal

---

## Task 1: `freelottery/codes.ts` helpers + unit tests

**Files:**

- Create: `apps/server/src/freelottery/codes.ts`
- Create: `apps/server/tests/freelotteryCodes.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `apps/server/tests/freelotteryCodes.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  generateCode,
  ticketCountForBalance,
  tweetTemplate,
  tweetIntentUrl,
  BASE_UNITS_PER_RPOW,
} from '../src/freelottery/codes.js';

describe('freelottery codes', () => {
  describe('generateCode', () => {
    it('returns 6-digit numeric string', () => {
      for (let i = 0; i < 100; i++) {
        const code = generateCode();
        expect(code).toMatch(/^\d{6}$/);
      }
    });

    it('produces varying values (not constant)', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 50; i++) seen.add(generateCode());
      expect(seen.size).toBeGreaterThan(1);
    });
  });

  describe('ticketCountForBalance', () => {
    it('1 ticket when balance is zero', () => {
      expect(ticketCountForBalance(0n)).toBe(1);
    });

    it('1 ticket when balance is just below 1 RPOW', () => {
      expect(ticketCountForBalance(BASE_UNITS_PER_RPOW - 1n)).toBe(1);
    });

    it('2 tickets when balance is exactly 1 RPOW', () => {
      expect(ticketCountForBalance(BASE_UNITS_PER_RPOW)).toBe(2);
    });

    it('2 tickets when balance is many RPOW', () => {
      expect(ticketCountForBalance(BASE_UNITS_PER_RPOW * 1000n)).toBe(2);
    });
  });

  describe('tweetTemplate', () => {
    it('embeds the code verbatim', () => {
      expect(tweetTemplate('123456')).toContain('My code is 123456');
    });

    it('mentions the prize and the URL', () => {
      const t = tweetTemplate('000000');
      expect(t).toContain('1000 RPOW');
      expect(t).toContain('freelottery.rpow2.com');
    });
  });

  describe('tweetIntentUrl', () => {
    it('returns a twitter intent URL with URL-encoded text', () => {
      const url = tweetIntentUrl('123456');
      expect(url).toMatch(/^https:\/\/twitter\.com\/intent\/tweet\?text=/);
      expect(decodeURIComponent(url.split('text=')[1])).toBe(tweetTemplate('123456'));
    });
  });
});
```

- [ ] **Step 1.2: Run the test and verify it fails**

Run: `npm --workspace apps/server test -- freelotteryCodes`
Expected: FAIL — module does not exist.

- [ ] **Step 1.3: Implement the module**

Create `apps/server/src/freelottery/codes.ts`:

```typescript
/** 1 RPOW expressed in base units (10^9). */
export const BASE_UNITS_PER_RPOW = 1_000_000_000n;

/** Generate a zero-padded 6-digit numeric code, e.g. "034281". */
export function generateCode(): string {
  const n = Math.floor(Math.random() * 1_000_000);
  return String(n).padStart(6, '0');
}

/**
 * Ticket count earned by a successfully-verified entry.
 *   1 base ticket; +1 extra if balance ≥ 1 RPOW at verify time.
 */
export function ticketCountForBalance(balanceBaseUnits: bigint): 1 | 2 {
  return balanceBaseUnits >= BASE_UNITS_PER_RPOW ? 2 : 1;
}

/** Canonical tweet text for the daily entry. */
export function tweetTemplate(code: string): string {
  return `I am entering the daily free lottery for 1000 RPOW. My code is ${code}. freelottery.rpow2.com`;
}

/** Twitter intent URL pre-filled with the tweet template. */
export function tweetIntentUrl(code: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetTemplate(code))}`;
}
```

- [ ] **Step 1.4: Run the test and verify it passes**

Run: `npm --workspace apps/server test -- freelotteryCodes`
Expected: PASS — all cases green.

- [ ] **Step 1.5: Commit**

```bash
git add apps/server/src/freelottery/codes.ts apps/server/tests/freelotteryCodes.test.ts
git commit -m "feat(freelottery): codes helper module (gen, ticket tier, tweet template)"
```

---

## Task 2: Real `POST /api/freelottery/entry/start` handler

**Files:**

- Modify: `apps/server/src/routes/freelottery/entry.ts`
- Create: `apps/server/tests/freelotteryEntry.test.ts`

- [ ] **Step 2.1: Write the failing integration tests for /start**

Create `apps/server/tests/freelotteryEntry.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeTestApp } from './helpers.js';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import * as xVerify from '../src/gladiator/xVerify.js';

async function login(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string, opts?: { xHandle?: string }) {
  await ctx.pool.query(
    `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
    [email],
  );
  if (opts?.xHandle) {
    await ctx.pool.query(
      `UPDATE users SET x_handle = $1, x_handle_verified_at = now(), x_avatar_url = $2 WHERE email = $3`,
      [opts.xHandle, `https://unavatar.io/twitter/${opts.xHandle}`, email],
    );
  }
  const token = signSession({ email }, 'x'.repeat(32), 3600);
  return `${SESSION_COOKIE}=${token}`;
}

async function start(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/freelottery/entry/start',
    headers: { cookie, 'content-type': 'application/json' },
    payload: {},
  });
}

async function verify(ctx: Awaited<ReturnType<typeof makeTestApp>>, cookie: string, tweet_url: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/freelottery/entry/verify',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { tweet_url },
  });
}

const TODAY = new Date().toISOString().slice(0, 10);

describe('POST /api/freelottery/entry/start', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('401 unauthenticated', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/freelottery/entry/start',
      headers: { 'content-type': 'application/json' }, payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('404 when feature is disabled (no start date)', async () => {
    const ctx = await makeTestApp();
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    const res = await start(ctx, cookie);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('FEATURE_DISABLED');
  });

  it('409 BIND_REQUIRED when user has no x_handle', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com');
    const res = await start(ctx, cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('BIND_REQUIRED');
  });

  it('200 returns code, tweet_intent_url, expires_at, day_utc and upserts the code row', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    const res = await start(ctx, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toMatch(/^\d{6}$/);
    expect(body.tweet_intent_url).toMatch(/^https:\/\/twitter\.com\/intent\/tweet\?text=/);
    expect(body.day_utc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T19:00:00\.000Z$/);
    // Row exists in DB.
    const { rows } = await ctx.pool.query(
      `SELECT code FROM freelottery_codes WHERE account_email = 'a@b.com' AND day_utc = $1`,
      [body.day_utc],
    );
    expect(rows[0]?.code).toBe(body.code);
  });

  it('409 ALREADY_ENTERED when user already has an entry for today', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    // Pre-seed an entry for today.
    await ctx.pool.query(
      `INSERT INTO freelottery_entries
         (account_email, day_utc, x_handle, tweet_url, ticket_count, balance_base_units_at_entry)
       VALUES ('a@b.com', $1, 'alice', 'https://twitter.com/alice/status/1', 1, 0)`,
      [TODAY],
    );
    const res = await start(ctx, cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('ALREADY_ENTERED');
  });

  it('overwrites a previous /start code when called twice the same day', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    const first = await start(ctx, cookie);
    const second = await start(ctx, cookie);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // DB row reflects the second code (upsert behavior).
    const { rows } = await ctx.pool.query<{ code: string }>(
      `SELECT code FROM freelottery_codes WHERE account_email = 'a@b.com' AND day_utc = $1`,
      [second.json().day_utc],
    );
    expect(rows[0].code).toBe(second.json().code);
  });
});
```

- [ ] **Step 2.2: Run the test and verify it fails**

Run: `npm --workspace apps/server test -- freelotteryEntry`
Expected: FAIL — `/entry/start` returns 501 (the slice-1 stub), so the 200/404/409 cases all mismatch.

- [ ] **Step 2.3: Implement the real `/entry/start` handler**

Open `apps/server/src/routes/freelottery/entry.ts`. Replace its full contents with:

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readSession } from '../auth.js';
import { generateCode, tweetIntentUrl, ticketCountForBalance } from '../../freelottery/codes.js';
import { getDayUtc, hasEnded } from '../../freelottery/schedule.js';
import { verifyTweet } from '../../gladiator/xVerify.js';
import { withTx } from '../../db.js';

function scheduleFor(app: FastifyInstance) {
  return {
    startUtcDate: app.config.freelotteryStartUtcDate,
    totalDays: app.config.freelotteryTotalDays,
    drawHourUtc: app.config.freelotteryDrawHourUtc,
  };
}

function drawMomentFor(dayUtc: string, hourUtc: number): Date {
  return new Date(`${dayUtc}T${String(hourUtc).padStart(2, '0')}:00:00Z`);
}

const VerifyBody = z.object({ tweet_url: z.string().min(1) });

export async function entryRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /api/freelottery/entry/start
  // -------------------------------------------------------------------------
  app.post('/api/freelottery/entry/start', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '10 minutes',
        keyGenerator: (req: any) => req.headers['x-forwarded-for'] ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const sched = scheduleFor(app);
    if (!sched.startUtcDate) {
      return reply.code(404).send({ error: 'FEATURE_DISABLED', message: 'freelottery is not enabled' });
    }
    const now = new Date();
    if (hasEnded(now, sched)) {
      return reply.code(404).send({ error: 'CAMPAIGN_ENDED', message: 'campaign has ended' });
    }
    const dayUtc = getDayUtc(now, sched);
    if (!dayUtc) {
      return reply.code(404).send({ error: 'CAMPAIGN_NOT_STARTED', message: 'campaign has not started yet' });
    }

    // User must have a bound X handle to enter.
    const userRes = await app.pool.query<{ x_handle: string | null }>(
      `SELECT x_handle FROM users WHERE email = $1`,
      [s.email],
    );
    if (userRes.rows.length === 0) {
      return reply.code(404).send({ error: 'USER_NOT_FOUND', message: 'user not found' });
    }
    if (!userRes.rows[0].x_handle) {
      return reply.code(409).send({ error: 'BIND_REQUIRED', message: 'bind an X handle first' });
    }

    // Reject if already entered for today.
    const existing = await app.pool.query(
      `SELECT 1 FROM freelottery_entries WHERE account_email = $1 AND day_utc = $2`,
      [s.email, dayUtc],
    );
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'ALREADY_ENTERED', message: 'already entered for today' });
    }

    const code = generateCode();
    const expiresAt = drawMomentFor(dayUtc, sched.drawHourUtc);

    await app.pool.query(
      `INSERT INTO freelottery_codes (account_email, day_utc, code, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_email, day_utc) DO UPDATE
         SET code = EXCLUDED.code,
             expires_at = EXCLUDED.expires_at`,
      [s.email, dayUtc, code, expiresAt],
    );

    return reply.code(200).send({
      code,
      tweet_intent_url: tweetIntentUrl(code),
      expires_at: expiresAt.toISOString(),
      day_utc: dayUtc,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/freelottery/entry/verify — implemented in Task 3
  // -------------------------------------------------------------------------
  app.post('/api/freelottery/entry/verify', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });
}
```

(The `/verify` stub stays for now — Task 3 replaces it.)

- [ ] **Step 2.4: Run the test and verify the /start cases pass**

Run: `npm --workspace apps/server test -- freelotteryEntry`
Expected: the `POST /api/freelottery/entry/start` describe block passes (6 cases). The `POST /api/freelottery/entry/verify` describe block (added in Task 3) does not yet exist, so the suite still only contains the /start cases.

- [ ] **Step 2.5: Commit**

```bash
git add apps/server/src/routes/freelottery/entry.ts apps/server/tests/freelotteryEntry.test.ts
git commit -m "feat(freelottery): POST /entry/start — issue per-day code"
```

---

## Task 3: Real `POST /api/freelottery/entry/verify` handler

**Files:**

- Modify: `apps/server/src/routes/freelottery/entry.ts`
- Modify: `apps/server/tests/freelotteryEntry.test.ts`

- [ ] **Step 3.1: Add the failing /verify tests**

Append the following block to `apps/server/tests/freelotteryEntry.test.ts` (after the existing `POST /api/freelottery/entry/start` describe):

```typescript
describe('POST /api/freelottery/entry/verify', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (cleanup) await cleanup();
    cleanup = null;
  });

  async function seedCode(ctx: Awaited<ReturnType<typeof makeTestApp>>, email: string, code: string) {
    const expires = new Date();
    expires.setUTCHours(expires.getUTCHours() + 24); // safely in the future for the test
    await ctx.pool.query(
      `INSERT INTO freelottery_codes (account_email, day_utc, code, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_email, day_utc) DO UPDATE
         SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at`,
      [email, TODAY, code, expires],
    );
  }

  it('401 unauthenticated', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/freelottery/entry/verify',
      headers: { 'content-type': 'application/json' },
      payload: { tweet_url: 'https://twitter.com/alice/status/1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('400 CODE_NOT_FOUND when no /start was called', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    const res = await verify(ctx, cookie, 'https://twitter.com/alice/status/1');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CODE_NOT_FOUND');
  });

  it('400 when oEmbed returns null', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    await seedCode(ctx, 'a@b.com', '123456');
    vi.spyOn(xVerify, 'verifyTweet').mockResolvedValueOnce(null);
    const res = await verify(ctx, cookie, 'https://twitter.com/alice/status/1');
    expect(res.statusCode).toBe(400);
  });

  it('403 HANDLE_MISMATCH when tweet author != bound handle', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    await seedCode(ctx, 'a@b.com', '123456');
    vi.spyOn(xVerify, 'verifyTweet').mockResolvedValueOnce({
      authorHandle: 'someoneelse',
      text: 'I am entering the daily free lottery for 1000 RPOW. My code is 123456.',
    });
    const res = await verify(ctx, cookie, 'https://twitter.com/someoneelse/status/1');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('HANDLE_MISMATCH');
  });

  it('400 CODE_MISMATCH when the tweet body lacks the code', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    await seedCode(ctx, 'a@b.com', '123456');
    vi.spyOn(xVerify, 'verifyTweet').mockResolvedValueOnce({
      authorHandle: 'alice',
      text: 'I am entering the daily free lottery for 1000 RPOW. My code is 999999.',
    });
    const res = await verify(ctx, cookie, 'https://twitter.com/alice/status/1');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CODE_MISMATCH');
  });

  it('200 succeeds with ticket_count=1 when balance is below 1 RPOW', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    await seedCode(ctx, 'a@b.com', '123456');
    vi.spyOn(xVerify, 'verifyTweet').mockResolvedValueOnce({
      authorHandle: 'alice',
      text: 'I am entering the daily free lottery for 1000 RPOW. My code is 123456.',
    });
    const res = await verify(ctx, cookie, 'https://twitter.com/alice/status/1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, ticket_count: 1, day_utc: TODAY });

    // Entry row inserted; code row deleted.
    const entries = await ctx.pool.query(
      `SELECT ticket_count, balance_base_units_at_entry FROM freelottery_entries
       WHERE account_email = 'a@b.com' AND day_utc = $1`,
      [TODAY],
    );
    expect(entries.rows[0].ticket_count).toBe(1);
    expect(entries.rows[0].balance_base_units_at_entry).toBe('0');
    const codes = await ctx.pool.query(
      `SELECT 1 FROM freelottery_codes WHERE account_email = 'a@b.com' AND day_utc = $1`,
      [TODAY],
    );
    expect(codes.rows.length).toBe(0);
  });

  it('200 succeeds with ticket_count=2 when balance is >= 1 RPOW', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    await seedCode(ctx, 'a@b.com', '123456');
    // Seed a 5 RPOW token to push balance over the threshold.
    // server_sig is NOT NULL so we pass an empty byte string; the verify route
    // only sums `value`, it doesn't validate the signature.
    await ctx.pool.query(
      `INSERT INTO tokens (id, owner_email, value, state, parent_token_id, server_sig)
       VALUES (gen_random_uuid(), 'a@b.com', 5000000000, 'VALID', NULL, '\\x00'::bytea)`,
    );
    vi.spyOn(xVerify, 'verifyTweet').mockResolvedValueOnce({
      authorHandle: 'alice',
      text: 'I am entering the daily free lottery for 1000 RPOW. My code is 123456.',
    });
    const res = await verify(ctx, cookie, 'https://twitter.com/alice/status/1');
    expect(res.statusCode).toBe(200);
    expect(res.json().ticket_count).toBe(2);
    const entries = await ctx.pool.query<{ balance_base_units_at_entry: string }>(
      `SELECT balance_base_units_at_entry FROM freelottery_entries
       WHERE account_email = 'a@b.com' AND day_utc = $1`,
      [TODAY],
    );
    expect(entries.rows[0].balance_base_units_at_entry).toBe('5000000000');
  });

  it('handle is case-insensitive against the bound handle', async () => {
    const ctx = await makeTestApp({ freelotteryStartUtcDate: TODAY });
    cleanup = ctx.cleanup;
    const cookie = await login(ctx, 'a@b.com', { xHandle: 'alice' });
    await seedCode(ctx, 'a@b.com', '123456');
    vi.spyOn(xVerify, 'verifyTweet').mockResolvedValueOnce({
      authorHandle: 'Alice', // mixed case — should still match
      text: 'I am entering the daily free lottery for 1000 RPOW. My code is 123456.',
    });
    const res = await verify(ctx, cookie, 'https://twitter.com/Alice/status/1');
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 3.2: Run the test and verify the /verify cases fail**

Run: `npm --workspace apps/server test -- freelotteryEntry`
Expected: the new /verify cases fail (501 returned). /start cases still pass.

- [ ] **Step 3.3: Implement the real `/verify` handler**

In `apps/server/src/routes/freelottery/entry.ts`, replace the placeholder `/verify` route at the bottom of the file. Change:

```typescript
  // -------------------------------------------------------------------------
  // POST /api/freelottery/entry/verify — implemented in Task 3
  // -------------------------------------------------------------------------
  app.post('/api/freelottery/entry/verify', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });
```

to:

```typescript
  // -------------------------------------------------------------------------
  // POST /api/freelottery/entry/verify
  // -------------------------------------------------------------------------
  app.post('/api/freelottery/entry/verify', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '10 minutes',
        keyGenerator: (req: any) => req.headers['x-forwarded-for'] ?? req.ip,
      },
    },
  }, async (req, reply) => {
    const s = readSession(req as any, app.config.sessionSecret);
    if (!s) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'login required' });

    const parsed = VerifyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'invalid body' });
    }

    const sched = scheduleFor(app);
    if (!sched.startUtcDate) {
      return reply.code(404).send({ error: 'FEATURE_DISABLED', message: 'freelottery is not enabled' });
    }
    const dayUtc = getDayUtc(new Date(), sched);
    if (!dayUtc) {
      return reply.code(404).send({ error: 'CAMPAIGN_INACTIVE', message: 'no active day' });
    }

    // Read the pending code for today.
    const codeRes = await app.pool.query<{ code: string; expires_at: Date }>(
      `SELECT code, expires_at FROM freelottery_codes WHERE account_email = $1 AND day_utc = $2`,
      [s.email, dayUtc],
    );
    if (codeRes.rows.length === 0) {
      return reply.code(400).send({ error: 'CODE_NOT_FOUND', message: 'no pending code; call /start first' });
    }
    const { code, expires_at } = codeRes.rows[0];
    if (new Date() > expires_at) {
      await app.pool.query(
        `DELETE FROM freelottery_codes WHERE account_email = $1 AND day_utc = $2`,
        [s.email, dayUtc],
      );
      return reply.code(400).send({ error: 'CODE_EXPIRED', message: 'code expired; call /start again' });
    }

    // Read bound x_handle. (If null, /start would have already returned 409
    // BIND_REQUIRED — but defensive re-check here in case the user unbound.)
    const userRes = await app.pool.query<{ x_handle: string | null }>(
      `SELECT x_handle FROM users WHERE email = $1`,
      [s.email],
    );
    const xHandle = userRes.rows[0]?.x_handle ?? null;
    if (!xHandle) {
      return reply.code(409).send({ error: 'BIND_REQUIRED', message: 'bind an X handle first' });
    }

    // oEmbed-verify the tweet.
    const oembed = await verifyTweet(parsed.data.tweet_url);
    if (!oembed) {
      return reply.code(400).send({ error: 'TWEET_UNRESOLVABLE', message: 'could not verify tweet' });
    }
    if (oembed.authorHandle.toLowerCase() !== xHandle.toLowerCase()) {
      return reply.code(403).send({ error: 'HANDLE_MISMATCH', message: 'tweet author does not match bound handle' });
    }
    if (!oembed.text.includes(code)) {
      return reply.code(400).send({ error: 'CODE_MISMATCH', message: 'code not found in tweet text' });
    }

    // Read the user's current balance to decide ticket tier.
    const balRes = await app.pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(value) FILTER (WHERE state = 'VALID'), 0)::text AS balance
       FROM tokens WHERE owner_email = $1`,
      [s.email],
    );
    const balance = BigInt(balRes.rows[0]?.balance ?? '0');
    const ticketCount = ticketCountForBalance(balance);

    // Transaction: insert the entry, delete the code. Idempotent against
    // race: re-check no existing entry inside the tx.
    type VerifyResult =
      | { ok: true; ticket_count: 1 | 2; day_utc: string; balance_base_units_at_entry: string }
      | { error: string; message: string; status: number };

    let result: VerifyResult;
    try {
      result = await withTx<VerifyResult>(app.pool, async (c) => {
        const existing = await c.query(
          `SELECT 1 FROM freelottery_entries WHERE account_email = $1 AND day_utc = $2`,
          [s.email, dayUtc],
        );
        if (existing.rows.length > 0) {
          return { error: 'ALREADY_ENTERED', message: 'already entered for today', status: 409 };
        }
        await c.query(
          `INSERT INTO freelottery_entries
             (account_email, day_utc, x_handle, tweet_url, ticket_count, balance_base_units_at_entry)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [s.email, dayUtc, xHandle, parsed.data.tweet_url, ticketCount, balance.toString()],
        );
        await c.query(
          `DELETE FROM freelottery_codes WHERE account_email = $1 AND day_utc = $2`,
          [s.email, dayUtc],
        );
        return {
          ok: true,
          ticket_count: ticketCount,
          day_utc: dayUtc,
          balance_base_units_at_entry: balance.toString(),
        };
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        return reply.code(409).send({ error: 'ALREADY_ENTERED', message: 'already entered for today' });
      }
      throw e;
    }

    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }

    return reply.code(200).send(result);
  });
```

- [ ] **Step 3.4: Run the tests and verify they pass**

Run: `npm --workspace apps/server test -- freelotteryEntry`
Expected: all /start and /verify cases green (14 total).

- [ ] **Step 3.5: Commit**

```bash
git add apps/server/src/routes/freelottery/entry.ts apps/server/tests/freelotteryEntry.test.ts
git commit -m "feat(freelottery): POST /entry/verify — oEmbed check, ticket tier, persist entry"
```

---

## Task 4: Frontend `/enter` page + bind modal + routing

**Files:**

- Create: `apps/web-freelottery/src/Enter.tsx`
- Create: `apps/web-freelottery/src/XHandleClaimModal.tsx`
- Create: `apps/web-freelottery/src/api.ts`
- Modify: `apps/web-freelottery/src/App.tsx`
- Modify: `apps/web-freelottery/src/styles.css`

No new tests — the frontend changes are verified by building + manual click-through. Slice 4 introduces frontend snapshot tests for the public page.

- [ ] **Step 4.1: Create `api.ts`**

Create `apps/web-freelottery/src/api.ts`:

```typescript
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP_${res.status}` }));
    throw Object.assign(new Error(body?.message ?? `HTTP ${res.status}`), {
      status: res.status,
      code: body?.error,
    });
  }
  return res.json() as Promise<T>;
}

export interface Me {
  email: string;
  balance_base_units: string;
  x_handle: string | null;
  x_avatar_url: string | null;
}

export interface FreelotteryStatus {
  enabled: boolean;
  startUtcDate: string | null;
  totalDays: number;
  prizeBaseUnits: string;
  drawHourUtc: number;
  dayIndex: number | null;
  currentDayUtc: string | null;
  nextDrawAt: string | null;
  ended: boolean;
}

export interface StartResponse {
  code: string;
  tweet_intent_url: string;
  expires_at: string;
  day_utc: string;
}

export interface VerifyResponse {
  ok: true;
  ticket_count: 1 | 2;
  day_utc: string;
  balance_base_units_at_entry: string;
}

export interface XHandleStartResponse {
  code: string;
  tweet_intent_url: string;
  expires_at: string;
}

export interface XHandleVerifyResponse {
  x_handle: string;
  x_handle_verified_at: string;
  x_avatar_url: string;
}

export const api = {
  me: () => jsonFetch<Me>('/me'),
  status: () => jsonFetch<FreelotteryStatus>('/api/freelottery/status'),
  startEntry: () => jsonFetch<StartResponse>('/api/freelottery/entry/start', { method: 'POST', body: '{}' }),
  verifyEntry: (tweet_url: string) =>
    jsonFetch<VerifyResponse>('/api/freelottery/entry/verify', {
      method: 'POST',
      body: JSON.stringify({ tweet_url }),
    }),
};

// Named bindings to match the X-handle bind modal copied verbatim from web-gladiator.
export const startXVerification = (handle: string) =>
  jsonFetch<XHandleStartResponse>('/api/gladiator/x-handle/start', {
    method: 'POST',
    body: JSON.stringify({ handle }),
  });

export const verifyXTweet = (tweet_url: string) =>
  jsonFetch<XHandleVerifyResponse>('/api/gladiator/x-handle/verify', {
    method: 'POST',
    body: JSON.stringify({ tweet_url }),
  });
```

- [ ] **Step 4.2: Copy the bind modal verbatim**

Copy `apps/web-gladiator/src/XHandleClaimModal.tsx` to `apps/web-freelottery/src/XHandleClaimModal.tsx`. No edits — the gladiator modal imports `startXVerification`, `verifyXTweet`, and the `XHandleStartResponse` type from `./api.js`, all of which Step 4.1 exposed under the same names. The modal exports `XHandleClaimModal` with a single `onVerified: () => void` prop.

Run this from the repo root:

```bash
cp apps/web-gladiator/src/XHandleClaimModal.tsx apps/web-freelottery/src/XHandleClaimModal.tsx
```

If a future change to gladiator's modal touched its imports or prop API since this plan was written, surface that as DONE_WITH_CONCERNS so the controller can confirm — don't silently adapt the modal.

- [ ] **Step 4.3: Create `Enter.tsx`**

Create `apps/web-freelottery/src/Enter.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { api, Me, StartResponse, VerifyResponse } from './api.js';
import { XHandleClaimModal } from './XHandleClaimModal.js';

type View =
  | { stage: 'loading' }
  | { stage: 'login_required' }
  | { stage: 'bind_required'; me: Me }
  | { stage: 'already_entered'; me: Me }
  | { stage: 'ready_to_tweet'; me: Me; start: StartResponse }
  | { stage: 'verifying'; me: Me; start: StartResponse }
  | { stage: 'done'; me: Me; result: VerifyResponse };

export function Enter() {
  const [view, setView] = useState<View>({ stage: 'loading' });
  const [tweetUrl, setTweetUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function init() {
    setError(null);
    try {
      const me = await api.me();
      if (!me.x_handle) {
        setView({ stage: 'bind_required', me });
      } else {
        // Try to start. If ALREADY_ENTERED, jump straight to "done" with a minimal display.
        try {
          const start = await api.startEntry();
          setView({ stage: 'ready_to_tweet', me, start });
        } catch (e: any) {
          if (e.code === 'ALREADY_ENTERED') {
            setView({ stage: 'already_entered', me });
          } else {
            throw e;
          }
        }
      }
    } catch (e: any) {
      if (e.status === 401) setView({ stage: 'login_required' });
      else setError(e.message ?? String(e));
    }
  }

  useEffect(() => { void init(); }, []);

  async function onVerify() {
    if (view.stage !== 'ready_to_tweet') return;
    setView({ stage: 'verifying', me: view.me, start: view.start });
    setError(null);
    try {
      const result = await api.verifyEntry(tweetUrl);
      setView({ stage: 'done', me: view.me, result });
    } catch (e: any) {
      setError(e.message ?? String(e));
      setView({ stage: 'ready_to_tweet', me: view.me, start: view.start });
    }
  }

  if (view.stage === 'loading') return <main><p>Loading…</p></main>;
  if (view.stage === 'login_required') {
    return (
      <main>
        <h1>Sign in to enter</h1>
        <p>You need an RPOW account to enter the daily free lottery.</p>
        <p><a href="https://rpow2.com">Go to rpow2.com to sign in →</a></p>
      </main>
    );
  }
  if (view.stage === 'bind_required') {
    return (
      <main>
        <h1>Link your X account</h1>
        <p>To enter the lottery you first need to verify an X (Twitter) handle.</p>
        <XHandleClaimModal onVerified={() => void init()} />
      </main>
    );
  }
  if (view.stage === 'already_entered') {
    return (
      <main>
        <h1>You're already in today.</h1>
        <p>Come back tomorrow after 19:00 UTC for the next draw.</p>
        <p><a href="/">← Back to the lottery</a></p>
      </main>
    );
  }
  if (view.stage === 'done') {
    return (
      <main>
        <h1>You're in.</h1>
        <p>Ticket count: {view.result.ticket_count}. Draw at 19:00 UTC.</p>
        <p><a href="/">← Back to the lottery</a></p>
      </main>
    );
  }

  // ready_to_tweet or verifying
  return (
    <main>
      <h1>Enter today's free lottery</h1>
      <p>1. Click the button below to post the verification tweet.</p>
      <p>
        <a className="tweet-cta" href={view.start.tweet_intent_url} target="_blank" rel="noreferrer">
          Tweet to enter →
        </a>
      </p>
      <p>2. Paste the URL of the tweet you just posted and click verify.</p>
      <input
        type="url"
        placeholder="https://twitter.com/yourhandle/status/..."
        value={tweetUrl}
        onChange={e => setTweetUrl(e.target.value)}
        disabled={view.stage === 'verifying'}
      />
      <button onClick={onVerify} disabled={view.stage === 'verifying' || tweetUrl.length === 0}>
        {view.stage === 'verifying' ? 'Verifying…' : 'Verify'}
      </button>
      {error ? <p className="error">{error}</p> : null}
      <p className="small">Your code: {view.start.code} · expires {new Date(view.start.expires_at).toUTCString()}</p>
    </main>
  );
}
```

- [ ] **Step 4.4: Update `App.tsx` to route between `/` and `/enter`**

Replace `apps/web-freelottery/src/App.tsx` with:

```typescript
import { useEffect, useState } from 'react';
import { Enter } from './Enter.js';
import { api, FreelotteryStatus } from './api.js';

function PublicPlaceholder() {
  const [status, setStatus] = useState<FreelotteryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.status().then(setStatus).catch(e => setError(String(e)));
  }, []);

  return (
    <main>
      <h1>RPOW Free Lottery</h1>
      <p>100 days · 1,000 RPOW · daily draw at 19:00 UTC.</p>
      <p><a className="tweet-cta" href="/enter">Enter today's free lottery →</a></p>
      {error ? <pre className="error">{error}</pre> : null}
      {status ? <pre>{JSON.stringify(status, null, 2)}</pre> : null}
    </main>
  );
}

export function App() {
  // Tiny path-based router. The marketing public page is slice 4.
  const path = window.location.pathname;
  if (path === '/enter') return <Enter />;
  return <PublicPlaceholder />;
}
```

- [ ] **Step 4.5: Style additions**

Append to `apps/web-freelottery/src/styles.css`:

```css
input[type="url"] {
  width: 100%;
  max-width: 36rem;
  padding: 0.6rem 0.8rem;
  background: #111;
  color: #f0f0f0;
  border: 1px solid #333;
  border-radius: 6px;
  font-family: inherit;
  font-size: 14px;
  margin: 0.4rem 0 1rem;
}
button {
  background: #f0f0f0;
  color: #0a0a0a;
  border: 0;
  padding: 0.6rem 1.2rem;
  border-radius: 6px;
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
}
button:disabled { opacity: 0.5; cursor: not-allowed; }
a.tweet-cta {
  display: inline-block;
  background: #1d9bf0;
  color: #fff;
  padding: 0.6rem 1.2rem;
  border-radius: 6px;
  text-decoration: none;
  font-weight: 600;
  margin: 0.4rem 0;
}
.small { font-size: 12px; color: #999; }
```

- [ ] **Step 4.6: Build and confirm**

Run: `npm --workspace apps/web-freelottery run build`
Expected: PASS — `dist/` regenerated with no TypeScript errors. If the bind modal's imports needed adaptation in Step 4.2 and there are residual type errors, fix them now (they will be specific to whichever fields the gladiator modal references).

- [ ] **Step 4.7: Manual click-through (no commit gate — just a smoke check before pushing)**

If you have a running dev server, point your browser at `http://localhost:5177/enter` and confirm the page renders without console errors. The actual entry flow requires a real backend and X account; this slice does not include a staging walk-through (that's slice 5).

- [ ] **Step 4.8: Commit**

```bash
git add apps/web-freelottery/src
git commit -m "feat(freelottery): /enter page + bind modal + api client"
```

---

## Task 5: Final smoke — run the freelottery test suite + full build

This task has no new files; it's a verification gate before declaring Slice 2 done.

- [ ] **Step 5.1: Run all freelottery-tagged tests**

Run: `npm --workspace apps/server test -- freelottery`
Expected: 4 test files green:
- `tests/freelotteryMigration.test.ts` — 5 cases (from slice 1, still pass)
- `tests/freelotterySchedule.test.ts` — 13 cases (from slice 1, still pass)
- `tests/freelotteryRoutes.test.ts` — 6 cases (from slice 1, still pass)
- `tests/freelotteryCodes.test.ts` — Task 1 unit tests
- `tests/freelotteryEntry.test.ts` — Tasks 2+3 integration tests

- [ ] **Step 5.2: Run the full build**

Run: `npm run build`
Expected: server compiles, all 5 web apps build to their `dist/` folders, no errors.

- [ ] **Step 5.3: (No commit — pure verification.)**

If anything fails, stop and resolve before declaring the slice complete.

---

## What slice 2 does NOT do (intentional)

- No draw runner (slice 3).
- No marketing public page UI (slice 4) — the `/` route shows the slice-1 placeholder + an "Enter today's free lottery" CTA only.
- No `GET /api/freelottery/today` or `/winners` — still 501 stubs from slice 1.
- No news entry — added in the rollout slice.
- No allowlist enforcement against `freelotteryAllowedEmails` (the env wire is there from slice 1; we'll switch it on if/when needed before launch). Treat as `'*'` for slice 2.

## Slice 2 acceptance

The slice is done when:

1. All 5 tasks above are committed.
2. `npm --workspace apps/server test -- freelottery` is green across all 5 freelottery test files.
3. `npm run build` succeeds.
4. `POST /api/freelottery/entry/start` against a dev server with `FREELOTTERY_START_UTC_DATE` set to today returns the expected `{ code, tweet_intent_url, expires_at, day_utc }` shape for a logged-in user with an X handle.
5. Stubs (`/today`, `/winners`) still return 501 (they're slice 4 work).
